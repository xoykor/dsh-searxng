import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../lib/index.js';

const CAPABILITY = Symbol.for('dsh.executor.jobObservation.v1');
const pending = (id = 'bash-1', extra = {}) => ({
  value: { text: '', waitExpired: true, job: { id, status: 'running', startedAt: 100 }, ...extra },
});
const timeout = { value: { exitCode: 124, timedOut: true }, isError: true };

async function harness(t, config = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const events = new Map();
  const definitions = new Map();
  const jobs = new Map([['bash-1', 'running'], ['bash-2', 'running']]);
  const cancellations = [];
  let guard;
  let pressure = 0;
  const controller = new AbortController();
  const agent = { id: 'owner', session: { id: 'session' }, status: 'running',
    cancel: (reason) => { cancellations.push(reason.reason); controller.abort(); } };
  definitions.set('job_output', { [CAPABILITY]: { readOnly: true, observe(exec) {
    const { job_id, wait, timeout_ms } = exec.arguments;
    if (!jobs.has(job_id) || (timeout_ms !== undefined && (!Number.isFinite(timeout_ms) || timeout_ms <= 0))) throw Error('invalid job');
    return { kind: 'output', jobId: job_id, status: jobs.get(job_id), waitMs: wait === true ? Math.min(timeout_ms ?? 30_000, 600_000) : 0 };
  } } });
  definitions.set('job_list', { [CAPABILITY]: { readOnly: true, observe: () => ({ kind: 'list' }) } });
  apply({
    tools: { guard: (fn) => { guard = fn; }, get: (name) => definitions.get(name) },
    tokenMeter: { measure: () => ({ totalTokens: pressure }) },
    on: (event, fn) => events.set(event, fn),
  }, config);
  const preStep = (turn, messages = []) => events.get('agent/pre-step')({ agent, turn, step: 1, messages, signal: controller.signal }, async () => ({ messages }));
  await preStep(1, [{ source: { kind: 'user' } }]);
  t.after(() => events.get('agent/disposed')({ agent }));
  return {
    agent, events, jobs, definitions, cancellations, preStep,
    tick: (ms) => t.mock.timers.tick(ms),
    pressure: (value) => { pressure = value; },
    async call(name, args = {}, result = { value: 'ok' }, elapsed = 0, metadata = {}) {
      const exec = { agent, name, arguments: args, signal: controller.signal, ...metadata };
      const reason = guard(exec);
      if (reason !== undefined) return reason;
      if (elapsed) t.mock.timers.tick(elapsed);
      await events.get('tools/post-execute')(exec, result, async () => undefined);
      return undefined;
    },
    wait(id = 'bash-1', extra = {}, result = pending(id), elapsed = 30_000) {
      return this.call('job_output', { job_id: id, wait: true, timeout_ms: 30_000, ...extra }, result, elapsed);
    },
  };
}

test('eight silent blocking waits remain neutral and waitExpired is not a timeout', async (t) => {
  const h = await harness(t);
  for (let i = 0; i < 8; i++) assert.equal(await h.wait(), undefined);
  assert.equal(h.cancellations.length, 0);
  assert.equal(await h.call('edit', { path: 'x' }), undefined, 'still in normal mode');
});

test('unlimited calls and steps preserve productive work across automatic continuations', async t => {
  const h = await harness(t, { maxTurnToolCalls: null, maxTurnSteps: null, maxTurnMs: null });
  for (let i = 0; i < 120; i++) {
    assert.notEqual((await h.preStep(i + 2, [{ source: { kind: 'plugin', plugin: 'compaction' } }])).kind, 'reject');
    assert.equal(await h.call('edit', { path: `file-${i}.js` }, { value: `updated file ${i}` }), undefined);
  }
  assert.equal(h.cancellations.length, 0);
});

test('unlimited work still blocks unchanged repeated investigation', async t => {
  const h = await harness(t, { maxTurnToolCalls: null, maxTurnSteps: null, maxTurnMs: null });
  const reasons = [];
  for (let i = 0; i < 10; i++) reasons.push(await h.call('read', { file_path: 'same.txt' }, { value: 'unchanged evidence' }));
  assert.ok(reasons.some(Boolean) || h.cancellations.length > 0);
});

test('unlimited work retains the diagnostic budget after a real timeout', async t => {
  const h = await harness(t, { maxTurnToolCalls: null, maxTurnSteps: null, maxTurnMs: null });
  await h.call('bash', { command: 'slow' }, timeout);
  for (let i = 0; i < 4; i++) await h.wait();
  assert.ok(h.cancellations.some(reason => /diagnostic/.test(reason)));
});

test('waits consume the global call allowance', async (t) => {
  const h = await harness(t, { maxTurnToolCalls: 8 });
  for (let i = 0; i < 8; i++) assert.equal(await h.wait(), undefined);
  assert.match(h.cancellations[0], /global tool-call budget of 8/);
  assert.match(await h.wait(), /already closed/);
});

test('waits consume global time and tokens', async (t) => {
  const h = await harness(t, { maxTurnMs: 60_000, maxTurnTokens: 100 });
  assert.equal(await h.wait(), undefined);
  h.tick(30_000);
  assert.match(await h.wait(), /total time budget/);
});

test('token usage remains monotonic over a completion wakeup', async (t) => {
  const h = await harness(t, { maxTurnTokens: 100 });
  h.pressure(90);
  await h.wait();
  await h.preStep(2, [{ source: { kind: 'plugin', plugin: 'tool-jobs' } }]);
  h.pressure(101);
  assert.match(await h.wait(), /global token budget/);
});

