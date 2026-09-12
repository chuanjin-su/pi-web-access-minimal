# pi-web-access-minimal

Minimal web search + URL fetching for the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent). A stripped-down alternative to [pi-web-access](https://github.com/nicobailon/pi-web-access) that keeps only the two core tools — measuring ~37% fewer tokens per search turn than pi-web-access thanks to its smaller tool context.

- **`web_search`** — search via OpenAI (Responses API / Codex), Brave Search API, or Exa (keyless MCP — works with no API key at all). Returns an AI-synthesized answer with source citations. The provider is **resolved from your config, automatically** — the agent never picks one, which keeps tool descriptions (and token usage) small.
- **`fetch_content`** — fetch URLs and extract readable content as markdown. Supports raw HTTP bodies (`mode: "raw"`), page-local Q&A (`mode: "answer"`), direct images, GitHub repositories, and PDFs. Large content is **paged** via an `offset` parameter instead of a third retrieval tool.

No curator, no summary workflow, no multi-provider "all" mode, no background turn triggering.

## Install

```sh
pi install npm:pi-web-access-minimal
```

Also available from source (pinned releases under [Releases](https://github.com/chuanjin-su/pi-web-access-minimal/releases)):

```sh
pi install git:github.com/chuanjin-su/pi-web-access-minimal
# or pin the release:
pi install git:github.com/chuanjin-su/pi-web-access-minimal@v0.1.0
```

To try it without installing:

```sh
pi -e npm:pi-web-access-minimal
```

## Configure

Create `~/.pi/agent/web-search.json`:

```json
{
  "searchProvider": "brave"
}
```

All keys are optional — provider auth falls back to environment variables, and credential values accept `$ENV_VAR`, `!command`, or `$$literal` prefixes.

**Search**

| Key | Meaning |
|---|---|
| `searchProvider` | `"openai"`, `"brave"`, or `"exa"`. When set and its credentials exist, that provider is used; otherwise automatic fallback (openai → brave → exa) by credential availability. Exa is always available via its keyless MCP endpoint, so it is the zero-config default. |
| `openaiApiKey` | OpenAI API key. Falls back to `OPENAI_API_KEY`, or a Codex subscription via `/login`. |
| `braveApiKey` | Brave Search API key. Falls back to `BRAVE_API_KEY`. |
| `exaApiKey` | Exa API key (optional — keyless MCP search works without it, the API key removes rate limits). Falls back to `EXA_API_KEY`. |
| `openaiResponsesUrl` / `openaiSearchModel` / `openaiSearchProviders` | Advanced OpenAI Responses endpoint/model routing. |
| `braveBaseUrl` / `exaBaseUrl` | Override API base URLs (self-hosted/proxy); also read from `BRAVE_BASE_URL` / `EXA_BASE_URL`. |

**Fetching**

| Key | Meaning |
|---|---|
| `proxy` | HTTP(S)/SOCKS proxy URL for all outbound requests (direct access is blocked in many sandboxes). |
| `maxInlineContentChars` | First-slice size for fetched content (default `30000`, max `200000`). |
| `fetch.timeout` | HTTP fetch timeout in seconds (default 30). |
| `fetch.answerProvider` / `fetch.answerModel` | Model used by `fetch_content` `mode: "answer"` (defaults to the current Pi model). |
| `fetchContent.domainPolicy` | `{ "allow": [...], "deny": [...] }` hostname lists restricting what `fetch_content` may access. |
| `ssrf.allowRanges` / `ssrf.trustEnvProxy` | SSRF protections: explicitly allowed private IP ranges; whether the `proxy` may target private addresses. |
| `authFetch` | Browser-cookie authenticated fetch profiles, keyed by name: `{ "<name>": { "hosts": [...], "redirects": "same-origin", "cache": "session" \| "off", "chromeProfile": "Default" } }`. Used via the `auth` parameter. |
| `image.enabled` | Set `false` to disable image fetching. |

**PDFs**

| Key | Meaning |
|---|---|
| `pdf.enabled` | Set `false` to reject PDF URLs. |
| `pdf.provider` | `"auto"` (default) or `"unpdf"` (local extraction). |
| `pdf.maxSizeMB` / `pdf.maxPages` | PDF size and page-count limits (defaults `20` MB / `100` pages). |

If a request fails at the configured provider, `web_search` automatically retries the remaining providers (exa is always available) before surfacing an error.

## Content paging

`fetch_content` inlines at most `maxInlineContentChars` per result. When truncated, the result tells the agent to call again:

```
fetch_content({ url: "https://example.com/long-page", offset: 30000 })
```

Full content is cached in memory per session (keyed by URL, FIFO eviction at 50 entries). If `auth` is used with `cache: "off"`, nothing is cached and the agent must re-fetch instead.

## Differences from pi-web-access

Dropped: curator browser UI + summary review, `source_check`, `get_search_content` (replaced by the `offset` parameter), YouTube/local-video analysis, and the remaining search providers and third-party fetch backends (Parallel, TinyFish, Firecrawl, Jina Reader, Crawl4AI, Gemini web, …). PDFs use the local `unpdf` extractor. Kept near-verbatim: `openai-search.ts`, `brave.ts`, `exa.ts` (minus its inline-content handling, which the `offset` paging flow replaces), and the HTTP/GitHub/PDF extraction pipeline, so targeted upstream fixes can be ported easily.

## Adding a provider later

1. Drop `<provider>.ts` into `src/providers/` (copy one from pi-web-access).
2. Add the id to `SearchProviderId` / `SEARCH_PROVIDERS` in `src/providers/types.ts`.
3. Wire two lines into `src/providers/search.ts` (`isProviderAvailable` + the dispatch in `search()`).
4. Optionally accept it in `searchProvider` validation in `src/config.ts`.

## Development

```sh
npm install
npx tsc        # typecheck
npm test       # node --test
```

MIT (© 2026 Chuanjin Su; provider/extraction code adapted from pi-web-access, MIT © Nico Bailon).
