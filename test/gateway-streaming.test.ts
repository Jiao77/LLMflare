import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { sha256 } from "../src/utils";
import type { Env, Provider } from "../src/types";

const encoder = new TextEncoder();

function context(): ExecutionContext {
  return { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
}

function upstreamStream(): Response {
  const chunks = [
    'data: {"id":"chat_1","model":"test-model","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\ndata: {"id":"chat_1","model":"test-model","choices":[{"index":0,"delta":{"content":"你',
    '好"},"finish_reason":null}]}\n\ndata: {"id":"chat_1","model":"test-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: {"id":"chat_1","model":"test-model","choices":[],"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}\n\ndata: [DONE]\n\n',
  ];
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), { headers: { "content-type": "text/event-stream" } });
}

function upstreamToolStream(): Response {
  const source = [
    'data: {"id":"chat_tool","model":"test-model","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"lookup","arguments":""}}]},"finish_reason":null}]}\n\n',
    'data: {"id":"chat_tool","model":"test-model","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"q\\":"}}]},"finish_reason":null}]}\n\n',
    'data: {"id":"chat_tool","model":"test-model","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"edge\\"}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":8,"completion_tokens":4,"total_tokens":12}}\n\ndata: [DONE]\n\n',
  ];
  return new Response(new ReadableStream<Uint8Array>({ start(controller) { for (const chunk of source) controller.enqueue(encoder.encode(chunk)); controller.close(); } }), { headers: { "content-type": "text/event-stream" } });
}

async function environment(provider: Provider): Promise<Env> {
  const clientKey = { id: "key-1", name: "Test", hash: await sha256("test-client-key"), prefix: "test", enabled: true, createdAt: "2026-08-26T00:00:00Z" };
  return {
    CONFIG: { get: vi.fn(async (key: string) => key === "providers:v1" ? [provider] : [clientKey]) },
    USAGE: { prepare: vi.fn(() => ({ bind: () => ({ run: async () => ({}) }) })) },
    ASSETS: { fetch: vi.fn(async () => new Response("not found", { status: 404 })) },
  } as unknown as Env;
}

function provider(): Provider {
  return { id: "provider-1", name: "Router", type: "openrouter", enabled: true, apiKey: "test-upstream-key", models: ["test-model"], enabledModels: ["test-model"] };
}

async function request(path: string, body: Record<string, unknown>): Promise<Response> {
  return requestWithEnvironment(path, body, await environment(provider()));
}

