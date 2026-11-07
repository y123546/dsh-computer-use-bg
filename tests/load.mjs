// Offline load test: exercises the real plugin entry point with a mock cordis
// context, so a broken registration is caught without launching DSH.
//
// The context below is deliberately STRICT. DSH's ctx is a getter that throws when
// you read a service you did not declare in `inject`, so a mock that happily returns
// undefined hides exactly the bug that keeps a plugin from booting.
import { apply, name, inject } from '../lib/index.js';
import { assertSupportedJsonSchema, validate as validateJsonSchemaValue } from './schema.mjs';

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

// The two host validators live in tests/schema.mjs so tools.mjs can reuse them.

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

check('13 tools registered', registered.length === 13, `got ${registered.length}: ${registered.map((t) => t.name).join(', ')}`);
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
  'browser_wait',
  'browser_nav',
  'browser_upload',
  'browser_close',
];
const got = registered.map((t) => t.name);
check('expected tool set', expected.every((n) => got.includes(n)), got.join(', '));

// A host without the attachment service must still load cleanly.
const bareSink = [];
try {
  apply(makeCtx({ withAttachments: false, sink: bareSink }), {});
  check('loads on a host without attachments', bareSink.length === 13, `got ${bareSink.length} tools`);
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
