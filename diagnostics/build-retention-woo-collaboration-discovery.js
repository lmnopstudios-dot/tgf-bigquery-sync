import {writeFileSync} from 'node:fs';
import {gzipSync} from 'node:zlib';
import {wooCollaborationDiscoverySettings} from './retention-woo-collaboration-discovery.js';
import {collaborationDiscoveryReview} from './retention-woo-collaboration-review.js';
writeFileSync(new URL('./retention-woo-collaboration-discovery.json.gz',import.meta.url),gzipSync(JSON.stringify({project:'gf-full-data',settings:['ww','usd'].map(store=>({store,...wooCollaborationDiscoverySettings('gf-full-data',store)})),review_source:'export '+collaborationDiscoveryReview.toString()}),{mtime:0}));
