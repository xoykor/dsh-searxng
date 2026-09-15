/**
 * Model-independent execution budget and loop protection for DSH.
 *
 * The plugin intentionally depends only on public Cordis services. Decisions
 * that stop a turn are made by the executor, not by a model instruction.
 */
export const name = 'dsh-context-guard';
export const inject = ['tools', 'tokenMeter', 'compaction'];
const CHECKPOINT_POLICY = Symbol.for('dsh.contextGuard.checkpointPolicy.v1');

const DEFAULTS = Object.freeze({
  economyTokens: 131_072,
  checkpointTokens: 163_840,
  compactTokens: 188_743,
  noProgressLimit: 3,
  equivalentBlockLimit: 5,
  maxTurnSteps: 48,
  maxTurnToolCalls: 48,
  maxTurnMs: 900_000,
  maxTurnTokens: undefined,
  diagnosticMaxCalls: 3,
  diagnosticMaxMs: 120_000,
  diagnosticMaxTokens: undefined,
  textSimilarity: 0.94,
  resultFingerprintChars: 8_000,
});

function positiveInteger(value, fallback, label) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error('dsh-context-guard: ' + label + ' must be a positive integer');
  }
  return value;
}

function resolveConfig(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('dsh-context-guard: configuration must be an object');
  }
  const knownKeys = new Set([
    'economyTokens', 'checkpointTokens', 'compactTokens', 'noProgressLimit',
    'equivalentBlockLimit', 'maxTurnSteps', 'maxTurnToolCalls', 'maxTurnMs',
    'maxTurnTokens', 'diagnosticMaxCalls', 'diagnosticMaxMs',
    'diagnosticMaxTokens', 'textSimilarity', 'resultFingerprintChars',
    'contextWindow', 'summaryMaxTokens', 'summaryMinTokens', 'safetyTokens', 'responseMaxTokens',
  ]);
  for (const key of Object.keys(raw)) {
    if (!knownKeys.has(key)) {
      throw new Error('dsh-context-guard: unknown configuration key "' + key + '"');
    }
  }
  const config = {
    economyTokens: positiveInteger(raw.economyTokens, DEFAULTS.economyTokens, 'economyTokens'),
    checkpointTokens: positiveInteger(raw.checkpointTokens, DEFAULTS.checkpointTokens, 'checkpointTokens'),
    compactTokens: positiveInteger(raw.compactTokens, DEFAULTS.compactTokens, 'compactTokens'),
    noProgressLimit: positiveInteger(raw.noProgressLimit, DEFAULTS.noProgressLimit, 'noProgressLimit'),
    equivalentBlockLimit: positiveInteger(raw.equivalentBlockLimit, DEFAULTS.equivalentBlockLimit, 'equivalentBlockLimit'),
    maxTurnSteps: raw.maxTurnSteps === null ? null : positiveInteger(raw.maxTurnSteps, DEFAULTS.maxTurnSteps, 'maxTurnSteps'),
    maxTurnToolCalls: raw.maxTurnToolCalls === null ? null : positiveInteger(raw.maxTurnToolCalls, DEFAULTS.maxTurnToolCalls, 'maxTurnToolCalls'),
    maxTurnMs: raw.maxTurnMs === null ? null : positiveInteger(raw.maxTurnMs, DEFAULTS.maxTurnMs, 'maxTurnMs'),
    maxTurnTokens: raw.maxTurnTokens !== undefined
      ? positiveInteger(raw.maxTurnTokens, undefined, 'maxTurnTokens')
      : undefined,
    diagnosticMaxCalls: positiveInteger(raw.diagnosticMaxCalls, DEFAULTS.diagnosticMaxCalls, 'diagnosticMaxCalls'),
    diagnosticMaxMs: positiveInteger(raw.diagnosticMaxMs, DEFAULTS.diagnosticMaxMs, 'diagnosticMaxMs'),
    diagnosticMaxTokens: raw.diagnosticMaxTokens !== undefined
      ? positiveInteger(raw.diagnosticMaxTokens, undefined, 'diagnosticMaxTokens')
      : undefined,
    textSimilarity: raw.textSimilarity ?? DEFAULTS.textSimilarity,
    resultFingerprintChars: positiveInteger(raw.resultFingerprintChars, DEFAULTS.resultFingerprintChars, 'resultFingerprintChars'),
    contextWindow: positiveInteger(raw.contextWindow, undefined, 'contextWindow'),
    summaryMaxTokens: positiveInteger(raw.summaryMaxTokens, undefined, 'summaryMaxTokens'),
    summaryMinTokens: positiveInteger(raw.summaryMinTokens, undefined, 'summaryMinTokens'),
    safetyTokens: positiveInteger(raw.safetyTokens, undefined, 'safetyTokens'),
    responseMaxTokens: positiveInteger(raw.responseMaxTokens, undefined, 'responseMaxTokens'),
  };
  if (!(config.economyTokens < config.checkpointTokens && config.checkpointTokens < config.compactTokens)) {
    throw new Error('dsh-context-guard: economyTokens < checkpointTokens < compactTokens is required');
  }
  if (config.maxTurnToolCalls !== null && config.diagnosticMaxCalls > config.maxTurnToolCalls) {
    throw new Error('dsh-context-guard: diagnosticMaxCalls must be <= maxTurnToolCalls');
  }
  const reserveKeys = ['contextWindow', 'summaryMaxTokens', 'summaryMinTokens', 'safetyTokens', 'responseMaxTokens'];
  if (reserveKeys.some(key => config[key] !== undefined)) {
    if (reserveKeys.some(key => config[key] === undefined)
      || config.summaryMinTokens > config.summaryMaxTokens
      || config.compactTokens + config.responseMaxTokens + config.summaryMaxTokens + config.safetyTokens >= config.contextWindow) {
      throw new Error('dsh-context-guard: complete checkpoint reserves required; compactTokens + responseMaxTokens + summaryMaxTokens + safetyTokens must be < contextWindow');
    }
  }
  if (typeof config.textSimilarity !== 'number' || config.textSimilarity < 0.8 || config.textSimilarity > 1) {
    throw new Error('dsh-context-guard: textSimilarity must be between 0.8 and 1');
  }
  return Object.freeze(config);
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function canonical(value) {
  try {
    return JSON.stringify(stable(value));
  } catch {
    return String(value);
  }
}

function normalizedText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{N} ]/gu, '')
    .trim();
}

function similarity(left, right) {
  if (!left || !right) return 0;
  if (left === right) return 1;
  const a = new Set(left.split(' ').filter(Boolean));
  const b = new Set(right.split(' ').filter(Boolean));
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / Math.max(a.size, b.size);
}

