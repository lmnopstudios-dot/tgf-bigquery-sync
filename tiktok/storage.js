import {randomUUID} from 'node:crypto';
import {datasetLocation,assertDatasetIdentifier} from '../bigquery/dataset-location.js';
export const DATASET='tiktok_organic';
const schema='evidence_id STRING,account_id STRING,resource_id STRING,metric STRING,unit STRING,evidence_kind STRING,availability STRING,value FLOAT64,native_json STRING,publication_native STRING,permalink STRING,requested_start STRING,requested_end STRING,applied_start STRING,applied_end STRING,reporting_timezone STRING,timezone_evidence STRING,api_version STRING,endpoint STRING,request_id STRING,retrieved_at STRING,run_id STRING';
export class TikTokStore {
  constructor({bigquery,project}){assertDatasetIdentifier(project);Object.assign(this,{bigquery,project});this.owner=randomUUID();}
  async ensure(){
    // Existing production dataset is the creation location, never a guessed US default.
    const fallback=await datasetLocation(this.bigquery,this.project,'meta');
    this.location=await datasetLocation(this.bigquery,this.project,DATASET,{fallback});
    await this.query(`CREATE SCHEMA IF NOT EXISTS \`${this.project}.${DATASET}\` OPTIONS(location='${this.location}'); CREATE TABLE IF NOT EXISTS \`${this.project}.${DATASET}.observations\` (${schema}) CLUSTER BY account_id,metric; CREATE TABLE IF NOT EXISTS \`${this.project}.${DATASET}.checkpoints\` (account_id STRING,import_id STRING,grain STRING,state_json STRING,updated_at TIMESTAMP); CREATE TABLE IF NOT EXISTS \`${this.project}.${DATASET}.collector_lock\` AS SELECT CAST(NULL AS STRING) owner,TIMESTAMP '1970-01-01 00:00:00+00' lease_until;`);
  }
  async query(query,params={},types={}){return this.bigquery.query({query,params,types,location:this.location,useLegacySql:false,maximumBytesBilled:1_000_000_000});}
  async lock(){await this.query(`BEGIN TRANSACTION; UPDATE \`${this.project}.${DATASET}.collector_lock\` SET owner=@owner,lease_until=TIMESTAMP_ADD(CURRENT_TIMESTAMP(),INTERVAL 6 HOUR) WHERE owner IS NULL OR lease_until<CURRENT_TIMESTAMP(); ASSERT @@row_count=1 AS 'TikTok collector already running'; COMMIT TRANSACTION;`,{owner:this.owner},{owner:'STRING'});}
  async release(){await this.query(`UPDATE \`${this.project}.${DATASET}.collector_lock\` SET owner=NULL,lease_until=TIMESTAMP '1970-01-01 00:00:00+00' WHERE owner=@owner`,{owner:this.owner},{owner:'STRING'});}
  async checkpoint(accountId,importId,grain){const [rows]=await this.query(`SELECT state_json FROM \`${this.project}.${DATASET}.checkpoints\` WHERE account_id=@account AND import_id=@id AND grain=@grain`,{account:accountId,id:importId,grain},{account:'STRING',id:'STRING',grain:'STRING'});return rows[0]?JSON.parse(rows[0].state_json):null;}
  async save(accountId,importId,grain,state,rows=[]){
    const columns=schema.split(',').map(x=>x.trim().split(' ')[0]);
    const select=columns.map(c=>`${c==='value'?'SAFE_CAST(JSON_VALUE(j,\'$.value\') AS FLOAT64)':`JSON_VALUE(j,'$.${c}')`} AS ${c}`).join(',');
    await this.query(`BEGIN TRANSACTION; ASSERT EXISTS(SELECT 1 FROM \`${this.project}.${DATASET}.collector_lock\` WHERE owner=@owner AND lease_until>CURRENT_TIMESTAMP()) AS 'Collector lease lost'; MERGE \`${this.project}.${DATASET}.observations\` t USING (SELECT ${select} FROM UNNEST(@rows) j QUALIFY ROW_NUMBER() OVER(PARTITION BY JSON_VALUE(j,'$.evidence_id'))=1) s ON t.evidence_id=s.evidence_id WHEN NOT MATCHED THEN INSERT (${columns.join(',')}) VALUES (${columns.map(c=>'s.'+c).join(',')}); MERGE \`${this.project}.${DATASET}.checkpoints\` t USING (SELECT @account account_id,@id import_id,@grain grain) s ON t.account_id=s.account_id AND t.import_id=s.import_id AND t.grain=s.grain WHEN MATCHED THEN UPDATE SET state_json=@state,updated_at=CURRENT_TIMESTAMP() WHEN NOT MATCHED THEN INSERT VALUES(@account,@id,@grain,@state,CURRENT_TIMESTAMP()); COMMIT TRANSACTION;`,{owner:this.owner,account:accountId,id:importId,grain,state:JSON.stringify(state),rows:rows.map(r=>JSON.stringify(r))},{owner:'STRING',account:'STRING',id:'STRING',grain:'STRING',state:'STRING',rows:['STRING']});
  }
}
