// Offline load test: exercises the real plugin entry point with a mock cordis
// context, so a broken registration is caught without launching DSH.
import { apply, name, inject } from '../lib/index.js';

const registered = [];
const effects = [];
const logs = [];

const ctx = {
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
  tools: {
    register(tool) {
      if (!tool || typeof tool.name !== 'string') throw new Error('tool without a name was registered');
      if (registered.some((t) => t.name === tool.name)) throw new Error(`duplicate tool name: ${tool.name}`);
      registered.push(tool);
      return () => {};
    },
  },
  attachments: {
    async saveImage() {
      return { id: 'mock-image' };
    },
  },
};

let failures = 0;
function check(label, ok, detail = '') {
  if (ok) {
    console.log(`PASS  ${label}`);
  } else {
    failures += 1;
    console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

check('module exposes a name', typeof name === 'string' && name.length > 0);
check('module declares inject', Array.isArray(inject) && inject.includes('tools'), JSON.stringify(inject));

apply(ctx, {});

check('10 tools registered', registered.length === 10, `got ${registered.length}: ${registered.map((t) => t.name).join(', ')}`);
check('every tool has parameters', registered.every((t) => t.parameters && typeof t.parameters === 'object'));
check('every tool has execute', registered.every((t) => typeof t.execute === 'function'));
check('every tool has a description', registered.every((t) => typeof t.description === 'string' && t.description.length > 10));
check('effects registered', effects.length >= 2, effects.join(' | '));

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

// disabled switch must be a hard cut: no tools at all
let disabledTools = 0;
const probeCtx = {
  ...ctx,
  effect: () => () => {},
  tools: { register() { disabledTools += 1; return () => {}; } },
};
apply(probeCtx, { enabled: false });
check('enabled:false registers nothing', disabledTools === 0, `got ${disabledTools}`);

console.log('\n--- logs ---');
for (const [level, message] of logs) console.log(`[${level}] ${message}`);

if (failures > 0) {
  console.log(`\nRESULT: FAIL (${failures})`);
  process.exit(1);
}
console.log('\nRESULT: PASS');
