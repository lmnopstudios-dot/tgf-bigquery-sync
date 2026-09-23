/** Walk the JSON Schema contract required by OpenAI strict function tools. */
export function assertStrictJsonSchema(schema, path = 'parameters') {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new Error(`${path} must be a schema object`);
  if (schema.anyOf) {
    if (!Array.isArray(schema.anyOf) || schema.anyOf.length === 0) throw new Error(`${path}.anyOf must be a non-empty array`);
    schema.anyOf.forEach((branch, index) => assertStrictJsonSchema(branch, `${path}.anyOf[${index}]`));
  }
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.includes('object')) {
    if (!schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties)) throw new Error(`${path}.properties must be an object`);
    if (schema.additionalProperties !== false) throw new Error(`${path}.additionalProperties must be false for a strict object schema`);
    if (!Array.isArray(schema.required)) throw new Error(`${path}.required must be an array including every property`);
    const properties = Object.keys(schema.properties), required = schema.required;
    if (new Set(required).size !== required.length) throw new Error(`${path}.required contains duplicate keys`);
    const missing = properties.filter(key => !required.includes(key));
    const unknown = required.filter(key => !Object.hasOwn(schema.properties, key));
    if (missing.length || unknown.length) throw new Error(`${path}.required must contain every property exactly; missing: ${missing.join(', ') || 'none'}; unknown: ${unknown.join(', ') || 'none'}`);
    for (const [key, child] of Object.entries(schema.properties)) assertStrictJsonSchema(child, `${path}.properties.${key}`);
  }
  if (types.includes('array')) {
    if (!schema.items) throw new Error(`${path}.items is required`);
    assertStrictJsonSchema(schema.items, `${path}.items`);
  }
  return true;
}

/** Validate the exact collection supplied as `tools` to OpenAI Responses. */
export function assertOracleToolSchemas(tools) {
  if (!Array.isArray(tools)) throw new Error('Oracle tools must be an array');
  const names = new Set();
  for (const [index, tool] of tools.entries()) {
    const path = `tools[${index}]`;
    if (tool?.type !== 'function' || typeof tool.name !== 'string' || !tool.parameters) throw new Error(`${path} must be a named function with parameters`);
    if (names.has(tool.name)) throw new Error(`${path}.name duplicates ${tool.name}`);
    names.add(tool.name);
    if (tool.strict === true) assertStrictJsonSchema(tool.parameters, `${path}.parameters (${tool.name})`);
  }
  return true;
}
