# Vertex2OpenAI on Cloudflare Workers

**v2.1.1** — OpenAI-compatible Chat Completions and Responses for Vertex AI Gemini, with no runtime dependencies. Use your own adapter key in clients; the Worker manages Vertex credentials and token refresh.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/workHMZ/vertex2openai-cf)

## What changed since v1.0?

These are cumulative v2.x changes; v1.0 already supported Chat Completions, streaming, tools, reasoning, search, images and both credential types.

| Area | v1.0 | v2.1.1 |
| --- | --- | --- |
| APIs | Chat Completions and model listing | Adds `/v1/responses`, including typed streaming events, tools and reasoning |
| Models | Gemini 2.x and 3.x | **Gemini 3+ only**; configurable model list and capability-aware variants |
| Credentials | Express keys and service accounts | Rotation and failover across both credential pools; 429, 5xx and network failures can try the next credential |
| Tool calls and schemas | Basic conversion | Gemini 3 thought-signature round trips; native JSON Schema support for `$ref`, `$defs` and nullable unions |
| Images | Image variants | Always uses native Vertex, including with service accounts; removes unsupported image/search combinations |
| Streaming | Basic SSE translation | Linear SSE parsing, correct usage and finish states; truncated, malformed and failed streams no longer look successful |
| Request handling | Basic validation | `developer` instructions on both routes, invalid body shapes return 400, unique Responses/item IDs |
| Verification | No automated suite in the v1.0 tag | 284 unit tests, coverage gates, CPU benchmarks and real Vertex E2E tests |

