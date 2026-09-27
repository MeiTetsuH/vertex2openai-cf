# Validation and performance history

This record preserves measurements from v1.x through v2.1.1. **Wall time, local CPU and Cloudflare CPU are different measurements.** Historical values are not a controlled cross-version benchmark. See the [README](../README.md#workers-free-plan-read-before-deploying) for current deployment guidance.

## Production follow-up — 2026-09-27

v2.1.1 was subsequently deployed to Cloudflare from the released source. The deployment fork was fast-forwarded to the same commit; production variables and secrets were preserved. This installation has **service-account credentials only**, so production results cover that configured route. Express coverage remains the earlier Linux evidence below.

| Production check | Result | Elapsed wall time |
| --- | --- | ---: |
| Predeployment `npm run verify` | Typecheck and 284/284 unit tests passed | 0.83 s |
| Routing, authentication and input validation | 7/7 passed | 0.25 s |
| Chat Completions | 12/12 passed | 110.62 s |
| Image generation: Chat non-streaming, Chat streaming, Responses streaming | Passed all three modes | 64.38 s |
| Responses | 6/6 passed | 19.67 s |
| **Complete production E2E runner** | **26/26 passed; 0 failed, 0 cancelled, 0 skipped** | **194.98 s (3m 14.98s)** |
| Runner including the outer process wrapper | Exit code 0 | 195.01 s |

The run made **50 HTTP requests**, all matched to production log entries with `outcome: ok` and no runtime exceptions. Four upstream 429 responses recovered through the test client's existing backoff: one during image-input chat, three during Responses image generation. Expected 400/401/404/405 checks are included in the request count. A green scenario suite therefore does not mean every HTTP attempt was 200 or that Vertex capacity is guaranteed.

The earlier Linux SA image failure remains in the historical record; this later production run **successfully verifies SA image generation end to end**. It does not change the earlier run's 25/26 result. No new production credentials were created. The log collector stopped after the run and retained only request IDs, endpoint paths, model/stream labels, status and timing metadata, without authorization headers or bodies.

### Production CPU and request time

CPU and wall time below come directly from `wrangler tail`, joined to each test request. Only successful model requests are included. Text uses `gemini-3.8-flash`; images use `gemini-3.1-flash-lite-image` with a simple red-circle prompt.

| Successful request | Samples | CPU range | Median CPU | Worker wall-time range |
| --- | ---: | ---: | ---: | ---: |
| Chat text, non-streaming | 17 | 1–7 ms | 1 ms | 1.24–20.15 s |
| Chat text, streaming | 3 | 3–10 ms | 5 ms | 1.61–2.63 s |
| Responses text, non-streaming | 5 | 1–4 ms | 2 ms | 0.98–4.86 s |
| Responses text, streaming | 3 | 5–17 ms | 5 ms | 1.80–3.32 s |
| Image, Chat non-streaming | 1 | 4 ms | 4 ms | 2.57 s |
| Image, Chat streaming | 1 | 11 ms | 11 ms | 2.69 s |
| Image, Responses streaming | 1 | 14 ms | 14 ms | 2.99 s |

Image response byte sizes were not captured. Each image row is one successful Flash-Lite sample, **not the historical 2.9 MB fixture**, and cannot establish a cross-version speedup. CPU includes the work done for that request; cold-token/connection effects were not isolated. Streaming samples still exceed Free's 10 ms budget even though this run completed without runtime errors.

Deployment build: **82.18 KiB**, **19.26 KiB gzipped**, with **1 ms startup time** reported by Wrangler.

### Individual production scenario timings

Durations include all calls and retry waits within each scenario.

| Scenario | Wall time |
| --- | ---: |
| Invalid JSON shapes | 0.103 s |
| Health without authentication | 0.011 s |
| Missing/wrong adapter key | 0.021 s |
| Unknown routes and wrong methods, with CORS | 0.022 s |
| OpenAI SDK CORS preflight | 0.011 s |
| Model-list validation | 0.00038 s |
| Gemini 2 rejection | 0.012 s |
| Chat plain text | 2.96 s |
| Chat streaming | 2.64 s |
| Chat truncation, streaming and non-streaming | 7.53 s |
| `-max` / `-nothinking` | 6.55 s |
| Developer instructions and multi-turn chat | 1.29 s |
| Tool/signature round trip | 4.63 s |
| Streamed tool calls | 1.98 s |
| `tool_choice`: none and named function | 2.81 s |
| Structured JSON output | 3.01 s |
| Strict tool schema | 3.15 s |
| Inline and URL image input, including one recovered 429 | 66.77 s |
| Search grounding | 7.31 s |
| Image output in all three modes, including three recovered 429s | 64.38 s |
| Responses plain text | 1.02 s |
| Responses streaming | 3.33 s |
| Responses truncation | 7.00 s |
| Responses tool round trip | 6.72 s |
| Responses `text.format` schema | 1.58 s |
| Responses `previous_response_id` rejection | 0.020 s |

## v2.1.1 predeployment validation — 2026-09-27

Local checks used Node.js 24.21.0. Live tests used Node.js 24.18.0 on a Linux development machine, the repository's locked workerd runtime and compatibility date `2026-09-03`. Text: `gemini-3.8-flash`; images: `gemini-3.1-flash-lite-image`. Both Express and service-account credentials were required.

The full E2E run tested the streaming, validation and performance changes. A final affected rerun covered Responses and images after the last output-item ID/snapshot fixes. The release gate below ran against the final source and v2.1.1 package version. The new code was tested locally and in Linux workerd; these are **not v2.1.1 production Cloudflare measurements**.

| Check | Result | Elapsed wall time | Measurement scope |
| --- | --- | ---: | --- |
| Release `npm run verify` | Typecheck passed; **284/284** unit tests passed | **0.69 s** | Complete command, timed with a monotonic clock; dependencies already installed |
| Unit runner inside that gate | 284 passed; no failures, cancellations or skips | **0.27 s** | Node's `duration_ms`, excluding npm/typecheck startup |
| Earlier full unit run | 284/284 passed | **0.38 s** | Node runner only; retained for comparison |
| Linux workerd, full real E2E | **25 passed / 26 scenarios**, 1 failed, 0 cancelled, 0 skipped | **331.84 s (5m 31.84s)** | Includes real upstream latency and retries |
| Final affected E2E rerun | Responses 6/6 passed; image scenario failed | **183.55 s (3m 3.55s)** | 7 scenarios total; remaining failure is SA image 429 |
| Direct Vertex image probe | Same SA and request body also returned `429 RESOURCE_EXHAUSTED` | **0.19 s** | Bypassed the Worker |

Coverage: **99.84% lines, 93.21% branches, 100% functions**. Enforced gates: 99%, 90%, 100% respectively. `npm run bench` and `git diff --check` also passed.

The image failure is an upstream capacity/quota response, reproducible without the adapter. Express image generation passed in non-streaming, Chat streaming and Responses streaming modes, with some 429 retries. **At that point, SA image generation still needed a successful end-to-end run**; 25/26 was not a fully green live suite. The subsequent production run above passed, while this earlier result is retained unchanged. Google's [429 troubleshooting documentation](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/deploy/error-code-429) describes capacity/quota causes and retry guidance.

The isolated reruns used IPv4 outbound connectivity for the test process only. An earlier run with default networking encountered long waits and timeouts; the IPv4 run completed without test timeouts, but this alone does not establish the cause. Temporary SA/API keys, isolated test files and processes were removed after testing; existing credentials were preserved.

### Full real E2E timings

These are **scenario durations**, not per-request latency or CPU. A scenario can issue multiple requests across both credential types and include retry backoff. Suite totals include their own overhead; rounding can prevent exact addition.

| Suite | Result | Wall time |
| --- | --- | ---: |
| Routing, authentication and validation | 7/7 passed | 0.18 s |
| Chat Completions | 12/12 passed | 179.83 s |
| Image generation | Failed on SA upstream 429 | 103.50 s |
| Responses | 6/6 passed | 48.09 s |
| **Complete runner** | **25/26 passed** | **331.84 s** |

| Chat scenario | Wall time |
| --- | ---: |
| Plain text | 4.90 s |
| Streaming text | 6.06 s |
| Token-limit truncation, streaming and non-streaming | 45.56 s |
| `-max` / `-nothinking` | 20.88 s |
| Developer instructions and multi-turn chat | 8.05 s |
| Tool call and thought-signature round trip | 19.70 s |
| Streamed tool calls | 9.88 s |
| `tool_choice`: none and named tool | 10.51 s |
| Structured JSON output | 9.08 s |
| Strict tool definitions | 5.16 s |
| Image input: inline and URL | 26.45 s |
| Search grounding | 13.59 s |

| Responses scenario | Full run | Final affected rerun |
| --- | ---: | ---: |
| Plain text | 4.10 s | 3.18 s |
| Streaming text | 5.88 s | 5.71 s |
| Token-limit truncation | 20.62 s | 21.86 s |
| Tool round trip | 13.16 s | 42.39 s |
| `text.format` schema | 4.32 s | 6.45 s |
| Reject `previous_response_id` | 0.013 s | 0.012 s |
| **Responses suite, 6/6 passed** | **48.09 s** | **79.60 s** |
| Image scenario, SA 429 | 103.50 s | 103.66 s |
| **Runner total** | **331.84 s, all suites** | **183.55 s, Responses + images** |

## v2.1.1 local CPU benchmarks

`npm run bench` feeds synthetic upstream replies through the Worker handlers on local Node, with streamed data split into 4 KB chunks. These are median local CPU times, excluding a real Vertex network call. The script also prints a historical **×7 projection**; it is a heuristic, not a Cloudflare measurement or a Free-plan guarantee. Only measured local values are reproduced here.

| Request | Median local CPU |
| --- | ---: |
| Text, native endpoint, non-streaming | 0.24 ms |
| Text, native endpoint, streaming | 0.28 ms |
| Text, OpenAI-compatible endpoint, non-streaming | 0.15 ms |
| Text, OpenAI-compatible endpoint, streaming | 0.32 ms |
| Responses text, streaming | 0.42 ms |
| 40-turn tool history, request side | 0.29 ms |
| Default/1K image, ~2.9 MB base64, non-streaming | 7.93 ms |
| Default/1K image, Chat streaming | 4.72 ms |
| Default/1K image, Responses streaming | 25.88 ms |
| 2K image, ~11.6 MB base64, non-streaming | 28.73 ms |

A separate paired experiment isolates the **Responses conversion pipeline**, using 2,900,000 base64 bytes, 4 KB chunks and 24 alternating sample pairs in the same Node process:

| Pipeline | Median CPU | Output bytes |
| --- | ---: | ---: |
| Intermediate Chat SSE encode → parse → Responses | 16.782 ms | 17,403,850 |
| Direct normalized objects → Responses | 13.768 ms | 17,403,850 |
| **CPU reduction** | **17.96% (~18%)** | Same byte count |

The paired experiment excludes the rest of the Worker handler, so its 13.768 ms is not directly comparable to the 25.88 ms full-handler measurement. Responses delta, item and final response events still repeat image data; removing the intermediate conversion does not eliminate large output or make streamed images fit Workers Free.

## Historical measurements

The following numbers are retained from earlier committed READMEs and Releases. Local fixtures, machines and measurement scopes differ. **Earlier claims that default-size images fit Free were superseded by the 2026-09-24 Cloudflare measurements.** The legacy estimate of 50–130 ms did not specify a reproducible fixture and must not be used as a matched performance baseline.

| Version / source | Environment and scope | Recorded measurement |
| --- | --- | --- |
| [v1.0.0 README][v1] | Initial release | No recorded test duration or CPU benchmark |
| [Post-v1.0 README][legacy] | Legacy estimate; measurement method unspecified | Image JSON parsing/conversion: **50–130 ms CPU** |
| [v2.0.0 README][v2] | Local text conversion only | **~0.01 ms CPU** |
| [v2.0.0 README][v2] | Local workerd, real default image reply, 2.9 MB base64 | **1.9 ms CPU** |
| [v2.0.0 README][v2] | Local workerd, 2K image, 11.6 MB base64 | **8.5 ms CPU** |
| [v2.0.0 README][v2] | Local workerd, 4K image, 36.1 MB base64 | **31 ms CPU**; ~54 MB HTTP response |
| [v2.0.1 Release][v201] | Live native image generation after routing fix | **1.46 MB reply**; **211 unit tests** passed; elapsed time not recorded |
| [v2.1.0 tagged README][v21] | Local text, streaming and non-streaming | **0.1–0.5 ms CPU** |
| [v2.1.0 tagged README][v21] | Local default image, 2.9 MB, streaming/non-streaming | **~5 ms CPU** |
| [v2.1.0 tagged README][v21] | Local 2K image, 11.6 MB | **~18 ms CPU** |
| [v2.1.0 tagged README][v21] | Old repeated SSE line scanning, 2.9 MB image | **90+ ms CPU** before linear parsing |
| [Later README correction][correction] | Same old parsing issue on a slower machine | Up to **8 seconds CPU**; a different environment from the 90 ms report |
| [v2.1.0 tagged README][v21] | Initial Cloudflare text sample | **2–4 ms CPU**; first SA request **~16 ms** |
| [v2.1.0 Release][v210] | Cloudflare text CPU range in the release summary | **2–10 ms CPU**; the later README separates streaming and non-streaming samples |
| [v2.1.0 Release][v210] | Separate small-image SSE sample on Cloudflare, before/after linear parsing | **123 → 23 ms CPU**; different payload from the default image below |
| [v2.1.0 Release][v210] | Unit and real Vertex E2E suites | **272 unit tests**, **25/25 E2E**; total elapsed times not recorded |
| [v2.0.0][v2] / [v2.1.0][v21] READMEs | Historical Worker bundle size | **75 KiB**, **17 KiB gzipped**; not a v2.1.1 build measurement |
| [v2.1.0 tagged README][v21] | Upstream stream-start wall time | Normally **2–4 s**; successful throttled samples **36 / 143 / 184 s**; timeout **300 s per credential** |

### Cloudflare production CPU — 2026-09-24

These corrected v2.1.0 measurements came from `wrangler tail` request `cpuTime`, as recorded in [commit a5a1972][correction], which is **after the v2.1.0 tag**. They are retained as the historical baseline; the v2.1.1 production follow-up above uses different live samples.

| Request | Cloudflare CPU |
| --- | ---: |
| Text, non-streaming | 2–6 ms |
| Chat or Responses text, streaming | 3–12 ms |
| First service-account request on a fresh isolate, before cached OAuth token | ~16 ms |
| Default image, 2.9 MB base64, non-streaming | ~36 ms |
| Same image, streaming | ~100 ms |

CPU time does not include network waiting. See [Cloudflare's limits](https://developers.cloudflare.com/workers/platform/limits/) for CPU, memory and request budgets. For the later v2.1.1 samples, see the production follow-up above; the fixtures differ.

[v1]: https://github.com/workHMZ/vertex2openai-cf/blob/v1.0.0/README.md
[legacy]: https://github.com/workHMZ/vertex2openai-cf/blob/ea482a2/README.md
[v2]: https://github.com/workHMZ/vertex2openai-cf/blob/v2.0.0/README.md
[v201]: https://github.com/workHMZ/vertex2openai-cf/releases/tag/v2.0.1
[v21]: https://github.com/workHMZ/vertex2openai-cf/blob/v2.1.0/README.md
[v210]: https://github.com/workHMZ/vertex2openai-cf/releases/tag/v2.1.0
[correction]: https://github.com/workHMZ/vertex2openai-cf/blob/a5a1972/README.md
