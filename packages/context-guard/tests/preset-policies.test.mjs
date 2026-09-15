import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../lib/index.js';

const base = { economyTokens: 65536, checkpointTokens: 81920, compactTokens: 94371 };
const reserve9b = { maxTurnMs: null, compactTokens: 91750, contextWindow: 131072, summaryMaxTokens: 8192, summaryMinTokens: 1024, safetyTokens: 4096, responseMaxTokens: 24576 };
const overrides = { maxTurnMs: null, economyTokens: 32000, checkpointTokens: 40000, compactTokens: 44800, resultFingerprintChars: 3906, contextWindow: 64000, summaryMaxTokens: 4000, summaryMinTokens: 500, safetyTokens: 2000, responseMaxTokens: 12000 };
function harness(t, extra = {}, checkpointImpl) {
  const events = new Map(); const pressure = new Map(); const compactions = [];
  const service = { composedPreset: ctx => ctx.preset,
    serviceFor: agent => ({ compactNow: async () => { throw Error('checkpointNow required'); }, checkpointNow: async (_, signal, budget) => { compactions.push(agent.ctx.preset); assert.equal(budget.contextWindow, agent.ctx.preset.endsWith('27b') ? 64000 : 131072); return {}; } }) };
  if (checkpointImpl) service.serviceFor = agent => ({ compactNow: async () => { throw Error('checkpointNow required'); }, checkpointNow: (...args) => checkpointImpl(agent, ...args) });
  let guard;
  const ctx = { tools: { guard(fn) { guard = fn; } }, get: () => service,
    tokenMeter: { measure: session => ({ totalTokens: pressure.get(session.id) ?? 0 }) },
    compaction: { compactNow: () => { throw Error('global compactor must not handle preset'); } },
    on: (event, cb) => events.set(event, cb) };
  apply(ctx, { ...base, presetPolicies: { 'local-robust-9b': { ...reserve9b, ...extra }, 'local-robust-27b': { ...overrides, ...extra } } });
  const agents = [];
  t.after(() => agents.forEach(agent => events.get('agent/disposed')({ agent })));
  function agent(preset) {
    const cancelled = []; const steered = [];
    const a = { id: preset, ctx: { preset }, session: { id: preset, append() {} }, status: 'running',
      cancel: reason => cancelled.push(reason), steer: message => steered.push(message), cancelled, steered };
    agents.push(a); return a;
  }
  async function step(a, tokens, turn = 1) {
    pressure.set(a.id, tokens);
    return events.get('agent/pre-step')({ agent: a, turn, step: 1,
      messages: turn === 1 ? [{ source: { kind: 'user' } }] : [], signal: new AbortController().signal },
    async () => ({ messages: [] }));
  }
  return { agent, step, pressure, events, compactions, guard: exec => guard(exec) };
}

const unlimited = { maxTurnSteps: null, maxTurnToolCalls: null };
test('unlimited presets remain isolated from the default 48-call policy', async t => {
  const h = harness(t, unlimited);
  for (const preset of ['local-robust-9b', 'local-robust-27b', 'unrelated']) {
    const a = h.agent(preset); await h.step(a, 0);
    let denied;
    for (let i = 0; i < 1000; i++) {
      const exec = { agent: a, name: 'edit', arguments: { path: `file-${i}.js` } };
      denied = h.guard(exec);
      if (denied) break;
      await h.events.get('tools/post-execute')(exec, { value: `updated ${i}` }, async () => undefined);
    }
    if (preset === 'unrelated') assert.match(a.cancelled[0].reason, /48/);
    else { assert.equal(denied, undefined); assert.equal(a.cancelled.length, 0); }
  }
});

test('both unlimited presets survive repeated real guard compaction cycles', async t => {
  const h = harness(t, unlimited);
  for (const preset of ['local-robust-9b', 'local-robust-27b']) {
    const a = h.agent(preset); await h.step(a, 0);
    for (let i = 0; i < 60; i++) {
      a.status = 'running';
      assert.equal((await h.step(a, preset.endsWith('27b') ? 44800 : 91750, i * 2 + 2)).kind, 'reject');
      a.status = 'idle'; h.events.get('agent/status')({ agent: a, status: 'idle' });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(a.steered.length, i + 1);
      a.status = 'running';
      assert.notEqual((await h.step(a, 1000, i * 2 + 3)).kind, 'reject');
    }
    assert.ok(a.cancelled.every(reason => reason.kind === 'context-guard-compaction'));
  }
  assert.equal(h.compactions.length, 120);
});