async function requestWithEnvironment(path: string, body: Record<string, unknown>, env: Env): Promise<Response> {
  return worker.fetch!(new Request(`https://gateway.test${path}`, {
    method: "POST",
    headers: { authorization: "Bearer test-client-key", "content-type": "application/json" },
    body: JSON.stringify({ model: "Router/test-model", stream: true, ...body }),
  }), env, context());
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("cross-protocol gateway streaming", () => {
  it("does not expose a bare /message alias", async () => {
    const env = await environment(provider());
    const response = await requestWithEnvironment("/message", { messages: [{ role: "user", content: "hi" }] }, env);
    expect(response.status).toBe(404);
    expect(env.ASSETS.fetch).toHaveBeenCalledOnce();
  });

  it("converts Chat SSE to Anthropic Messages SSE without buffering the full response", async () => {
    const fetchMock = vi.fn(async () => upstreamStream());
    vi.stubGlobal("fetch", fetchMock);

    const response = await request("/v1/messages", { messages: [{ role: "user", content: "hi" }], max_tokens: 32 });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const text = await response.text();
    expect(text).toContain("event: message_start");
    expect(text).toContain('"type":"text_delta","text":"你好"');
    expect(text).toContain('"input_tokens":4');
    expect(text).toContain("event: message_stop");
    expect(fetchMock).toHaveBeenCalledWith("https://openrouter.ai/api/v1/chat/completions", expect.objectContaining({ method: "POST" }));
  });

  it("emits the first converted event before the upstream stream completes", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let step = 0;
    let cancelled = false;
    const source = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (step++ === 0) {
          controller.enqueue(encoder.encode('data: {"id":"chat_1","model":"test-model","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n'));
          return;
        }
        await gate;
        if (cancelled) return;
        controller.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{"content":"done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
        controller.close();
      },
      cancel() {
        cancelled = true;
        release();
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(source, { headers: { "content-type": "text/event-stream" } })));

    const response = await request("/v1/messages", { messages: [{ role: "user", content: "hi" }] });
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("event: message_start");
    await reader.cancel();
    expect(cancelled).toBe(true);
  });

  it("converts Anthropic tools in both the request and streamed response", async () => {
    let capturedInit: RequestInit | undefined;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => { capturedInit = init; return upstreamToolStream(); });
    vi.stubGlobal("fetch", fetchMock);
    const response = await request("/v1/messages", {
      messages: [{ role: "user", content: "look it up" }],
      tools: [{ name: "lookup", description: "Lookup", input_schema: { type: "object", properties: { q: { type: "string" } } } }],
      tool_choice: { type: "auto" },
    });
    const text = await response.text();
    expect(text).toContain('"type":"tool_use","id":"call_1","name":"lookup"');
    expect(text).toContain('"type":"input_json_delta","partial_json":"{\\"q\\":"');
    expect(text).toContain('"stop_reason":"tool_use"');
    const sent = JSON.parse(String(capturedInit?.body));
    expect(sent.tools[0]).toEqual({ type: "function", function: { name: "lookup", description: "Lookup", parameters: { type: "object", properties: { q: { type: "string" } } } } });
    expect(sent.tool_choice).toBe("auto");
  });

  it("forwards a streamed upstream error without appending a false success event", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response('data: {"error":{"type":"upstream_error","message":"failed"}}\n\n', { headers: { "content-type": "text/event-stream" } })));
    const response = await request("/v1/messages", { messages: [{ role: "user", content: "hi" }] });
    const text = await response.text();
    expect(text).toContain("event: error");
    expect(text).not.toContain("event: message_stop");
  });

  it("normalizes an upstream HTTP failure to an Anthropic Messages error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("upstream timed out", { status: 524, headers: { "content-type": "text/plain" } })));

    const response = await request("/v1/messages", { messages: [{ role: "user", content: "hi" }] });

    expect(response.status).toBe(524);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({
      type: "error",
      error: { type: "api_error", message: expect.stringContaining("HTTP 524") },
    });
  });

  it("maps an upstream 429 to an Anthropic rate-limit error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "too many requests" } }), { status: 429, headers: { "content-type": "application/json" } })));

    const response = await request("/v1/messages", { messages: [{ role: "user", content: "hi" }] });

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({
      type: "error",
      error: { type: "rate_limit_error", message: expect.stringMatching(/HTTP 429.*too many requests/) },
    });
  });

  it("fails a stalled Nvidia Messages request at the gateway first-byte deadline", async () => {
    vi.useFakeTimers();
    const nvidiaProvider: Provider = { id: "nvidia-1", name: "Nvidia", type: "nvidia", enabled: true, apiKey: "test-upstream-key", models: ["openai/gpt-oss-120b"], enabledModels: ["openai/gpt-oss-120b"] };
    const env = await environment(nvidiaProvider);
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));
    vi.stubGlobal("fetch", fetchMock);

    const pending = requestWithEnvironment("/v1/messages", {
      model: "Nvidia/openai/gpt-oss-120b",
      messages: [{ role: "user", content: "long Claude Code request" }],
    }, env);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(60_000);
    const outcome = await pending;

    expect(outcome).toBeInstanceOf(Response);
    const response = outcome as Response;
    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({
      type: "error",
      error: { type: "api_error", message: expect.stringContaining("60") },
    });
  });

  it("converts Chat SSE to Responses SSE for providers without a native Responses endpoint", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => upstreamStream()));

    const response = await request("/v1/responses", { input: "hi", max_output_tokens: 32 });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const text = await response.text();
    expect(text).toContain('"type":"response.created"');
    expect(text).toContain('"type":"response.output_text.delta"');
    expect(text).toContain('"delta":"你好"');
    expect(text).toContain('"type":"response.completed"');
    expect(text).toContain('"total_tokens":6');
    const events = text.split(/\r?\n/).filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)));
    expect(events.map((event) => event.sequence_number)).toEqual(events.map((_, index) => index));
  });

  it("accepts Codex-style Responses fields when adapting to Chat", async () => {
    let sent: Record<string, unknown> | undefined;
    const nvidiaProvider: Provider = { id: "nvidia-1", name: "Nvidia", type: "nvidia", enabled: true, apiKey: "test-upstream-key", models: ["openai/gpt-oss-120b"], enabledModels: ["openai/gpt-oss-120b"] };
    const env = await environment(nvidiaProvider);
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body));
      return upstreamStream();
    }));
    const response = await requestWithEnvironment("/v1/responses", {
      model: "Nvidia/openai/gpt-oss-120b",
      stream: true,
      instructions: "Be concise.",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Hello" }] }],
      reasoning: { effort: "low" },
      include: ["reasoning.encrypted_content"],
      store: false,
    }, env);
    expect(response.status).toBe(200);
    expect(sent).toMatchObject({
      messages: [{ role: "system", content: "Be concise." }, { role: "user", content: "Hello" }],
      reasoning_effort: "low",
    });
    expect(sent).not.toHaveProperty("input");
    expect(sent).not.toHaveProperty("instructions");
    expect(sent).not.toHaveProperty("include");
    expect(sent).not.toHaveProperty("store");
  });

  it("streams the native Workers AI binding through the same protocol adapter", async () => {
    const workersProvider: Provider = { id: "workers-1", name: "Workers", type: "workers-ai", enabled: true, models: ["@cf/test/model"], enabledModels: ["@cf/test/model"] };
    const env = await environment(workersProvider);
    const run = vi.fn(async () => new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"response":"边缘"}\n\ndata: {"response":"流"}\n\ndata: [DONE]\n\n'));
        controller.close();
      },
    }));
    Object.assign(env, { AI: { run } });

    const response = await requestWithEnvironment("/v1/messages", {
      model: "Workers/@cf/test/model",
      messages: [{ role: "user", content: "hi" }],
    }, env);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('"type":"text_delta","text":"边缘"');
    expect(text).toContain('"type":"text_delta","text":"流"');
    expect(run).toHaveBeenCalledWith("@cf/test/model", expect.objectContaining({ stream: true }));
  });

  it("preserves Workers AI choice frames and appends [DONE] after finish_reason", async () => {
    const workersProvider: Provider = { id: "workers-1", name: "Workers", type: "workers-ai", enabled: true, models: ["@cf/test/model"], enabledModels: ["@cf/test/model"] };
    const env = await environment(workersProvider);
    const frames = [
      { id: "chat_cf", model: "@cf/test/model", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
      { id: "chat_cf", model: "@cf/test/model", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } },
    ];
    const run = vi.fn(async () => new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(frames.map((frame) => "data: " + JSON.stringify(frame) + "\n\n").join("")));
        controller.close();
      },
    }));
    Object.assign(env, { AI: { run } });

    const response = await requestWithEnvironment("/v1/chat/completions", {
      model: "Workers/@cf/test/model",
      messages: [{ role: "user", content: "hi" }],
    }, env);
    const text = await response.text();
    const data = text.split(/\r?\n/).filter((line) => line.startsWith("data: ")).map((line) => line.slice(6));

    expect(data[data.length - 1]).toBe("[DONE]");
    expect((text.match(/"finish_reason":"stop"/g) ?? [])).toHaveLength(1);
    expect(text).toContain('"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}');
    expect(run).toHaveBeenCalledWith("@cf/test/model", expect.objectContaining({ stream: true }));
  });

  it("preserves Workers AI tool calls when finish_reason arrives before EOF", async () => {
    const workersProvider: Provider = { id: "workers-1", name: "Workers", type: "workers-ai", enabled: true, models: ["@cf/test/model"], enabledModels: ["@cf/test/model"] };
    const env = await environment(workersProvider);
    const frames = [
      { id: "chat_tool_cf", model: "@cf/test/model", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_cf", type: "function", function: { name: "lookup", arguments: "" } }] }, finish_reason: null }] },
      { id: "chat_tool_cf", model: "@cf/test/model", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"q":' } }] }, finish_reason: "tool_calls" }] },
      { choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } },
    ];
    const run = vi.fn(async () => new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(frames.map((frame) => "data: " + JSON.stringify(frame) + "\n\n").join("")));
        controller.close();
      },
    }));
    Object.assign(env, { AI: { run } });

    const response = await requestWithEnvironment("/v1/messages", {
      model: "Workers/@cf/test/model",
      messages: [{ role: "user", content: "look it up" }],
      tools: [{ name: "lookup", description: "Lookup", input_schema: { type: "object", properties: { q: { type: "string" } } } }],
      tool_choice: { type: "auto" },
    }, env);
    const text = await response.text();

    expect(text).toContain('"type":"tool_use","id":"call_cf","name":"lookup"');
    expect(text).toContain('"stop_reason":"tool_use"');
    expect(run).toHaveBeenCalledWith("@cf/test/model", expect.objectContaining({ stream: true }));
  });

  it("does not turn a streamed Workers AI error into a successful completion", async () => {
    const workersProvider: Provider = { id: "workers-1", name: "Workers", type: "workers-ai", enabled: true, models: ["@cf/test/model"], enabledModels: ["@cf/test/model"] };
    const env = await environment(workersProvider);
    const run = vi.fn(async () => new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"error":{"message":"binding failed","type":"upstream_error"}}\n\n'));
        controller.close();
      },
    }));
    Object.assign(env, { AI: { run } });

    const response = await requestWithEnvironment("/v1/messages", {
      model: "Workers/@cf/test/model",
      messages: [{ role: "user", content: "hi" }],
    }, env);
    const text = await response.text();
    expect(text).toContain("event: error");
    expect(text).not.toContain("event: message_stop");
  });
});
