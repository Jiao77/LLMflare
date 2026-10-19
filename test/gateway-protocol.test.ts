import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { sha256 } from "../src/utils";
import type { Env, Provider } from "../src/types";

function context(): ExecutionContext {
  return { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
}

function testProvider(): Provider {
  return { id: "p1", name: "Router", type: "openrouter", enabled: true, apiKey: "key", models: ["m1"], enabledModels: ["m1"] };
}

async function environment(d1Healthy = true): Promise<Env> {
  const clientKey = { id: "key-1", name: "Test", hash: await sha256("test-key"), prefix: "test", enabled: true, createdAt: "2026-08-26T00:00:00Z" };
  return {
    CONFIG: { get: vi.fn(async (key: string) => key === "providers:v1" ? [testProvider()] : [clientKey]) },
    USAGE: {
      prepare: vi.fn(() => ({
        bind: () => ({
          run: async () => ({}),
          first: async () => d1Healthy ? { result: 1 } : Promise.reject(new Error("D1 connection lost")),
        }),
        first: async () => d1Healthy ? { result: 1 } : Promise.reject(new Error("D1 connection lost")),
      })),
    },
    ASSETS: { fetch: vi.fn(async () => new Response("not found", { status: 404 })) },
  } as unknown as Env;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("non-streaming tool and usage translation", () => {
  it("converts tool_calls and usage in non-streaming Chat completions to Anthropic Messages", async () => {
    const upstream = {
      id: "chatcmpl-test",
      model: "m1",
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: "Checking weather...",
          tool_calls: [{
            id: "call_abc",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"Hangzhou"}' },
          }],
        },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 12, completion_tokens: 18, total_tokens: 30 },
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(upstream), {
      status: 200,
      headers: { "content-type": "application/json" },
    })));

    const response = await worker.fetch!(new Request("https://gateway.test/v1/messages", {
      method: "POST",
      headers: { authorization: "Bearer test-key", "content-type": "application/json" },
      body: JSON.stringify({ model: "Router/m1", stream: false, messages: [{ role: "user", content: "Weather please" }] }),
    }), await environment(), context());

    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body.type).toBe("message");
    expect(body.role).toBe("assistant");
    expect(body.stop_reason).toBe("tool_use");
    expect(body.content).toEqual([
      { type: "text", text: "Checking weather..." },
      { type: "tool_use", id: "call_abc", name: "get_weather", input: { city: "Hangzhou" } },
    ]);
    expect(body.usage).toEqual({ input_tokens: 12, output_tokens: 18 });
  });

  it("converts tool_calls in non-streaming Chat completions to Responses format", async () => {
    const upstream = {
      id: "chatcmpl-resp",
      model: "m1",
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: "Executing search",
          tool_calls: [{
            id: "call_search",
            type: "function",
            function: { name: "search", arguments: '{"query":"LLM"}' },
          }],
        },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 8, completion_tokens: 14, total_tokens: 22 },
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(upstream), {
      status: 200,
      headers: { "content-type": "application/json" },
    })));

    const response = await worker.fetch!(new Request("https://gateway.test/v1/responses", {
      method: "POST",
      headers: { authorization: "Bearer test-key", "content-type": "application/json" },
      body: JSON.stringify({ model: "Router/m1", stream: false, input: "Search" }),
    }), await environment(), context());

    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body.object).toBe("response");
    expect(body.status).toBe("completed");
    expect(body.output).toMatchObject([
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Executing search" }] },
      { type: "function_call", name: "search", call_id: "call_search", arguments: '{"query":"LLM"}' },
    ]);
  });
});

describe("payload size protection and HTTP 413", () => {
  it("rejects declared oversized Content-Length with HTTP 413", async () => {
    const response = await worker.fetch!(new Request("https://gateway.test/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: "Bearer test-key",
        "content-type": "application/json",
        "content-length": "2000000",
      },
      body: JSON.stringify({ model: "Router/m1", messages: [{ role: "user", content: "x" }] }),
    }), await environment(), context());

    expect(response.status).toBe(413);
    const body = await response.json() as { error: { message: string; type: string } };
    expect(body.error.type).toBe("request_too_large");
    expect(body.error.message).toContain("1 MB");
  });

  it("stream-truncates oversized request without Content-Length header with HTTP 413", async () => {
    const bigString = "x".repeat(1_050_000);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`{"model":"Router/m1","prompt":"${bigString}"}`));
        controller.close();
      },
    });

    const response = await worker.fetch!(new Request("https://gateway.test/v1/responses", {
      method: "POST",
      headers: {
        authorization: "Bearer test-key",
        "content-type": "application/json",
      },
      body: stream,
      duplex: "half",
    } as RequestInit), await environment(), context());

    expect(response.status).toBe(413);
    const body = await response.json() as { error: { type: string } };
    expect(body.error.type).toBe("request_too_large");
  });
});

describe("health and readiness checks", () => {
  it("returns 200 for basic liveness check", async () => {
    const response = await worker.fetch!(new Request("https://gateway.test/health"), await environment(), context());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, service: "llmflare" });
  });

  it("returns 200 when D1 and KV dependencies are ready", async () => {
    const response = await worker.fetch!(new Request("https://gateway.test/health?check=ready"), await environment(true), context());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, service: "llmflare", d1: "ready", kv: "ready" });
  });

  it("returns 503 when D1 is unavailable during readiness check", async () => {
    const response = await worker.fetch!(new Request("https://gateway.test/health?check=ready"), await environment(false), context());
    expect(response.status).toBe(503);
    const body = await response.json() as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect(body.d1).toContain("error");
  });
});
