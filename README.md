# dsh-searxng

Unofficial SearXNG search-provider plugin for DeepSeek Harness (DSH), independently maintained by **xoykor**. Not affiliated with or endorsed by DeepSeek.

The plugin registers a `searxng` provider with DSH's web service and sends searches to a configurable SearXNG instance. The default endpoint is `http://127.0.0.1:8888`.

## Requirements

- DeepSeek Harness with the web service available.
- A reachable SearXNG instance.
- JSON output enabled on the SearXNG server.

The plugin does not install or launch SearXNG.

## Installation

Clone the repository and add it to the desired DSH profile:

```sh
git clone https://github.com/xoykor/dsh-searxng.git
cd dsh-searxng
dsh plugin --profile web add "$(pwd)"
```

Inspect `cordis.patch.yml` and the effective profile configuration before restarting DSH. Select `searxng` as the web-search provider if necessary.

The loader's `baseURL` option can point to a different SearXNG endpoint. `maxResults` is sent as a server hint; this adapter does not guarantee a client-side result cap or detect server-side truncation.

## Tests

With a recent Node.js version:

```sh
npm test
```

The tests mock HTTP transport and cover provider registration, query encoding, result mapping, HTTP failures and cancellation. They are not a live SearXNG end-to-end certification.

## Provenance

Originally extracted from xoykor's DSH configuration/backup and subsequently published as a standalone plugin. Maintained with AI-assisted development and review.
