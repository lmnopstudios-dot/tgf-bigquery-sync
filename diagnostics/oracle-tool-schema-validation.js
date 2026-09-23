import { createOracleToolDefinitions } from '../oracle/tool-registry.js';
import { assertOracleToolSchemas } from '../oracle/tool-schema-validator.js';

const tools = createOracleToolDefinitions();
assertOracleToolSchemas(tools);
const strictCount = tools.filter(tool => tool.strict === true).length;
console.log(`Validated ${strictCount} strict schemas across ${tools.length} registered Oracle tools.`);
