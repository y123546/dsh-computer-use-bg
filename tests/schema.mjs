/**
 * The two schema rules DSH applies to every tool, ported for offline use.
 *
 *  - assertSupportedJsonSchema: the JSON-Schema subset accepted at register time.
 *    Anything outside it makes the whole plugin fail to load, and the Plugins page
 *    only ever shows a bare "异常".
 *  - validate: the same schema checked against a tool's real return value. The host
 *    runs this on every successful call (pipeline.js), so a schema that is stricter
 *    than the value throws ToolOutputError at call time.
 *
 * Both mirror `@deepseek-ai/dsh-tools/lib/shared-*.js`; tests/load.mjs and
 * tests/tools.mjs share them so a regression fails locally instead of inside DSH.
 */

const CONSTRAINT_KEYWORDS = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const']);
const ANNOTATION_KEYWORDS = new Set(['description', 'title', 'default', 'examples']);
const SCHEMA_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'];
const ONE_OF_SIBLINGS = ['properties', 'required', 'additionalProperties', 'items', 'enum', 'const'];
const KEYWORD_TYPES = {
  properties: ['object'],
  required: ['object'],
  additionalProperties: ['object'],
  items: ['array'],
  enum: ['string', 'number', 'integer', 'boolean', 'null'],
  const: ['string', 'number', 'integer', 'boolean', 'null'],
};

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export function assertSupportedJsonSchema(schema, path = 'schema', violations = []) {
  if (!isRecord(schema)) {
    violations.push(`${path} must be a schema object`);
    return violations;
  }
  for (const key of Object.keys(schema)) {
    if (CONSTRAINT_KEYWORDS.has(key) || ANNOTATION_KEYWORDS.has(key)) continue;
    violations.push(`${path}.${key} is not a supported keyword`);
  }
  const hasType = Object.hasOwn(schema, 'type');
  const hasOneOf = Object.hasOwn(schema, 'oneOf');
  if (hasType && hasOneOf) {
    violations.push(`${path} cannot declare both type and oneOf`);
    return violations;
  }
  if (hasOneOf) {
    if (!Array.isArray(schema.oneOf) || schema.oneOf.length < 2) violations.push(`${path}.oneOf must be an array of at least two schemas`);
    else schema.oneOf.forEach((branch, i) => assertSupportedJsonSchema(branch, `${path}.oneOf[${i}]`, violations));
    for (const key of ONE_OF_SIBLINGS) if (Object.hasOwn(schema, key)) violations.push(`${path}.${key} is not supported beside oneOf`);
    return violations;
  }
  if (!hasType) {
    for (const key of ONE_OF_SIBLINGS) if (Object.hasOwn(schema, key)) violations.push(`${path}.${key} requires type or oneOf`);
    return violations;
  }
  if (typeof schema.type !== 'string' || !SCHEMA_TYPES.includes(schema.type)) {
    violations.push(`${path}.type must be one of ${SCHEMA_TYPES.join('/')}`);
    return violations;
  }
  const schemaType = schema.type;
  for (const [key, types] of Object.entries(KEYWORD_TYPES)) {
    if (Object.hasOwn(schema, key) && !types.includes(schemaType)) violations.push(`${path}.${key} is not supported on type "${schemaType}"`);
  }
  if (schemaType === 'object') {
    const properties = Object.hasOwn(schema, 'properties') ? schema.properties : undefined;
    if (Object.hasOwn(schema, 'properties') && !isRecord(properties)) violations.push(`${path}.properties must be an object of schemas`);
    else if (properties) for (const [key, sub] of Object.entries(properties)) assertSupportedJsonSchema(sub, `${path}.properties.${key}`, violations);

    if (Object.hasOwn(schema, 'required')) {
      if (!Array.isArray(schema.required) || schema.required.some((entry) => typeof entry !== 'string')) {
        violations.push(`${path}.required must be an array of strings`);
      } else {
        for (const key of schema.required) {
          if (!Object.hasOwn(properties ?? {}, key)) violations.push(`${path}.required names "${key}" which is not in properties`);
        }
      }
    }
    if (Object.hasOwn(schema, 'additionalProperties') && typeof schema.additionalProperties !== 'boolean') {
      violations.push(`${path}.additionalProperties must be a boolean`);
    }
  }
  if (schemaType === 'array' && Object.hasOwn(schema, 'items')) assertSupportedJsonSchema(schema.items, `${path}.items`, violations);
  return violations;
}

export function validate(schema, value, path = 'value', out = []) {
  if (schema.oneOf !== undefined) {
    const matches = schema.oneOf.filter((branch) => validate(branch, value, path, []).length === 0).length;
    if (matches !== 1) out.push(`"${path}" must match exactly one oneOf branch (matched ${matches})`);
    return out;
  }
  switch (schema.type) {
    case undefined:
      return out;
    case 'object': {
      if (!isRecord(value)) {
        out.push(`"${path}" must be an object`);
        return out;
      }
      const properties = schema.properties ?? {};
      for (const key of schema.required ?? []) {
        if (!Object.hasOwn(value, key) || value[key] === undefined) out.push(`missing required property "${path}.${key}"`);
      }
      for (const [key, sub] of Object.entries(properties)) {
        if (Object.hasOwn(value, key) && value[key] !== undefined) validate(sub, value[key], `${path}.${key}`, out);
      }
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(value)) if (!Object.hasOwn(properties, key)) out.push(`"${path}.${key}" is not a declared property (additionalProperties: false)`);
      }
      return out;
    }
    case 'array': {
      if (!Array.isArray(value)) {
        out.push(`"${path}" must be an array`);
        return out;
      }
      if (schema.items !== undefined) value.forEach((entry, i) => validate(schema.items, entry, `${path}[${i}]`, out));
      return out;
    }
    case 'string':
      if (typeof value !== 'string') out.push(`"${path}" must be a string`);
      return out;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) out.push(`"${path}" must be a finite JSON number`);
      return out;
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) out.push(`"${path}" must be an integer`);
      return out;
    case 'boolean':
      if (typeof value !== 'boolean') out.push(`"${path}" must be a boolean`);
      return out;
    case 'null':
      if (value !== null) out.push(`"${path}" must be null`);
      return out;
    default:
      return out;
  }
}
