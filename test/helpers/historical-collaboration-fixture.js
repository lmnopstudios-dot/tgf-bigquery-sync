import {fixture as mappingFixture} from './product-mapping-save-fixture.js';
import {createHistoricalCollaborationService} from '../../oracle/historical-collaboration.js';
export function historicalFixture(){
 const mapping=mappingFixture({count:2}),rows=[],calls=[],inherited=[];
 const state={rows,calls,inherited,overflow:false,failAppend:false,loseAppendAck:false};
 const collections=[{collection_id:'10',title:'Alpha',collaboration_name:'alpha',governance_status:'collaboration',product_count:0},{collection_id:'11',title:'Beta',collaboration_name:'beta',governance_status:'collaboration'},{collection_id:'12',title:'Collaborations',collaboration_name:'collaborations',governance_status:'collaboration'},{collection_id:'13',title:'Other',collaboration_name:'other',governance_status:'other'}];
 const active=ref=>{const history=rows.filter(r=>r.subject_ref===ref),superseded=new Set(history.map(r=>r.supersedes_classification_id));return history.filter(r=>!superseded.has(r.classification_id)&&['active','conflict'].includes(r.status)&&['product_group','collaboration_name'].includes(r.classification_type));};
 const bigquery={query:async q=>{calls.push(q);
  if(q.labels?.operation==='read_classifications'){
   if(state.overflow)return [Array.from({length:1001},()=>({}))];
   const output=[];for(const ref of q.params.refs){for(const r of rows.filter(r=>r.subject_ref===ref&&['product_group','collaboration_name'].includes(r.classification_type)))output.push({row_kind:'history',record_json:JSON.stringify(r)});
    const evidence=[...active(ref).map(r=>({...r,mapping_type:'direct'})),...inherited.filter(r=>r.subject_ref===ref)];for(const r of evidence)output.push({row_kind:'evidence',record_json:JSON.stringify(r)});
    const names=new Set(evidence.filter(r=>r.classification_type==='collaboration_name').map(r=>r.classification_value));if(names.size>1||evidence.some(r=>r.status==='conflict'))output.push({row_kind:'conflicts',record_json:JSON.stringify({subject_ref:ref,classification_type:'collaboration_name'})});
   }return [output];
  }
  if(q.labels?.operation==='append_classifications'){
   if(state.failAppend)throw Error('Warehouse append failed');
   const incoming=JSON.parse(q.params.payload);for(const row of incoming)if(!rows.some(r=>r.classification_id===row.classification_id))rows.push(structuredClone(row));
   if(state.loseAppendAck){state.loseAppendAck=false;throw Error('Warehouse acknowledgement interrupted');}
   return [[]];
  }
  if(q.labels?.operation==='load_existing')return [rows];
  if(['ensure_classifications','ensure_table'].includes(q.labels?.operation))return [[]];
  throw Error('Unexpected classification warehouse statement: '+q.labels?.operation);
 }};
 const service=createHistoricalCollaborationService({bigquery,project:'fixture',productMappingService:mapping.service,collectionClassificationService:{list:async()=>({collections})}});
 return {service,state,mapping,collections,bigquery,active};
}
