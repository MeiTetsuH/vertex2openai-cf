// Real Vertex integration checks using an existing gcloud login. Credentials
// stay in memory on the machine running this script. This exercises the
// adapter's converters against both project-scoped APIs, not Express-key
// authentication, service-account token exchange, or a deployed Worker.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { parseModelName, buildVertexGenerateContentBody, buildOpenAICompatibleBody } from "../src/converters/request.ts";
import { processVertexResponse, processOpenAIResponse } from "../src/converters/response.ts";
import { createVertexStreamTransformer, createStreamTransformer } from "../src/converters/streaming.ts";
import { responsesRequestToChat, chatToResponse } from "../src/converters/responses.ts";
import { createResponsesStreamSink } from "../src/converters/responses-streaming.ts";
import { buildProjectGenerateContentUrl, buildOpenAIEndpointUrl } from "../src/vertex/client.ts";

const gcloud = (...args) => execFileSync("gcloud", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const project = process.env.GCP_PROJECT_ID || gcloud("config", "get-value", "project");
assert.ok(project && project !== "(unset)", "Select a GCP project before testing.");
const token = gcloud("auth", "print-access-token");
const opts = { authType: "service_account", projectId: project, location: "global" };
const results = [];
let requests = 0;

function request(overrides = {}) {
  return {
    model: "gemini-4-argon", messages: [{ role: "user", content: "Reply with exactly ARGON_OK." }],
    reasoning_effort: "none", max_tokens: 4096, n: 1,
    temperature: 0.2, top_p: 0.9, top_k: 20, frequency_penalty: 0, presence_penalty: 0,
    ...overrides,
  };
}

async function send(native, body, responsesRequest) {
  const info = parseModelName(body.model);
  const stream = Boolean(body.stream);
  const url = native ? buildProjectGenerateContentUrl(opts, info.baseModel, stream)
    : buildOpenAIEndpointUrl(opts, "/chat/completions");
  const payload = native ? buildVertexGenerateContentBody(body, info) : buildOpenAICompatibleBody(body, info);
  let res;
  for (let attempt = 0; ; attempt++) {
    requests++;
    res = await fetch(url, { method: "POST", headers: {
      Authorization: `Bearer ${token}`, "Content-Type": "application/json",
    }, body: JSON.stringify(payload), signal: AbortSignal.timeout(180_000) });
    if (![429, 503, 504].includes(res.status) || attempt === 2) break;
    console.log(JSON.stringify({ retry: attempt + 1, status: res.status }));
    await res.body?.cancel();
    await sleep(2000 * 2 ** attempt);
  }
  if (!res.ok) throw new Error(`Vertex ${res.status}: ${(await res.text()).slice(0, 800)}`);
  if (stream) {
    const sink = responsesRequest ? createResponsesStreamSink(responsesRequest, body.model) : undefined;
    const transformer = native ? createVertexStreamTransformer(body.model, sink) : createStreamTransformer(body.model, sink);
    const text = await new Response(res.body.pipeThrough(transformer)).text();
    return text.split("\n\n").filter(Boolean).map(block => {
      const lines = block.split("\n");
      const data = lines.find(line => line.startsWith("data: "))?.slice(6);
      return { event: lines.find(line => line.startsWith("event: "))?.slice(7),
        data: data === "[DONE]" ? data : JSON.parse(data) };
    });
  }
  const raw = await res.json();
  const completion = native ? processVertexResponse(raw, body.model) : processOpenAIResponse(raw, body.model);
  return responsesRequest ? chatToResponse(completion, responsesRequest) : completion;
}

function assertUsage(usage) {
  assert.ok(usage.prompt_tokens > 0);
  assert.ok(usage.completion_tokens > 0);
  assert.equal(usage.total_tokens, usage.prompt_tokens + usage.completion_tokens);
}

async function check(route, name, fn) {
  const start = performance.now();
  try {
    await fn();
    results.push({ route, name, status: "passed", seconds: +((performance.now() - start) / 1000).toFixed(2) });
  } catch (error) {
    results.push({ route, name, status: "failed", message: error.message });
  }
  console.log(JSON.stringify(results.at(-1)));
}

for (const native of [true, false]) {
  const route = native ? "project native GenerateContent" : "project OpenAI compatibility";
  await check(route, "chat: filtered parameters and lowest thinking", async () => {
    const result = await send(native, request());
    assert.match(result.choices[0].message.content, /ARGON_OK/);
    assert.equal(result.choices[0].finish_reason, "stop");
    assertUsage(result.usage);
  });
  await check(route, "chat: streaming nothinking suffix", async () => {
    const events = await send(native, request({ model: "gemini-4-argon-nothinking", stream: true, stream_options: { include_usage: true } }));
    assert.equal(events.filter(e => e.data === "[DONE]").length, 1);
    const chunks = events.filter(e => e.data !== "[DONE]").map(e => e.data);
    assert.ok(!chunks.some(c => c.error));
    assert.match(chunks.flatMap(c => c.choices ?? []).map(c => c.delta.content ?? "").join(""), /ARGON_OK/);
    assert.deepEqual(chunks.flatMap(c => c.choices ?? []).map(c => c.finish_reason).filter(Boolean), ["stop"]);
    assertUsage(chunks.findLast(c => c.usage)?.usage);
  });
  await check(route, "chat: max thinking suffix", async () => {
    const result = await send(native, request({ model: "gemini-4-argon-max", max_tokens: 8192 }));
    assert.match(result.choices[0].message.content, /ARGON_OK/);
    assert.equal(result.choices[0].finish_reason, "stop");
  });
  await check(route, "chat: structured output", async () => {
    const result = await send(native, request({ messages: [{ role: "user", content: 'Return ok=true and label="ARGON_OK".' }],
      response_format: { type: "json_schema", json_schema: { name: "probe", strict: true, schema: {
        type: "object", properties: { ok: { type: "boolean" }, label: { type: "string" } },
        required: ["ok", "label"], additionalProperties: false,
      } } } }));
    assert.deepEqual(JSON.parse(result.choices[0].message.content), { ok: true, label: "ARGON_OK" });
  });
  await check(route, "chat: signed tool round trip", async () => {
    const first = request({ messages: [{ role: "user", content: "Call lookup_code with label probe, then repeat the returned code exactly." }],
      tools: [{ type: "function", function: { name: "lookup_code", description: "Look up a test code", parameters: {
        type: "object", properties: { label: { type: "string" } }, required: ["label"], additionalProperties: false,
      } } }], tool_choice: { type: "function", function: { name: "lookup_code" } } });
    const result = await send(native, first);
    const message = result.choices[0].message;
    const calls = message.tool_calls;
    assert.equal(calls.length, 1);
    assert.equal(calls[0].function.name, "lookup_code");
    assert.deepEqual(JSON.parse(calls[0].function.arguments), { label: "probe" });
    assert.ok(calls[0].thought_signature || calls[0].extra_content?.google?.thought_signature);
    const second = await send(native, { ...first, tool_choice: "none", messages: [
      ...first.messages, message, { role: "tool", tool_call_id: calls[0].id, content: '{"code":"ARGON_TOOL_OK"}' },
    ] });
    assert.match(second.choices[0].message.content, /ARGON_TOOL_OK/);
  });
  for (const stream of [false, true]) {
    await check(route, `responses: ${stream ? "streaming" : "non-streaming"}`, async () => {
      const input = { model: "gemini-4-argon", input: "Reply with exactly ARGON_OK.", reasoning: { effort: "minimal" }, max_output_tokens: 4096, stream };
      const result = await send(native, responsesRequestToChat(input), input);
      const response = stream ? result.find(e => e.event === "response.completed")?.data.response : result;
      assert.ok(response, "Missing completed response");
      assert.equal(response.status, "completed");
      assert.match(response.output.filter(i => i.type === "message").flatMap(i => i.content).map(p => p.text ?? "").join(""), /ARGON_OK/);
      assert.ok(response.usage.total_tokens > 0);
    });
  }
}
console.log(JSON.stringify({ summary: { passed: results.filter(r => r.status === "passed").length,
  failed: results.filter(r => r.status === "failed").length, requests,
  authentication: "gcloud access token; no Express key or deployed Worker tested" } }));
process.exitCode = results.some(r => r.status === "failed") ? 1 : 0;
