import {readFileSync,writeFileSync} from 'node:fs';
import {gzipSync} from 'node:zlib';
import {uiRouteReconciliationSql,exactWooSubjects} from './retention-ui-route-reconciliation.js';
const artifact={project:'gf-full-data',subjects:exactWooSubjects,runner_source:readFileSync(new URL('./read-retention-ui-routes.js',import.meta.url),'utf8'),query_builder_source:readFileSync(new URL('./retention-ui-route-reconciliation.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,''),candidate_query:uiRouteReconciliationSql('gf-full-data')};
writeFileSync(new URL('./retention-ui-route-reconciliation.json.gz',import.meta.url),gzipSync(JSON.stringify(artifact),{mtime:0}));