test('failed checkpoint never resumes unlimited execution', async t => {
  const h = harness(t, unlimited, async () => { throw Error('disk unavailable'); });
  const a = h.agent('local-robust-27b'); await h.step(a, 44800);
  a.status = 'idle'; h.events.get('agent/status')({ agent: a, status: 'idle' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(a.steered.length, 0);
  assert.match((await h.step(a, 1000, 2)).reason, /disk unavailable/);
});

test('disposing during checkpoint cancels it and suppresses automatic resume', async t => {
  let release, signal;
  const h = harness(t, unlimited, async (_, agent, s) => {
    signal = s; await new Promise(resolve => { release = resolve; }); return {};
  });
  const a = h.agent('local-robust-27b'); await h.step(a, 44800);
  a.status = 'idle'; h.events.get('agent/status')({ agent: a, status: 'idle' });
  h.events.get('agent/disposed')({ agent: a });
  assert.equal(signal.aborted, true);
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(a.steered.length, 0);
});

test('explicit finite step ceiling still stops at its boundary', async t => {
  const h = harness(t, { maxTurnToolCalls: null, maxTurnSteps: 3 });
  const a = h.agent('local-robust-27b');
  for (let turn = 1; turn <= 3; turn++) assert.notEqual((await h.step(a, 0, turn)).kind, 'reject');
  assert.match((await h.step(a, 0, 4)).reason, /3 steps/);
});

test('null ceilings are explicit; invalid numeric values are rejected', () => {
  for (const key of ['maxTurnSteps', 'maxTurnToolCalls']) {
    for (const value of [0, -1, 1.5, 'null', false, Infinity, NaN]) {
      assert.throws(() => apply({}, { [key]: value }), /positive integer/);
    }
  }
});

test('9B and 27B in the same guard receive different economy/checkpoint thresholds', async t => {
  const h = harness(t); const small = h.agent('local-robust-9b'); const large = h.agent('local-robust-27b');
  assert.equal((await h.step(small, 32000)).messages.length, 0);
  assert.match((await h.step(large, 32000)).messages[0].source.summary, /economy/);
  assert.match((await h.step(large, 40000)).messages[0].source.summary, /checkpoint/);
  assert.equal((await h.step(small, 46080)).messages.length, 0);
  assert.match((await h.step(small, 65536)).messages[0].source.summary, /economy/);
  assert.match((await h.step(small, 81920)).messages[0].source.summary, /checkpoint/);
});

test('27B checkpoints at 44800 through its own compactor while 9B stays active', async t => {
  const h = harness(t); const small = h.agent('local-robust-9b'); const large = h.agent('local-robust-27b');
  await h.step(small, 44800); await h.step(large, 44800);
  for (const a of [small, large]) h.events.get('session/event')(a.session, { type: 'tool/result' });
  assert.equal(small.cancelled.length, 0);
  assert.equal(large.cancelled[0].kind, 'context-guard-compaction');
  large.status = 'idle'; h.events.get('agent/status')({ agent: large, status: 'idle' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.compactions, ['local-robust-27b']);
  assert.equal(large.steered.length, 1);
  h.pressure.set(small.id, 91750); h.events.get('session/event')(small.session, { type: 'tool/result' });
  assert.equal(small.cancelled[0].kind, 'context-guard-compaction');
});

test('unknown presets preserve the prior default and malformed overrides fail closed', async t => {
  const h = harness(t); const other = h.agent('unrelated');
  assert.equal((await h.step(other, 40000)).messages.length, 0);
  assert.throws(() => apply({}, { ...base, presetPolicies: { bad: { compactTokens: 1 } } }), /economyTokens/);
  assert.throws(() => apply({}, { ...base, presetPolicies: { bad: { misspelled: 1 } } }), /unknown configuration/);
  assert.throws(() => apply({}, { ...base, ...overrides, compactTokens: 46000 }), /reserves/);
  assert.throws(() => apply({}, { ...base, contextWindow: 64000 }), /reserves/);
});

test('normal output caps reserve space for either model checkpoint', async t => {
  const h = harness(t);
  for (const [preset, cap] of [['local-robust-9b', 24576], ['local-robust-27b', 12000]]) {
    const a = h.agent(preset);
    assert.equal((await h.events.get('agent/request')({ agent: a }, async () => ({ maxTokens: 99999 }))).maxTokens, cap);
  }
});

test('newly committed input triggers checkpoint before normal model dispatch', async t => {
  const h = harness(t); const a = h.agent('local-robust-27b'); await h.step(a, 1000);
  h.pressure.set(a.id, 44800); h.events.get('session/event')(a.session, { type: 'user/message' });
  assert.equal(a.cancelled.length, 1);
  assert.equal((await h.step(a, 44800, 2)).kind, 'reject');
  assert.equal(h.compactions.length, 0);
});


test('robust presets survive one hour; another preset retains the existing 15-minute deadline', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000000 });
  const h = harness(t);
  const small = h.agent('local-robust-9b'); const large = h.agent('local-robust-27b'); const other = h.agent('other');
  for (const a of [small, large, other]) await h.step(a, 1000);
  t.mock.timers.tick(3600000);
  for (const a of [small, large]) {
    assert.equal(a.cancelled.length, 0);
    assert.notEqual((await h.step(a, 1000, 2)).kind, 'reject');
  }
  assert.match(other.cancelled[0].reason, /total time budget of 900000ms/);
  assert.equal((await h.step(other, 1000, 2)).kind, 'reject');
});

test('disabling the turn deadline does not disable the diagnostic timeout', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000000 });
  const h = harness(t); const a = h.agent('local-robust-27b'); await h.step(a, 1000);
  await h.events.get('tools/post-execute')({ agent: a, name: 'bash', arguments: { command: 'slow' } },
    { isError: true, value: { timedOut: true, exitCode: 124 } }, async () => undefined);
  t.mock.timers.tick(120001);
  assert.match(a.cancelled[0].reason, /diagnostic mode exceeded its reduced time budget/);
});