**New in v2.1.1:** fixes Responses error/truncation handling and output snapshots, malformed request handling, `developer` messages and ID collisions. Responses streaming skips an intermediate SSE encode/parse step: **about 18% less CPU in the local pipeline benchmark**. [Full changes](https://github.com/workHMZ/vertex2openai-cf/compare/v2.1.0...v2.1.1).

## Quick start

Requires Node.js 20+ and npm; use Node 22.18+ for test coverage checks.

```bash
git clone https://github.com/workHMZ/vertex2openai-cf.git
cd vertex2openai-cf
npm ci
npm run verify
npx wrangler secret put API_KEY                  # strong, random adapter key
npx wrangler secret put GOOGLE_CREDENTIALS_JSON  # service account JSON on one line
npx wrangler deploy
```

For Express authentication, set `VERTEX_EXPRESS_API_KEY` instead of `GOOGLE_CREDENTIALS_JSON`. The interactive `npm run deploy` helper can configure the adapter key and Express key, then deploy.

| Client setting | Value |
| --- | --- |
| Base URL | `https://vertex2openai.<subdomain>.workers.dev/v1` |
| API key | Your `API_KEY` |
| Model | For example, `gemini-3.8-flash`; query `/v1/models` for configured variants |

```bash
curl https://your-worker.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"gemini-3.8-flash","messages":[{"role":"user","content":"Hi"}]}'
```

To upgrade an existing installation: `git pull --ff-only`, `npm ci`, `npm run verify`, then `npx wrangler deploy`. No new secrets or migrations are required from v2.1.0. From v1.0, replace Gemini 2.x IDs and review the limits below.

## Workers Free plan: read before deploying

**Text often fits; images do not reliably fit, even at the default size.** CPU time measures the Worker's processing, not time spent waiting for Vertex. A request taking several minutes can still use only a few milliseconds of CPU.

| Limit | Workers Free | What it means here |
| --- | --- | --- |
| CPU | **10 ms per request** | Some streamed text and cold service-account authentication exceed it; sustained overruns can terminate requests with Error 1102 |
| Requests | 100,000/day **per account**, resets at 00:00 UTC | Shared across Workers on the account |
| Memory | 128 MB **per isolate** | Concurrent requests share it; large base64 images and repeated snapshots increase pressure |
| Subrequests | 50 per request | Upstream attempts and authentication requests consume this budget |
| Variable/secret size | 5 KB each | Multiple service-account JSON keys must fit the total serialized size; do not assume a fixed key count |

Limits checked against [Cloudflare's official documentation](https://developers.cloudflare.com/workers/platform/limits/) on 2026-09-27. Workers Paid defaults to **30 seconds of CPU** per request (configurable up to 5 minutes); this is separate from Vertex billing and quotas.

**Actual Cloudflare CPU**, measured with `wrangler tail` on **v2.1.0, 2026-09-24**:

| Request | CPU time | Compared with Free's 10 ms |
| --- | ---: | --- |
| Text, non-streaming | 2–6 ms | Within the measured budget |
| Chat or Responses text, streaming | 3–12 ms | Can exceed it |
| First service-account request on a fresh isolate | ~16 ms | Exceeds it; OAuth token is then cached until refresh |
| Default image, 2.9 MB base64, non-streaming | ~36 ms | Exceeds it |
| Same image, streaming | ~100 ms | Exceeds it |

Use **Workers Paid and non-streaming requests for image generation**. A previous 4K sample produced a ~54 MB HTTP response; Paid does not raise the isolate's 128 MB memory limit or fix Vertex 429 errors. Occasional successful over-budget Free requests are not a reliability guarantee. v2.1.1's local optimization has **not** been remeasured on production Cloudflare; [historical measurements and methodology](docs/testing.md#historical-measurements) are retained separately.

## Configuration and API

Set secrets with `wrangler secret put`; `API_KEY` plus at least one Vertex credential is required.

| Setting | Purpose |
| --- | --- |
| `API_KEY` | Protects the adapter and access to your Vertex billing account |
| `GOOGLE_CREDENTIALS_JSON` | One service-account JSON object, or comma-separated objects |
| `VERTEX_EXPRESS_API_KEY` / `VERTEX_API_KEY` | Express API key(s), comma-separated; the second name is an alias |
| `GCP_LOCATION` | Plain variable in `wrangler.toml`; defaults to `global` |
| `GCP_PROJECT_ID` | Optional project override; otherwise read from the service-account key |
| `MODELS_CONFIG` | Optional JSON with `vertex_models` and `vertex_express_models` arrays; defaults to [`src/models.json`](src/models.json) |

`GET /` is an unauthenticated health check. `/v1/models`, `/v1/chat/completions` and `/v1/responses` require `Authorization: Bearer <API_KEY>`.

| Model option | Behavior |
| --- | --- |
| `[EXPRESS] ` / `[PAY] ` prefix | Pin Express / service-account credentials; without a prefix, prefer Express and fall back to service accounts |
| `-search` | Google Search grounding on text models |
| `-nothinking` / `-max` | Lowest / highest supported thinking level |
| `-2k` / `-4k` | Image resolution; image models use only size variants |
| `-openai` / `-openaisearch` | Force the OpenAI-compatible endpoint; service-account text models only |

| Feature | Chat Completions | Responses |
| --- | --- | --- |
| Input | `messages` | `input`, with optional `instructions` |
| Output limit | `max_tokens` | `max_output_tokens` |
| Thinking | `reasoning_effort` | `reasoning.effort` |
| JSON Schema | `response_format` | `text.format` |
| Tools | `tool_calls` / `tool` messages | `function_call` / `function_call_output` items |
| Reasoning output | `reasoning_content` | `reasoning` items |

Thinking accepts `none`, `minimal`, `low`, `medium`, `high`, `xhigh` and `max`; the last two map to `high`. Model-specific adjustments live in [`src/model-capabilities.ts`](src/model-capabilities.ts): for example, `gemini-3.8-flash` maps minimal thinking to low and drops unsupported frequency/presence penalties.

## Compatibility notes

- **Credentials:** ordinary, unbound GCP API keys are not Express keys. Use an Express signup key, a key bound to a service account with Vertex permissions, or service-account JSON. Keep keys out of Git and use a strong adapter key.
- **Tools:** preserve `thought_signature` on returned calls for Gemini 3 reasoning continuity. Incoming `thoughtSignature` and `extra_content.google.thought_signature` also work. If a client strips signatures, the adapter supplies Vertex's validation placeholder.
- **Responses is stateless:** send the full history in `input`. `previous_response_id` and `conversation` return 400; stored responses, GET/DELETE by ID and OpenAI-hosted tools are unsupported. Use `-search` for grounding.
- **Stream endings:** token limits/content filtering produce `response.incomplete`; upstream errors, malformed frames and missing finish reasons produce `response.failed`, retaining partial output. Chat reports upstream failures as an error frame before `[DONE]`. Clients should check terminal status.
- **Timeouts and billing:** under throttling, successful streams historically began after 36, 143 or 184 seconds (normally 2–4 seconds). The adapter waits up to **300 seconds per credential**; allow a longer client read timeout if using failover. Thinking tokens count toward billed output and are included in completion-token usage.
- **Safety:** the adapter currently sends `BLOCK_NONE` for the four configured harm categories; review [`buildSafetySettings`](src/converters/request.ts) for your application.

## Tests and development

| Validation, 2026-09-27 | Result | Elapsed time |
| --- | --- | ---: |
| `npm run verify` | Typecheck + **284/284** unit tests; coverage 99.84% lines / 93.21% branches / 100% functions | **0.69 s** |
| Linux workerd + real Vertex, full E2E | **25/26** passed, no timeouts/skips; SA image request returned upstream 429 | **331.84 s (5m 31.84s)** |
| Final affected E2E rerun | Responses **6/6** passed; SA image still 429 | **183.55 s (3m 3.55s)** |
| Direct Vertex check, bypassing Worker | Same SA image request returned `429 RESOURCE_EXHAUSTED` | **0.19 s** |

E2E counts are **scenarios**, often containing several requests across both credential types. SA image generation remains unverified end to end; Express image generation passed in non-streaming, Chat streaming and Responses streaming modes. [Detailed timings, local CPU results and historical test data](docs/testing.md) include the scope of each measurement.

```bash
npm run dev       # local Worker; secrets in .dev.vars, restart after editing them
npm run verify    # typecheck, all unit tests and coverage gates
npm run bench     # local synthetic CPU benchmark, no real Vertex calls
```

Real E2E calls incur Vertex charges. See [test instructions](test/README.md) for credentials, route enforcement and the optional image skip.

Inspired by [gzzhongqi/vertex2openai](https://github.com/gzzhongqi/vertex2openai). [MIT License](LICENSE).
