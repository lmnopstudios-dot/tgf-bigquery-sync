import {writeFileSync} from 'node:fs';
import {gzipSync} from 'node:zlib';
import {mappingCoverageArtifact,evidenceReaderSource} from './retention-mapping-coverage-evidence.js';
const artifact={...mappingCoverageArtifact('gf-full-data'),runner_source:evidenceReaderSource()};
writeFileSync(new URL('./retention-mapping-coverage.json.gz',import.meta.url),gzipSync(JSON.stringify(artifact),{mtime:0}));
