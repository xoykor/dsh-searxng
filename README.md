# xoykor DSH community plugins

Unofficial, independently maintained by **xoykor**. Not affiliated with or endorsed by DeepSeek. Extracted from my [DSH backup](https://github.com/xoykor/DSH-Backup/tree/459c29632232998ac10642355629dae1aaccac0b). Experimental; reviewed against a locally patched DSH 0.1.5-rc.2 installation, not certified against upstream master.

## Packages

- `packages/context-guard`: deterministic context-pressure notices, repeated-tool/no-progress checks, and configurable execution budgets. Explicit `null` disables the step, tool-call or elapsed-time ceiling; this is opt-in, not the default. Loop and failure checks remain enabled.
- `packages/searxng`: registers a `searxng` search provider with DSH's `web` service. Queries are sent only to the configured SearXNG endpoint; default `http://127.0.0.1:8888`. The SearXNG instance must allow JSON responses.

These are DSH/Cordis plugins, not Codex plugins. No personal sessions, authentication material, models or third-party plugins are bundled. Packages are published as GitHub source, not on npm.

## Installation

Clone this repository and, from its root, install the desired package into your DSH profile:

```sh
dsh plugin --profile web add "$(pwd)/packages/context-guard"
dsh plugin --profile web add "$(pwd)/packages/searxng"
```

Inspect the included `cordis.patch.yml` files and your effective profile configuration before restarting DSH. The SearXNG plugin registers a provider; select `searxng` in your web-search configuration if it is not already selected. Set `baseURL` on its loader entry to change the endpoint. It does not launch SearXNG or enable JSON on the server for you. `maxResults` is passed as a server hint; the current adapter does not guarantee a client-side cap and cannot detect server-side truncation.

## Context guard compatibility and configuration

The guard injects `tools`, `tokenMeter`, and `compaction`; these services must exist. Default limits remain 48 calls, 48 steps and 900000 ms. Defaults are not suitable for every model context size; inspect the source's threshold settings before enabling.

Example loader entry configuration for sustained productive work:

```yaml
config:
  maxTurnSteps: null
  maxTurnToolCalls: null
  maxTurnMs: null
```

Unlimited execution can consume unbounded time and provider credits. Cancellation, permission checks, and no-progress safeguards still matter.

**Advanced checkpoint mode is not a drop-in upstream feature.** Setting `contextWindow` and reserve fields requires the matching custom `checkpointNow` runtime patch from my backup. Without it, the guard fails closed. Managed-job observation exemptions similarly require the custom executor capability, and automatic goal-round resumption requires the compatible goal driver patch. Those patched third-party runtime artifacts are deliberately not bundled here. Base guard operation does not establish compatibility with every upstream release.

When upgrading, verify the code actually installed in each profile's `node_modules`: updating the source plugin directory alone may leave an old installed copy. An old validator rejects `null` and can prevent DSH startup. Back up your profile and verify service health beyond the initial process start.

## Tests

With Node.js 22+ (tested locally on Node.js 26):

```sh
npm test
```

Guard tests use simulated agent/services and exercise productive-call budgets, failed checkpoints, cancellation, and repeated checkpoint cycles. Search tests mock HTTP. They do **not** constitute real-model endurance tests or a live SearXNG end-to-end certification.

## Provenance

Maintained and published by xoykor with AI-assisted development/review. Third-party `dsh-verification`, vendored DSH goal code, and compiled runtime patches are not included or claimed as original plugins. No new license grant is declared in this extraction; contact the maintainer about reuse terms.
