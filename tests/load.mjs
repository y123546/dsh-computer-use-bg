// Offline load test: exercises the real plugin entry point with a mock cordis
// context, so a broken registration is caught without launching DSH.
//
// The context below is deliberately STRICT. DSH's ctx is a getter that throws when
// you read a service you did not declare in `inject`, so a mock that happily returns
// undefined hides exactly the bug that keeps a plugin from booting.
import { apply, name, inject } from '../lib/index.js';

const CORE_SERVICES = new Set(['logger', 'effect', 'tools']);
const OPTIONAL_SERVICES = new Set(['attachments']);

const registered = [];
const effects = [];
const logs = [];

let failures = 0;
function check(label, ok, detail = '') {
  if (ok) {
    console.log(`PASS  ${label}`);
  } else {
    failures += 1;
    console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

// --- host schema rules, ported from @deepseek-ai/dsh-tools -------------------
// assertSupportedJsonSchema: the subset the host accepts at register time.
// validateJsonSchemaValue: the same schema checked against what a tool returns.
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

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function assertSupportedJsonSchema(schema, path = 'schema', violations = []) {
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

function validateJsonSchemaValue(schema, value, path = 'value', out = []) {
  if (schema.oneOf !== undefined) {
    const matches = schema.oneOf.filter((branch) => validateJsonSchemaValue(branch, value, path, []).length === 0).length;
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
        if (Object.hasOwn(value, key) && value[key] !== undefined) validateJsonSchemaValue(sub, value[key], `${path}.${key}`, out);
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
      if (schema.items !== undefined) value.forEach((entry, i) => validateJsonSchemaValue(schema.items, entry, `${path}[${i}]`, out));
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

function toolRegistry(sink = registered) {
  return {
    register(tool) {
      if (!tool || typeof tool.name !== 'string') throw new Error('tool without a name was registered');
      if (sink.some((t) => t.name === tool.name)) throw new Error(`duplicate tool name: ${tool.name}`);

      // Verbatim from DSH's @deepseek-ai/dsh-tools ToolService.register: a missing or
      // malformed `output` throws, and the host marks the whole plugin as failed.
      const output = tool.output;
      if (
        output === undefined ||
        typeof output !== 'object' ||
        typeof output.render !== 'function' ||
        (output.presentationMeta !== undefined && typeof output.presentationMeta !== 'function')
      ) {
        throw new TypeError(`tool "${tool.name}" must declare output { schema, render, presentationMeta? }`);
      }
      if (!output.schema || typeof output.schema !== 'object') {
        throw new TypeError(`tool "${tool.name}" output.schema must be an object`);
      }
      // Second host check, and the one that cost a whole debugging session: the schema
      // is raw JSON Schema run through `assertSupportedJsonSchema`, which knows only
      // type/oneOf/properties/required/additionalProperties/items/enum/const plus
      // annotations. `required: true` inside a property (the parameter-DSL spelling)
      // is rejected and the plugin shows up as "异常" with no visible reason.
      const schemaViolations = assertSupportedJsonSchema(output.schema);
      if (schemaViolations.length > 0) {
        throw new TypeError(`tool "${tool.name}" has an unsupported output.schema: ${schemaViolations.join('; ')}`);
      }
      if (tool.timeoutMs !== undefined && (!Number.isFinite(tool.timeoutMs) || tool.timeoutMs <= 0)) {
        throw new TypeError(`tool "${tool.name}" timeoutMs must be a positive finite number`);
      }

      sink.push(tool);
      return () => {};
    },
  };
}

/**
 * A ctx that behaves like DSH's: core + injected services work, an undeclared
 * service throws on direct property access, and `get(name, false)` is the only way
 * to look one up softly. `withAttachments` simulates a host that provides it.
 */
function makeCtx({ withAttachments = false, sink = registered } = {}) {
  const declared = new Set(inject);
  const services = {
    logger: {
      info: (m) => logs.push(['info', m]),
      warn: (m) => logs.push(['warn', m]),
      error: (m) => logs.push(['error', m]),
    },
    effect(fn, label) {
      effects.push(label);
      const dispose = fn();
      return () => (typeof dispose === 'function' ? dispose() : undefined);
    },
    tools: toolRegistry(sink),
  };
  if (withAttachments) {
    services.attachments = { async saveImage() { return { id: 'mock-image' }; } };
  }

  const reachable = (name) => CORE_SERVICES.has(name) || declared.has(name) || OPTIONAL_SERVICES.has(name);

  return new Proxy(services, {
    get(target, prop) {
      if (typeof prop === 'symbol') return target[prop];
      if (prop === 'get') {
        return (name, force = true) => {
          if (name in services && reachable(name)) return services[name];
          if (force) throw new Error(`service "${String(name)}" is not available`);
          return undefined;
        };
      }
      if (prop in target) return target[prop];
      throw new Error(`ctx.${String(prop)} is not available: not declared in inject [${inject.join(', ')}]`);
    },
    has() {
      return true;
    },
  });
}

check('module exposes a name', typeof name === 'string' && name.length > 0);
check('module declares inject', Array.isArray(inject) && inject.includes('tools'), JSON.stringify(inject));

// The regression that mattered: `attachments` in inject keeps the plugin from ever
// booting on hosts that do not expose it, and the Plugins page then shows "broken".
check(
  'declares both host services it reads',
  inject.includes('tools') && inject.includes('attachments'),
  `inject = ${JSON.stringify(inject)}`,
);

apply(makeCtx({ withAttachments: true }), {});

check('10 tools registered', registered.length === 10, `got ${registered.length}: ${registered.map((t) => t.name).join(', ')}`);
check('every tool has parameters', registered.every((t) => t.parameters && typeof t.parameters === 'object'));
check('every tool has execute', registered.every((t) => typeof t.execute === 'function'));
check('every tool has a description', registered.every((t) => typeof t.description === 'string' && t.description.length > 10));
check('every tool declares output.schema', registered.every((t) => t.output?.schema && typeof t.output.schema === 'object'));
check('every tool declares output.render', registered.every((t) => typeof t.output?.render === 'function'));
check('effects registered', effects.length >= 2, effects.join(' | '));

// render() must produce the content blocks DSH feeds to the model.
const sample = registered.find((t) => t.name === 'browser_open');
const textOnly = sample.output.render({}, { text: 'hello' });
check(
  'render returns a text block',
  Array.isArray(textOnly) && textOnly.length === 1 && textOnly[0].type === 'text' && textOnly[0].text === 'hello',
  JSON.stringify(textOnly),
);
const attachment = { attachmentId: 'sha256:abc', mediaType: 'image/png', bytes: 10, width: 2, height: 3, name: 'browser.png', originalDimensions: { width: 2, height: 3 } };
const withImage = sample.output.render({}, { text: 'shot', image: attachment });
check(
  'render returns text then image',
  Array.isArray(withImage) &&
    withImage.length === 2 &&
    withImage[1].type === 'image' &&
    withImage[1].attachment === attachment,
  JSON.stringify(withImage),
);

// The host re-validates what a tool returns against output.schema, so the samples
// above must pass that schema — a mismatch only surfaces at call time in DSH.
const textViolations = validateJsonSchemaValue(sample.output.schema, { text: 'hello' });
check('text output passes its own schema', textViolations.length === 0, textViolations.join('; '));
const full = { text: 'shot', image: attachment };
const fullViolations = validateJsonSchemaValue(sample.output.schema, full);
check('text+image output passes its own schema', fullViolations.length === 0, fullViolations.join('; '));

// And the guard has to actually bite: the parameter-DSL spelling must be rejected,
// because that is exactly the shape that made the plugin show up as 异常.
const dslSpelling = {
  type: 'object',
  additionalProperties: false,
  properties: { text: { type: 'string', required: true } },
};
const dslViolations = assertSupportedJsonSchema(dslSpelling);
check(
  'rejects required:true inside a property',
  dslViolations.some((v) => v.includes('.properties.text.required')),
  dslViolations.join('; ') || 'no violation reported',
);

const expected = [
  'computer_use_doctor',
  'browser_open',
  'browser_snapshot',
  'browser_click',
  'browser_type',
  'browser_key',
  'browser_scroll',
  'browser_text',
  'browser_eval',
  'browser_close',
];
const got = registered.map((t) => t.name);
check('expected tool set', expected.every((n) => got.includes(n)), got.join(', '));

// A host without the attachment service must still load cleanly.
const bareSink = [];
try {
  apply(makeCtx({ withAttachments: false, sink: bareSink }), {});
  check('loads on a host without attachments', bareSink.length === 10, `got ${bareSink.length} tools`);
} catch (error) {
  check('loads on a host without attachments', false, error.message);
}

// disabled switch must be a hard cut: no tools at all
const beforeDisabled = registered.length;
apply(makeCtx({ withAttachments: true }), { enabled: false });
check(
  'enabled:false registers nothing',
  registered.length === beforeDisabled,
  `got ${registered.length - beforeDisabled} new tools`,
);

console.log('\n--- logs ---');
for (const [level, message] of logs) console.log(`[${level}] ${message}`);

if (failures > 0) {
  console.log(`\nRESULT: FAIL (${failures})`);
  process.exit(1);
}
console.log('\nRESULT: PASS');