function toolResultText(result, cap) {
  const blocks = Array.isArray(result?.content) ? result.content : [];
  const content = blocks.map((block) => {
    if (block?.type === 'text') return block.text;
    try { return JSON.stringify(block); } catch { return String(block); }
  }).join('\n');
  let value = '';
  if (result?.value !== undefined) {
    try { value = JSON.stringify(stable(result.value)); } catch { value = String(result.value); }
  }
  const prefix = result?.isError === true ? 'error:' : 'ok:';
  // Put structured executor facts first so timeout, exit, and fs before/after
  // metadata cannot be pushed out of the bounded fingerprint by stdout.
  const serialized = prefix + (value ? '\nvalue:' + value : '') + '\ncontent:' + content;
  return serialized.slice(0, cap);
}

function isWorkspaceMutation(name) {
  return /(?:write|edit|patch|replace|apply|create_file|delete|unlink|rename|move|install|format|mkdir|rm|mv|cp)/i.test(name);
}

const COMMAND_TOOLS = new Set([
  'bash',
  'shell',
  'exec',
  'terminal',
  'run_code',
  'python',
  'pwsh',
  'powershell',
  'code',
]);

function hasReadOnlyCapability(exec) {
  // Read-only is executor metadata, never inferred from a tool name or source
  // text. The DSH ToolExecution contract currently has no built-in field, so a
  // host that wants timeout diagnosis must explicitly attach one of these
  // capability shapes at its policy boundary.
  return exec?.readOnly === true
    || exec?.capabilities?.readOnly === true
    || exec?.capability?.readOnly === true
    || exec?.definition?.readOnly === true;
}

// Published only on the registered executor definition, never in model input.
// Resolving through the registry honors scoped replacements and restrictions.
const JOB_OBSERVATION = Symbol.for('dsh.executor.jobObservation.v1');
const MIN_MANAGED_WAIT_MS = 1_000;
const ACTIVE_JOB_STATES = new Set(['running', 'stopping']);
const TERMINAL_JOB_STATES = new Set(['completed', 'failed', 'killed']);

function jobObservation(ctx, exec) {
  try {
    const capability = ctx.tools.get?.(exec.name, exec.agent)?.[JOB_OBSERVATION];
    if (capability?.readOnly !== true || typeof capability.observe !== 'function') return undefined;
    const observed = capability.observe(exec);
    if (observed?.kind === 'list') return observed;
    if (observed?.kind !== 'output' || typeof observed.jobId !== 'string'
      || !Number.isFinite(observed.waitMs) || observed.waitMs < 0
      || (!ACTIVE_JOB_STATES.has(observed.status) && !TERMINAL_JOB_STATES.has(observed.status))) {
      return undefined;
    }
    return observed;
  } catch {
    // Missing/foreign job IDs and invalid arguments never earn an exemption.
    return undefined;
  }
}

function observationArguments(exec, observation) {
  // Changing a poll's timeout/description must not manufacture a new action.
  return observation?.kind === 'output'
    ? { job_id: observation.jobId }
    : identityArguments(exec.arguments);
}

function observationFingerprint(result, observation, cap) {
  if (observation?.kind !== 'output' || result?.isError || !result?.value?.job) {
    return toolResultText(result, cap);
  }
  const { text, job } = result.value;
  return toolResultText({ value: { text, job: { id: job.id, status: job.status, detail: job.detail } } }, cap);
}

function identityArguments(argumentsValue) {
  if (!argumentsValue || typeof argumentsValue !== 'object' || Array.isArray(argumentsValue)) {
    return argumentsValue;
  }
  return Object.fromEntries(
    Object.entries(argumentsValue).filter(([key]) => key !== 'description'),
  );
}

function actionKey(name, argumentsValue) {
  return String(name) + '\u0000' + canonical(identityArguments(argumentsValue));
}

function fileReferences(argumentsValue) {
  const text = canonical(argumentsValue);
  const matches = text.match(
    /[A-Za-z0-9_.~/-]+[A-Za-z0-9_.~-]*\.(?:py|js|mjs|ts|tsx|json|ya?ml|toml|ini|cfg|conf|md|log|txt)/gi,
  ) ?? [];
  return [...new Set(matches)].sort().slice(0, 16);
}

function semanticActionKey(name, argumentsValue) {
  const normalizedName = String(name).toLowerCase();
  const args = identityArguments(argumentsValue);
  const files = fileReferences(args);
  const subject = args && typeof args === 'object'
    ? (args.command ?? args.code ?? args.path ?? args.file ?? args.query ?? '')
    : '';
  // Keep command/content bytes intact for semantic cycle identity. The
  // bounded slice is only a memory cap; whitespace is not a delimiter here.
  const subjectText = String(subject).slice(0, 240);
  if (files.length > 0) {
    return normalizedName + '|' + files.join('|') + (COMMAND_TOOLS.has(normalizedName) ? '|' + subjectText : '');
  }
  return normalizedName + '|' + (subjectText || canonical(args).slice(0, 240));
}

function isCommandTool(name) {
  return COMMAND_TOOLS.has(String(name).toLowerCase());
}

function commandArgument(argumentsValue) {
  if (!argumentsValue || typeof argumentsValue !== 'object') return '';
  return String(argumentsValue.command ?? argumentsValue.code ?? '').trim();
}