for (const wait of [false, true]) test(`busy polling stays bounded (wait=${wait}) despite changing timeouts/timestamps`, async (t) => {
  const h = await harness(t);
  for (let i = 0; i < 4; i++) {
    await h.wait('bash-1', { wait, timeout_ms: i + 1 }, pending('bash-1', {
      job: { id: 'bash-1', status: 'running', startedAt: i, updatedAt: i },
    }), i + 1);
  }
  assert.match(h.cancellations[0], /repeated investigation cycle/);
  assert.match(await h.wait(), /already closed/);
});

test('claiming wait:true without actually waiting is not an exemption', async (t) => {
  const h = await harness(t);
  for (let i = 0; i < 4; i++) await h.wait('bash-1', {}, pending(), 0);
  assert.match(h.cancellations[0], /repeated investigation cycle/);
});

test('tool names and model-supplied capability data cannot grant observation', async (t) => {
  const h = await harness(t);
  h.definitions.delete('job_output'); // A scoped replacement has no host capability.
  await h.call('bash', { command: 'slow' }, timeout);
  assert.match(await h.wait('bash-1', { readOnly: true, capabilities: { readOnly: true } }), /read-only executor capability/);
});

test('diagnostic mode admits registered observers but denies mutations, kill and arbitrary shell', async (t) => {
  const h = await harness(t, { diagnosticMaxCalls: 4 });
  await h.call('bash', { command: 'slow' }, timeout);
  for (const name of ['goal', 'job_kill', 'bash']) {
    assert.match(await h.call(name, { action: 'edit', command: 'tail log', readOnly: true }), /read-only executor capability/);
  }
  assert.equal(await h.wait(), undefined);
  assert.equal(await h.call('job_list', {}, { value: [] }), undefined);
  assert.equal(h.cancellations.length, 0);
});

test('invalid/foreign job IDs do not acquire a read-only capability', async (t) => {
  const h = await harness(t);
  await h.call('bash', {}, timeout);
  assert.match(await h.wait('foreign-1'), /read-only executor capability/);
  assert.match(await h.wait('bash-1', { timeout_ms: -1 }), /read-only executor capability/);
});

test('diagnostic call allowance is not replenished by a job notification', async (t) => {
  const h = await harness(t, { diagnosticMaxCalls: 2 });
  await h.call('bash', {}, timeout);
  await h.wait();
  await h.preStep(2, [{ source: { kind: 'plugin', plugin: 'tool-jobs' } }]);
  await h.wait();
  assert.match(h.cancellations[0], /diagnostic mode exhausted its budget of 2/);
});

test('diagnostic elapsed time survives automatic continuation', async (t) => {
  const h = await harness(t, { diagnosticMaxMs: 60_000 });
  await h.call('bash', {}, timeout);
  await h.wait();
  await h.preStep(2);
  h.tick(30_000);
  assert.match(await h.wait(), /diagnostic mode exceeded its reduced time budget/);
});

test('a real second timeout still stops diagnosis even on an observer', async (t) => {
  const h = await harness(t);
  await h.call('bash', {}, timeout);
  await h.wait('bash-1', {}, { ...pending(), isError: true, value: { ...pending().value, timedOut: true } });
  assert.match(h.cancellations[0], /second timeout/);
});

test('neutral observations never erase earlier equivalent failures', async (t) => {
  const h = await harness(t);
  const failure = { isError: true, value: { exitCode: 1, error: 'ENOENT' } };
  for (let i = 0; i < 3; i++) {
    assert.equal(await h.call('bash', { command: 'cat missing.txt' }, failure), undefined);
    assert.equal(await h.wait(), undefined);
  }
  assert.match(await h.call('bash', { command: 'cat missing.txt' }, failure), /equivalent failures/);
});

test('each job has independent terminal collection; repeated final reads remain bounded', async (t) => {
  const h = await harness(t);
  for (const id of ['bash-1', 'bash-2']) {
    h.jobs.set(id, 'completed');
    assert.equal(await h.wait(id, {}, { value: { text: 'ok', job: { id, status: 'completed' } } }, 0), undefined);
  }
  const result = { value: { text: 'ok', job: { id: 'bash-1', status: 'completed' } } };
  for (let i = 0; i < 4; i++) await h.wait('bash-1', {}, result, 0);
  assert.match(h.cancellations[0], /repeated investigation cycle/);
});

test('early terminal failure is collectable without pretending the job succeeded', async (t) => {
  const h = await harness(t);
  const result = { value: { text: 'download failed', job: { id: 'bash-1', status: 'failed', detail: 'exit 1' } } };
  assert.equal(await h.wait('bash-1', {}, result, 10), undefined);
  assert.equal(result.value.job.status, 'failed');
  assert.equal(h.cancellations.length, 0);
});

test('global call allowance survives automatic turns; an explicit user turn may reset it', async (t) => {
  const h = await harness(t, { maxTurnToolCalls: 4 });
  await h.wait();
  await h.wait();
  await h.preStep(2);
  await h.wait();
  await h.wait();
  assert.match(h.cancellations[0], /global tool-call budget of 4/);
  await h.preStep(3, [{ source: { kind: 'user' } }]);
  assert.equal(await h.wait(), undefined);
});