function normalizedErrorText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/0x[\da-f]+/gi, '<hex>')
    .replace(/(?:line|column|col|offset|position)\s*[:=]?\s*\d+/g, '$1:<n>')
    .replace(/\b\d+\b/g, '<n>')
    .replace(/(?:\/[^\s:'"]+)+/g, '<path>')
    .replace(/\s+/g, ' ')
    .trim();
}

function resultErrorCause(result) {
  const value = result?.value;
  return value?.code ?? value?.errorCode ?? value?.reason ?? value?.error
    ?? result?.error?.code ?? result?.error?.message
    ?? (Array.isArray(result?.content) ? result.content.map((block) => block?.text ?? '').join(' ') : '');
}

function commandFailureEvidence(result, toolName) {
  if (result?.isError === true || timeoutEvidence(result, toolName)) return true;
  if (!isCommandTool(toolName)) return false;
  const value = result?.value;
  const exitCode = value?.exitCode ?? value?.exit_code;
  if (Number.isFinite(exitCode) && exitCode !== 0) return true;
  if (value?.signal !== undefined && value.signal !== null && value.signal !== '') return true;
  if (value?.aborted === true || value?.sandboxDenied === true || value?.sandbox_denied === true
    || value?.permissionDenied === true || value?.permission_denied === true) return true;
  const text = toolResultText(result, 4_000).toLowerCase();
  return /sandbox\s+(?:denied|violation)|permission denied|access denied|not permitted/.test(text);
}

function errorFamily(toolName, argumentsValue, result) {
  if (result?.isError !== true && !commandFailureEvidence(result, toolName)) return undefined;
  const cause = normalizedErrorText(resultErrorCause(result));
  let stage = 'other';
  if (timeoutEvidence(result, toolName) || /timeout|timed out|etimedout/.test(cause)) stage = 'timeout';
  else if (/parse|syntax|unicode escape|type-strip|unexpected token/.test(cause)) stage = 'parse';
  else if (/type error|undefined|null is not|not a function|cannot read/.test(cause)) stage = 'type';
  else if (result?.value?.sandboxDenied === true || result?.value?.sandbox_denied === true
    || result?.value?.permissionDenied === true || result?.value?.permission_denied === true
    || /permission|eacces|eperm|access denied|sandbox|not permitted|denied/.test(cause)) stage = 'permission';
  else if (/network|connection|enotfound|econn|http\s*[45]\d\d/.test(cause)) stage = 'network';
  else if (/validation|invalid argument|schema|unknown key/.test(cause)) stage = 'validation';
  const refs = fileReferences(argumentsValue).join('|');
  // Keep the class and resource, while dropping changing stack locations and
  // prose. The full result remains in the normal tool log for diagnosis.
  return String(toolName).toLowerCase() + '|' + stage + '|' + refs;
}

function errorFamilyHint(toolName, argumentsValue) {
  const text = normalizedErrorText(commandArgument(argumentsValue));
  let stage = 'other';
  if (/timeout|timed out|etimedout/.test(text)) stage = 'timeout';
  else if (/parse|syntax|unicode escape|type-strip|unexpected token|bad syntax/.test(text)) stage = 'parse';
  else if (/type error|undefined|null is not|not a function|cannot read/.test(text)) stage = 'type';
  return String(toolName).toLowerCase() + '|' + stage;
}

function observedMutationChange(result) {
  if (result?.isError === true) return false;
  const candidates = [result, result?.value, result?.meta];
  for (const value of candidates) if (value && typeof value === 'object') {
    if (value.changed === true || value.modified === true || value.written === true) return true;
    if (Array.isArray(value.changedFiles) && value.changedFiles.length > 0) return true;
    if (value.before !== undefined && value.after !== undefined && canonical(value.before) !== canonical(value.after)) return true;
    if (value.beforeHash !== undefined && value.afterHash !== undefined && value.beforeHash !== value.afterHash) return true;
    if (value.revision !== undefined || value.newRevision !== undefined) return true;
  }
  return false;
}

function tokenUsageAmount(usage) {
  if (!usage || typeof usage !== 'object') return undefined;
  const total = usage.totalTokens;
  const parts = [
    usage.inputTokens, usage.outputTokens, usage.cacheReadTokens,
    usage.cacheWriteTokens,
  ];
  if (Number.isFinite(total) && total > 0) return total;
  if (!parts.some((part) => Number.isFinite(part))) {
    return Number.isFinite(total) && total >= 0 ? total : undefined;
  }
  return parts.reduce((sum, part) => sum + (Number.isFinite(part) && part >= 0 ? part : 0), 0);
}

function isWorkspaceMutationCall(name, argumentsValue) {
  if (isWorkspaceMutation(name)) return true;
  if (!isCommandTool(name)) return false;
  const command = commandArgument(argumentsValue);
  return /(?:\b(?:sed|perl|tee|touch|mkdir|rmdir|rm|mv|cp|install|patch|apply_patch)\b|\bgit\s+(?:apply|checkout|restore|merge|cherry-pick)\b|\b(?:npm|pnpm|yarn)\s+(?:install|add|remove|uninstall)\b|\bpip\s+install\b|\b(?:write_text|writeFile|appendFile|open\s*\([^\n]*['\"](?:w|a))|(?:^|[^>])>{1,2})/i.test(command);
}

function timeoutEvidence(result, toolName) {
  const value = result?.value;
  if (value && (value.timedOut === true || value.timed_out === true || value.timeout === true)) {
    return true;
  }
  if (!isCommandTool(toolName)) return false;
  const reason = value?.reason ?? value?.error ?? result?.error?.message;
  if (typeof reason === 'string' && /(?:BASH_TIMEOUT|timed out|etimedout|timeout)/i.test(reason)) {
    return true;
  }
  const text = toolResultText(result, 4_000).toLowerCase();
  if (/\[timed out after \d+\s*ms\]|bash_timeout|etimedout/.test(text)) return true;
  const exitCode = value?.exitCode ?? value?.exit_code;
  return isCommandTool(toolName) && exitCode === 124;
}

function timeoutDuration(result) {
  const value = result?.value;
  for (const candidate of [value?.durationMs, value?.duration_ms, value?.timeoutMs, value?.timeout_ms]) {
    if (Number.isFinite(candidate) && candidate > 0) return candidate;
  }
  const match = toolResultText(result, 2_000).match(/(?:after|timeout(?:ed)?)[^\d]*(\d+)\s*ms/i);
  return match ? Number(match[1]) : undefined;
}

function cycleAtom(entry) {
  return canonical([
    entry.semanticKey,
    entry.resultFingerprint,
    entry.changeVersion,
  ]);
}

function hasRepeatedCycle(history) {
  const maximumPeriod = Math.min(6, Math.floor(history.length / 2));
  for (let period = 2; period <= maximumPeriod; period += 1) {
    const split = history.length - period;
    let equal = true;
    for (let index = 0; index < period; index += 1) {
      if (cycleAtom(history[split - period + index]) !== cycleAtom(history[split + index])) {
        equal = false;
        break;
      }
    }
    if (equal) return true;
  }
  return false;
}

function isGuardResult(result) {
  return result?.isError === true && toolResultText(result, 300).includes('CONTEXT-GUARD');
}

function notice(text, summary) {
  return Object.freeze({
    id: 'context-guard-' + crypto.randomUUID(),
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text })]),
    source: Object.freeze({ kind: 'plugin', plugin: name, form: 'notice', summary }),
  });
}

function createState() {
  return {
    actionCounts: new Map(),
    stagnantActionCounts: new Map(),
    failureFamilyCounts: new Map(),
    failureFamilyVersion: new Map(),
    lastFailureFamily: '',
    lastResultByAction: new Map(),
    actionSamples: [],
    actionHistory: [],
    collectedJobs: new Set(),
    noProgress: 0,
    lastAssistantText: '',
    repeatedAssistantText: false,
    currentTurn: null,
    currentStep: 0,
    logicalStartedAt: 0,
    logicalSteps: 0,
    turnStartedAt: 0,
    turnActive: false,
    turnCalls: 0,
    inFlightCalls: 0,
    turnTokenBaseline: null,
    turnTokenUsage: 0,
    reportedTokenUsage: 0,
    hasReportedTokenUsage: false,
    meterHighWater: 0,
    changeVersion: 0,
    mode: 'idle',
    stopReason: '',
    cancelFailed: false,
    timeoutRecord: null,
    diagnosticCalls: 0,
    diagnosticStartedAt: 0,
    diagnosticTokenBaseline: 0,
    diagnosticNoticeIssued: false,
    turnTimer: undefined,
    diagnosticTimer: undefined,
    economyNoticed: false,
    checkpointNoticed: false,
    compactNoticed: false,
    immediateCompactionPending: false,
    immediateCompactionPromise: undefined,
    compactionController: undefined,
    agent: undefined,
  };
}

export function apply(ctx, rawConfig = {}) {
  const { presetPolicies = {}, ...baseConfig } = rawConfig;
  const config = resolveConfig(baseConfig);
  if (!presetPolicies || typeof presetPolicies !== 'object' || Array.isArray(presetPolicies)) {
    throw new Error('dsh-context-guard: presetPolicies must be an object');
  }
  const policies = new Map(Object.entries(presetPolicies).map(([id, overrides]) => {
    if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
      throw new Error('dsh-context-guard: preset policy must be an object: ' + id);
    }
    return [id, resolveConfig({ ...baseConfig, ...overrides })];
  }));
  const presetService = () => ctx.get?.('agentPresets') ?? ctx.agentPresets;
  const configFor = (agent) => policies.get(presetService()?.composedPreset(agent?.ctx)) ?? config;
  // Available before the first pre-step: native middleware must not compact
  // a resumed session before the guard has created its per-agent state.
  ctx.provide?.('contextGuardPolicy', { forAgent: configFor });
  const states = new WeakMap();
  const sessionStates = new Map();
  const jobCalls = new WeakMap();

  const stateFor = (agent) => {
    let state = states.get(agent);
    if (!state) {
      const sessionId = agent?.session?.id === undefined ? undefined : String(agent.session.id);
      state = sessionId === undefined ? undefined : sessionStates.get(sessionId);
      if (!state) state = createState();
      state.agent = agent;
      states.set(agent, state);
      if (sessionId !== undefined) sessionStates.set(sessionId, state);
    }
    state.config = configFor(agent);
    if (state.config.contextWindow !== undefined) agent[CHECKPOINT_POLICY] = state.config;
    else delete agent[CHECKPOINT_POLICY];
    return state;
  };

  const clearTimer = (timer) => {
    if (timer !== undefined) clearTimeout(timer);
  };

  const clearTurnTimers = (state) => {
    clearTimer(state.turnTimer);
    clearTimer(state.diagnosticTimer);
    state.turnTimer = undefined;
    state.diagnosticTimer = undefined;
  };

  const readTokenTotal = (agent) => {
    if (!ctx.tokenMeter || !agent?.session) return undefined;
    try {
      const total = ctx.tokenMeter.measure(agent.session).totalTokens;
      return Number.isFinite(total) ? total : undefined;
    } catch {
      return undefined;
    }
  };

  const updateTokenUsage = (state, agent) => {
    if (state.hasReportedTokenUsage) {
      state.turnTokenUsage = Math.max(state.turnTokenUsage, state.reportedTokenUsage);
      return state.turnTokenUsage;
    }
    const total = readTokenTotal(agent);
    if (total === undefined) return undefined;
    if (state.turnTokenBaseline === null) state.turnTokenBaseline = total;
    const usage = Math.max(0, total - state.turnTokenBaseline);
    // `measure().totalTokens` is current context pressure. Keep a monotonic
    // high-water fallback so compaction cannot make the hard limit go down.
    state.meterHighWater = Math.max(state.meterHighWater, usage);
    state.turnTokenUsage = Math.max(state.turnTokenUsage, state.meterHighWater);
    return state.turnTokenUsage;
  };

  const resetTurnState = (state, agent) => {
    state.turnStartedAt = Date.now();
    state.turnCalls = 0;
    state.inFlightCalls = 0;
    state.turnTokenBaseline = readTokenTotal(agent) ?? null;
    state.turnTokenUsage = 0;
    state.reportedTokenUsage = 0;
    state.hasReportedTokenUsage = false;
    state.meterHighWater = 0;
    state.diagnosticCalls = 0;
    state.diagnosticStartedAt = 0;
    state.diagnosticTokenBaseline = 0;
    state.diagnosticNoticeIssued = false;
    state.turnActive = true;
  };

  const resetLogicalExecutionState = (state) => {
    state.logicalStartedAt = Date.now();
    state.logicalSteps = 0;
    state.changeVersion = 0;
    state.mode = 'normal';
    state.stopReason = '';
    state.cancelFailed = false;
    state.timeoutRecord = null;
    state.immediateCompactionPending = false;
    state.immediateCompactionPromise = undefined;
    state.noProgress = 0;
    state.lastAssistantText = '';
    state.repeatedAssistantText = false;
    state.actionCounts.clear();
    state.stagnantActionCounts.clear();
    state.actionSamples.length = 0;
    state.failureFamilyCounts.clear();
    state.failureFamilyVersion.clear();
    state.lastFailureFamily = '';
    state.lastResultByAction.clear();
    state.actionHistory.length = 0;
    state.collectedJobs.clear();
    state.economyNoticed = false;
    state.checkpointNoticed = false;
    state.compactNoticed = false;
  };

  const stopTurn = (agent, state, reason, mode = 'stopped') => {
    if (state.mode === 'stopped' || state.mode === 'paused') return;
    state.mode = mode;
    state.stopReason = reason;
    state.cancelFailed = false;
    state.turnActive = false;
    state.compactionController?.abort(new Error(reason));
    clearTurnTimers(state);

    // Agent cancellation aborts exec.signal. Managed subprocess executors pass
    // that signal to their process-tree handle and await its termination.
    if (typeof agent?.cancel === 'function') {
      try {
        if (agent.status === undefined || agent.status === 'running') {
          agent.cancel({ kind: 'hook', reason }, { keepInbox: true });
        }
      } catch {
        // The turn may already be at its driver boundary; the guard still
        // denies every subsequent tool call, while exposing cancellation
        // uncertainty in the durable stop reason.
        state.cancelFailed = true;
        state.stopReason = reason + ' Agent cancellation could not be confirmed.';
      }
    }
  };

  const runImmediateCompaction = (agent, state) => {
    if (!state.immediateCompactionPending || state.immediateCompactionPromise) return;
    const compaction = presetService()?.serviceFor?.(agent, 'compaction') ?? ctx.compaction;
    if (!compaction || typeof compaction.compactNow !== 'function') {
      state.immediateCompactionPending = false;
      stopTurn(
        agent,
        state,
        'CONTEXT-GUARD STOPPED: immediate compaction reached the threshold, but no compaction service is available.',
      );
      return;
    }

    const promise = (async () => {
      try {
        const controller = new AbortController();
        state.compactionController = controller;
        const checkpoint = state.config.contextWindow !== undefined;
        if (checkpoint && typeof compaction.checkpointNow !== 'function') {
          throw new Error('checkpoint runtime patch is unavailable; refusing to compact without a saved state summary');
        }
        const result = checkpoint
          ? await compaction.checkpointNow(agent, controller.signal, {
            ...state.config,
            onPhase: phase => { state.mode = phase === 'summarizing' ? 'summarizing' : 'compacting'; },
          })
          : await compaction.compactNow(agent, controller.signal);
        if (result === null) throw new Error('no compactable durable history was available');
        controller.signal.throwIfAborted();
        state.immediateCompactionPending = false;
        // Compaction changes context pressure, not the user's authorization or
        // the logical execution budgets and anti-loop evidence.
        state.mode = 'normal';
        state.stopReason = '';
        state.economyNoticed = state.checkpointNoticed = state.compactNoticed = false;
        state.turnActive = false;
        agent.steer(notice(
          'CONTEXT-GUARD: context pressure paused the previous step; its state summary was saved before compaction. '
            + 'Resume the current task from the compacted durable history. Do not repeat an interrupted '
            + 'side-effecting operation without checking whether it completed.',
          'resumed from saved context checkpoint',
        ));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        state.immediateCompactionPending = false;
        stopTurn(
          agent,
          state,
          'CONTEXT-GUARD STOPPED: checkpoint/compaction failed; do not resume or discard history: '
            + message,
        );
      } finally {
        state.immediateCompactionPromise = undefined;
        state.compactionController = undefined;
      }
    })();
    state.immediateCompactionPromise = promise;
    void promise;
  };

  const preserveClaimedMessages = (agent, messages = []) => {
    // pre-step input has been claimed from the inbox, but is not yet on the
    // conversation surface. Keep it before cancelling that admission attempt.
    if (!messages.length) return;
    if (!agent.session?.append) throw new Error('cannot preserve claimed checkpoint input');
    const existing = new Set((agent.session.deriveMessages?.() ?? []).map(message => message.id));
    for (const message of messages) {
      if (message.id && existing.has(message.id)) continue;
      agent.session.append('user/message', message, { surfaceOp: 'append' });
      if (message.id) existing.add(message.id);
    }
  };

  const beginImmediateCompaction = (agent, state, totalTokens, messages = []) => {
    if (state.mode !== 'normal' || !state.turnActive || state.immediateCompactionPending) return;
    const reason = 'CONTEXT-GUARD: approximately ' + totalTokens
      + ' tokens reached the checkpoint threshold; pausing active work to summarize, persist, then compact.';
    state.immediateCompactionPending = true;
    state.mode = state.config.contextWindow === undefined ? 'compacting' : 'summarizing';
    state.stopReason = reason;
    state.turnActive = false;
    clearTurnTimers(state);
    try {
      preserveClaimedMessages(agent, messages);
      if (typeof agent?.cancel !== 'function') throw new Error('agent cancellation is unavailable');
      agent.cancel({ kind: 'context-guard-compaction', reason }, { keepInbox: true });
    } catch (error) {
      state.immediateCompactionPending = false;
      const message = error instanceof Error ? error.message : String(error);
      stopTurn(
        agent,
        state,
        reason + ' Active work could not be interrupted: ' + message,
      );
      return;
    }
    if (agent.status === 'idle') runImmediateCompaction(agent, state);
  };

  const startTurn = (agent, state, turn, step, authorization = false) => {
    const isNewTurn = state.currentTurn !== turn;
    const newLogicalExecution = state.currentTurn === null || authorization;
    clearTurnTimers(state);
    if (newLogicalExecution) {
      resetLogicalExecutionState(state);
      resetTurnState(state, agent);
    } else if (isNewTurn) {
      // A plugin wakeup/automatic continuation is still the same authorized
      // execution. In particular, it cannot refill the diagnostic allowance.
      if (state.mode === 'idle') {
        state.mode = 'normal';
      }
    } else if (state.mode === 'idle') {
      state.mode = 'normal';
    }
    state.currentTurn = turn;
    state.currentStep = step;
    state.turnActive = true;
    state.logicalSteps += 1;

    // null disables only the whole-turn wall-clock deadline, not tool or diagnostic deadlines.
    if (state.config.maxTurnMs !== null) {
      const remainingMs = Math.max(0, state.config.maxTurnMs - (Date.now() - state.logicalStartedAt));
      state.turnTimer = setTimeout(() => {
        if (state.currentTurn !== turn || !state.turnActive) return;
        if (state.mode !== 'normal' && state.mode !== 'diagnostic') return;
        stopTurn(
          agent,
          state,
          'CONTEXT-GUARD STOPPED: the turn exceeded its total time budget of '
            + state.config.maxTurnMs + 'ms; active executor work was cancelled.',
        );
      }, remainingMs);
      state.turnTimer.unref?.();
    }
    if (state.mode === 'diagnostic' && state.diagnosticStartedAt > 0) {
      const diagnosticRemainingMs = Math.max(
        0,
        state.config.diagnosticMaxMs - (Date.now() - state.diagnosticStartedAt),
      );
      state.diagnosticTimer = setTimeout(() => {
        if (state.currentTurn !== turn || !state.turnActive || state.mode !== 'diagnostic') return;
        stopTurn(
          agent,
          state,
          'CONTEXT-GUARD STOPPED: diagnostic mode exceeded its reduced time budget of '
            + state.config.diagnosticMaxMs + 'ms; active executor work was cancelled.',
        );
      }, diagnosticRemainingMs);
      state.diagnosticTimer.unref?.();
    }
  };

  const enterDiagnostic = (agent, state, exec, result, resultFingerprint) => {
    if (state.mode === 'diagnostic') {
      stopTurn(
        agent,
        state,
        'CONTEXT-GUARD STOPPED: a second timeout occurred during diagnostic mode; the diagnostic budget was not renewed.',
      );
      return;
    }
    if (state.mode === 'stopped' || state.mode === 'paused') return;
    state.mode = 'diagnostic';
    state.diagnosticCalls = 0;
    state.diagnosticStartedAt = Date.now();
    state.diagnosticTokenBaseline = state.turnTokenUsage;
    state.diagnosticNoticeIssued = false;
    state.timeoutRecord = {
      tool: exec.name,
      identity: actionKey(exec.name, exec.arguments),
      arguments: stable(exec.arguments),
      durationMs: timeoutDuration(result),
      resultFingerprint,
      resultText: toolResultText(result, 1_600),
      changeVersion: state.changeVersion,
    };
    const turn = state.currentTurn;
    state.diagnosticTimer = setTimeout(() => {
      if (state.currentTurn !== turn || state.mode !== 'diagnostic') return;
      stopTurn(
        agent,
        state,
        'CONTEXT-GUARD STOPPED: diagnostic mode exceeded its reduced time budget of '
          + state.config.diagnosticMaxMs + 'ms; active executor work was cancelled.',
      );
    }, state.config.diagnosticMaxMs);
    state.diagnosticTimer.unref?.();
  };

  const budgetReason = (agent, state) => {
    const now = Date.now();
    if (state.config.maxTurnMs !== null && state.turnStartedAt > 0 && now - state.turnStartedAt >= state.config.maxTurnMs) {
      return 'CONTEXT-GUARD STOPPED: the turn exceeded its total time budget of '
        + state.config.maxTurnMs + 'ms.';
    }
    if (state.config.maxTurnToolCalls !== null && state.turnCalls >= state.config.maxTurnToolCalls) {
      return 'CONTEXT-GUARD STOPPED: the turn exhausted its global tool-call budget of '
        + state.config.maxTurnToolCalls + '; results and the next step must be reported without another automatic call.';
    }
    const tokenUsage = updateTokenUsage(state, agent);
    if (state.config.maxTurnTokens !== undefined && tokenUsage !== undefined && tokenUsage >= state.config.maxTurnTokens) {
      return 'CONTEXT-GUARD STOPPED: the turn exhausted its global token budget of '
        + state.config.maxTurnTokens + ' tokens.';
    }
    if (state.mode === 'diagnostic') {
      if (now - state.diagnosticStartedAt >= state.config.diagnosticMaxMs) {
        return 'CONTEXT-GUARD STOPPED: diagnostic mode exceeded its reduced time budget of '
          + state.config.diagnosticMaxMs + 'ms.';
      }
      if (state.diagnosticCalls >= state.config.diagnosticMaxCalls) {
        return 'CONTEXT-GUARD STOPPED: diagnostic mode exhausted its budget of '
          + state.config.diagnosticMaxCalls + ' calls.';
      }
      if (state.config.diagnosticMaxTokens !== undefined && tokenUsage !== undefined && tokenUsage - state.diagnosticTokenBaseline >= state.config.diagnosticMaxTokens) {
        return 'CONTEXT-GUARD STOPPED: diagnostic mode exhausted its reduced token budget of '
          + state.config.diagnosticMaxTokens + ' tokens.';
      }
    }
    return undefined;
  };

  ctx.tools.guard((exec) => {
    if (!exec.agent) return undefined;
    const state = stateFor(exec.agent);
    if (state.mode === 'idle') {
      state.mode = 'normal';
      state.turnStartedAt = Date.now();
      state.turnActive = true;
    }

    if (state.mode === 'stopped' || state.mode === 'paused') {
      return 'CONTEXT-GUARD BLOCKED: this turn is already closed by the executor. '
        + state.stopReason;
    }
    if (state.mode === 'compacting' || state.mode === 'summarizing') {
      return 'CONTEXT-GUARD BLOCKED: state summarization/compaction is in progress; work resumes only after the checkpoint is saved and committed.';
    }

    const beforeCall = budgetReason(exec.agent, state);
    if (beforeCall !== undefined) {
      stopTurn(exec.agent, state, beforeCall);
      return beforeCall;
    }
    state.turnCalls += 1;

    const observation = jobObservation(ctx, exec);

    if (state.mode === 'diagnostic') {
      if (!observation && !hasReadOnlyCapability(exec)) {
        return 'CONTEXT-GUARD BLOCKED: diagnostic mode requires an explicit '
          + 'read-only executor capability; tool names and command text are not sufficient. '
          + 'Use a supported job_output/job_list observer for managed work; editing a goal is not read-only.';
      }
      if (
        state.timeoutRecord
        && state.timeoutRecord.identity === actionKey(exec.name, exec.arguments)
        && state.timeoutRecord.changeVersion === state.changeVersion
      ) {
        return 'CONTEXT-GUARD BLOCKED: this is the timed-out command again with no '
          + 'executor-observed code, configuration, or strategy change.';
      }
      state.diagnosticCalls += 1;
      if (state.diagnosticCalls > state.config.diagnosticMaxCalls) {
        const reason = 'CONTEXT-GUARD STOPPED: diagnostic mode allows only '
          + state.config.diagnosticMaxCalls + ' calls after a timeout.';
        stopTurn(exec.agent, state, reason);
        return reason;
      }
    }

    const eligibleObservation = observation?.kind === 'output' && (
      (ACTIVE_JOB_STATES.has(observation.status) && observation.waitMs >= MIN_MANAGED_WAIT_MS)
      || (TERMINAL_JOB_STATES.has(observation.status) && !state.collectedJobs.has(observation.jobId))
    );
    if (observation) jobCalls.set(exec, { observation, eligibleObservation, startedAt: Date.now() });
    if (eligibleObservation) {
      // Only the anti-investigation checks are skipped. The global and
      // diagnostic budgets above (and their cancellation timers) still apply.
      state.inFlightCalls += 1;
      return undefined;
    }

    const args = canonical(observationArguments(exec, observation));
    const key = String(exec.name) + '\u0000' + args;
    const stagnantAttempts = state.stagnantActionCounts.get(key) ?? 0;
    const near = state.actionSamples.some((sample) => (
      sample.name === exec.name
      && similarity(sample.args, args) >= state.config.textSimilarity
    ));

    const familyHint = errorFamilyHint(exec.name, exec.arguments);
    const sameToolFallback = familyHint.endsWith('|other')
      && state.lastFailureFamily.startsWith(String(exec.name).toLowerCase() + '|');
    const familyCount = (state.lastFailureFamily.startsWith(familyHint) || sameToolFallback)
      ? (state.failureFamilyCounts.get(state.lastFailureFamily) ?? 0)
      : 0;
    if (
      familyCount >= state.config.noProgressLimit
      && state.failureFamilyVersion.get(state.lastFailureFamily) === state.changeVersion
    ) {
      const reason = 'CONTEXT-GUARD STOPPED: ' + exec.name
        + ' produced ' + familyCount + ' equivalent failures in the '
        + state.lastFailureFamily.split('|')[1] + ' family without an observed change.';
      stopTurn(exec.agent, state, reason);
      return reason;
    }

    if (stagnantAttempts >= state.config.equivalentBlockLimit) {
      const reason = 'CONTEXT-GUARD STOPPED: ' + exec.name
        + ' reached ' + state.config.equivalentBlockLimit
        + ' equivalent attempts without a new result'
        + (near ? ' (near-equivalent calls were also observed).' : '.');
      stopTurn(exec.agent, state, reason);
      return reason;
    }
    if (state.noProgress >= state.config.noProgressLimit && (state.lastFailureFamily === '' || familyCount > 0)) {
      const reason = 'CONTEXT-GUARD PAUSE: ' + state.noProgress
        + ' consecutive actions produced no new executor evidence. The executor '
        + 'closed the turn; inspect the latest failure in a new user turn.'
        + (state.repeatedAssistantText ? ' Repeated assistant text was also observed.' : '');
      stopTurn(exec.agent, state, reason, 'paused');
      return reason;
    }
    state.inFlightCalls += 1;
    return undefined;
  });

  ctx.on('tools/post-execute', async (exec, result, next) => {
    if (!exec.agent) return next();
    const state = stateFor(exec.agent);
    const denied = isGuardResult(result);
    if (!denied) state.inFlightCalls = Math.max(0, state.inFlightCalls - 1);
    const downstream = await next();
    if (denied) return downstream;
    const observedCall = jobCalls.get(exec);
    jobCalls.delete(exec);
    // Settling a cancelled foreground call must not replace the checkpoint
    // phase with diagnosis. Its durable result is included by the summarizer.
    if (state.immediateCompactionPending) return downstream;
    const observation = observedCall?.observation;
    const resultJob = result?.value?.job;
    const validJobResult = observation?.kind === 'output' && !result?.isError
      && resultJob?.id === observation.jobId && typeof result.value.text === 'string'
      && (ACTIVE_JOB_STATES.has(resultJob.status) || TERMINAL_JOB_STATES.has(resultJob.status));
    const executionTimedOut = timeoutEvidence(result, exec.name);
    const neutralObservation = observedCall?.eligibleObservation && validJobResult && !executionTimedOut
      && (TERMINAL_JOB_STATES.has(resultJob.status)
        || Date.now() - observedCall.startedAt >= MIN_MANAGED_WAIT_MS);
    if (validJobResult && TERMINAL_JOB_STATES.has(resultJob.status)) state.collectedJobs.add(resultJob.id);
    const args = canonical(observationArguments(exec, observation));
    const key = String(exec.name) + '\u0000' + args;
    const fingerprint = observationFingerprint(result, observation, state.config.resultFingerprintChars);

    // An executor-confirmed wait is neutral: it neither consumes investigation
    // retries nor clears previous failures. Empty output is not lack of job
    // progress; waitExpired is not an execution timeout. Terminal state is
    // collected once, so repeated reads of a finished job remain bounded.
    if (!neutralObservation) {
      const attempts = (state.actionCounts.get(key) ?? 0) + 1;
      state.actionCounts.set(key, attempts);
      state.actionSamples.push({ name: exec.name, args });
      if (state.actionSamples.length > 32) state.actionSamples.shift();

      const previousFingerprint = state.lastResultByAction.get(key);
      const isNewResult = previousFingerprint === undefined || previousFingerprint !== fingerprint;
      state.lastResultByAction.set(key, fingerprint);
      const family = errorFamily(exec.name, exec.arguments, result);
      if (family !== undefined) {
        const previousFamily = state.lastFailureFamily;
        const familyCount = (state.failureFamilyCounts.get(family) ?? 0) + 1;
        state.failureFamilyCounts.set(family, familyCount);
        state.failureFamilyVersion.set(family, state.changeVersion);
        state.lastFailureFamily = family;
        // Changing the wording, line, or stack of an equivalent failure does
        // not constitute progress. A different failure class starts a separate
        // bounded investigation budget.
        state.noProgress = previousFamily === family ? state.noProgress + 1 : 1;
        state.stagnantActionCounts.set(key, (state.stagnantActionCounts.get(key) ?? 0) + 1);
      } else if (isNewResult) {
        state.noProgress = 0;
        state.lastFailureFamily = '';
        state.stagnantActionCounts.set(key, 0);
      } else {
        state.noProgress += 1;
        state.stagnantActionCounts.set(key, (state.stagnantActionCounts.get(key) ?? 0) + 1);
      }
      if (
        isWorkspaceMutationCall(exec.name, exec.arguments)
        && observedMutationChange(result)
      ) {
        state.changeVersion += 1;
        state.failureFamilyCounts.clear();
        state.failureFamilyVersion.clear();
        state.stagnantActionCounts.clear();
        state.noProgress = 0;
        state.lastFailureFamily = '';
      }

      state.actionHistory.push({
        semanticKey: semanticActionKey(exec.name, observationArguments(exec, observation)),
        resultFingerprint: fingerprint,
        changeVersion: state.changeVersion,
      });
      if (state.actionHistory.length > 32) state.actionHistory.shift();
    }

    if (executionTimedOut) {
      if (state.mode === 'diagnostic') {
        stopTurn(
          exec.agent,
          state,
          'CONTEXT-GUARD STOPPED: a second timeout occurred during diagnostic mode; no budget renewal is allowed.',
        );
        return downstream;
      }
      enterDiagnostic(exec.agent, state, exec, result, fingerprint);
    }

    if (!neutralObservation && hasRepeatedCycle(state.actionHistory)) {
      stopTurn(
        exec.agent,
        state,
        'CONTEXT-GUARD STOPPED: a repeated investigation cycle was detected from '
          + 'tool sequence, referenced files, and unchanged results.',
      );
      return downstream;
    }

    const tokenUsage = updateTokenUsage(state, exec.agent);
    if (state.config.maxTurnToolCalls !== null && state.turnCalls >= state.config.maxTurnToolCalls && state.inFlightCalls === 0) {
      stopTurn(
        exec.agent,
        state,
        'CONTEXT-GUARD STOPPED: the turn exhausted its global tool-call budget of '
          + state.config.maxTurnToolCalls + '.',
      );
    } else if (state.config.maxTurnTokens !== undefined && tokenUsage !== undefined && tokenUsage >= state.config.maxTurnTokens) {
      stopTurn(
        exec.agent,
        state,
        'CONTEXT-GUARD STOPPED: the turn exhausted its global token budget of '
          + state.config.maxTurnTokens + ' tokens.',
      );
    } else if (
      state.mode === 'diagnostic'
      && state.diagnosticCalls >= state.config.diagnosticMaxCalls
    ) {
      stopTurn(
        exec.agent,
        state,
        'CONTEXT-GUARD STOPPED: diagnostic mode exhausted its budget of '
          + state.config.diagnosticMaxCalls + ' calls.',
      );
    }
    return downstream;
  });

  ctx.on('session/event', (session, event) => {
    const state = sessionStates.get(String(session.id));
    if (!state) return;
    if (event.type === 'assistant/message' && event.data?.turn === state.currentTurn) {
      const amount = tokenUsageAmount(event.data?.usage);
      if (amount !== undefined) {
        // Provider usage is per request. Summing it is stable across context
        // compaction, unlike the meter's current-pressure measurement.
        if (amount > 0) {
          state.reportedTokenUsage += amount;
          state.hasReportedTokenUsage = true;
          state.turnTokenUsage = Math.max(state.turnTokenUsage, state.reportedTokenUsage);
        }
      }
    }
    if (state.mode === 'stopped' || state.mode === 'paused') return;
    if (
      state.mode === 'normal'
      && state.turnActive
      && (event.type === 'assistant/message' || event.type === 'tool/result'
        || (state.config.contextWindow !== undefined
          && ['user/message', 'system/message', 'request/header'].includes(event.type)))
    ) {
      const totalTokens = readTokenTotal(state.agent ?? undefined);
      if (totalTokens !== undefined && totalTokens >= state.config.compactTokens) {
        beginImmediateCompaction(state.agent, state, totalTokens);
      }
    }
    if (event.type !== 'assistant/message') return;
    const text = (event.data?.message?.content ?? [])
      .filter((block) => block?.type === 'text')
      .map((block) => block.text)
      .join('\n');
    const normalized = normalizedText(text);
    if (normalized.length < 80) return;
    if (similarity(state.lastAssistantText, normalized) >= state.config.textSimilarity) {
      state.repeatedAssistantText = true;
      state.noProgress += 1;
    }
    state.lastAssistantText = normalized;
  });

  ctx.on('agent/status', ({ agent, status }) => {
    if (status !== 'idle' || !agent) return;
    const state = stateFor(agent);
    state.agent = agent;
    if ((state.mode === 'compacting' || state.mode === 'summarizing') && state.immediateCompactionPending) {
      runImmediateCompaction(agent, state);
    }
  });

  ctx.on('agent/pre-step', async ({ agent, signal, turn, step, messages }, next) => {
    if (!agent) return next();
    const state = stateFor(agent);
    if (state.immediateCompactionPending) {
      preserveClaimedMessages(agent, messages);
      return { kind: 'reject', reason: 'CONTEXT-GUARD: waiting for the saved state checkpoint and compaction.' };
    }
    const humanAuthorization = Array.isArray(messages)
      && messages.some((message) => message?.source?.kind === 'user');
    if (state.currentTurn !== turn || humanAuthorization) {
      startTurn(agent, state, turn, step, humanAuthorization);
    }
    state.currentStep = step;

    let reason;
    if (state.mode === 'stopped' || state.mode === 'paused') {
      reason = state.stopReason;
    } else if (state.config.maxTurnSteps !== null && state.logicalSteps > state.config.maxTurnSteps) {
      reason = 'CONTEXT-GUARD STOPPED: turn ' + turn
        + ' exceeded the hard limit of ' + state.config.maxTurnSteps + ' steps.';
    } else {
      reason = budgetReason(agent, state);
    }
    if (reason !== undefined) {
      stopTurn(agent, state, reason);
      return { kind: 'reject', reason };
    }

    const pressure = readTokenTotal(agent);
    if (state.config.contextWindow !== undefined && state.mode === 'normal'
      && pressure !== undefined && pressure >= state.config.compactTokens) {
      beginImmediateCompaction(agent, state, pressure, messages);
      return { kind: 'reject', reason: state.stopReason };
    }

    const decision = await next();
    if (signal.aborted || decision?.kind === 'reject' || !Array.isArray(decision?.messages)) {
      return decision;
    }

    const totalTokens = readTokenTotal(agent);
    const tokenUsage = updateTokenUsage(state, agent);
    const injected = [];

    if (state.mode === 'diagnostic' && !state.diagnosticNoticeIssued && state.timeoutRecord) {
      state.diagnosticNoticeIssued = true;
      const record = state.timeoutRecord;
      injected.push(notice(
        'EXECUTOR DIAGNOSTIC MODE: the previous executor call reported a timeout. '
          + 'Process cleanup status is not available from this guard. Tool='
          + record.tool
          + '; duration=' + (record.durationMs ?? 'unknown')
          + 'ms; diagnostic calls remaining='
          + Math.max(0, state.config.diagnosticMaxCalls - state.diagnosticCalls)
          + '. The prior output is recorded immediately before this notice. '
          + 'Use executor-marked job_output/job_list to observe managed background work. '
          + 'A pending wait is not an execution timeout. Goal edits and arbitrary shell probes '
          + 'are not read-only diagnosis. Only bounded diagnosis is allowed; an identical rerun requires a '
          + 'real executor-observed change.',
        'diagnostic mode after executor timeout',
      ));
    } else if (totalTokens !== undefined && totalTokens >= state.config.compactTokens && !state.compactNoticed) {
      state.compactNoticed = true;
      injected.push(notice(
        'CONTEXT BUDGET: approximately ' + totalTokens
          + ' tokens are active. Automatic DSH compaction is due now. Preserve '
          + 'only the current objective, constraints, completed work, changed '
          + 'files, relevant results, unresolved errors, failed attempts, and '
          + 'one concrete next step.',
        'context compact due (~' + totalTokens + ' tokens)',
      ));
    } else if (totalTokens !== undefined && totalTokens >= state.config.checkpointTokens && !state.checkpointNoticed) {
      state.checkpointNoticed = true;
      injected.push(notice(
        'CONTEXT BUDGET: approximately ' + totalTokens
          + ' tokens. Stop rereading unchanged material and capture the failed '
          + 'approach plus the next concrete step before compaction.',
        'checkpoint preparation (~' + totalTokens + ' tokens)',
      ));
    } else if (totalTokens !== undefined && totalTokens >= state.config.economyTokens && !state.economyNoticed) {
      state.economyNoticed = true;
      injected.push(notice(
        'CONTEXT BUDGET: approximately ' + totalTokens
          + ' tokens. Use targeted excerpts, bounded outputs, diffs, and recent '
          + 'results; do not reread unchanged files or repeat prior investigation.',
        'economy mode (~' + totalTokens + ' tokens)',
      ));
    }

    // tokenUsage is intentionally only observed here; it never resets the
    // global call, time, or token budgets.
    void tokenUsage;
    return injected.length > 0
      ? { ...decision, messages: [...decision.messages, ...injected] }
      : decision;
  });

  ctx.on('agent/request', async ({ agent }, next) => {
    const resolved = await next();
    if (!agent) return resolved;
    const state = stateFor(agent);
    if (state.config.responseMaxTokens === undefined) return resolved;
    return { ...resolved, maxTokens: Math.min(resolved.maxTokens ?? state.config.responseMaxTokens, state.config.responseMaxTokens) };
  });

  ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    const state = states.get(agent);
    if (!state || state.currentTurn !== turn) return;
    state.turnActive = false;
    clearTurnTimers(state);
  });

  ctx.on('agent/disposed', ({ agent }) => {
    const state = states.get(agent);
    if (!state) return;
    clearTurnTimers(state);
    state.compactionController?.abort(new Error('agent disposed during checkpoint'));
    delete agent[CHECKPOINT_POLICY];
    states.delete(agent);
  });

  // Keep the session-owned execution state available for an agent reconnect;
  // release it only when the durable session itself is disposed.
  ctx.on('session/disposed', (session) => {
    const sessionId = session?.id;
    if (sessionId !== undefined) sessionStates.delete(String(sessionId));
  });
}
