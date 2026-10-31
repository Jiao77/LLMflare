import { afterEach, describe, expect, it, vi } from "vitest";
import { estimateTokens, extractTokenUsage, getUsageSummary, instrumentUsageResponse } from "../src/usage";
import type { Env, UsageEvent } from "../src/types";

afterEach(() => vi.restoreAllMocks());

describe("usage extraction", () => {
  it("reads OpenAI-compatible token fields", () => {
    expect(extractTokenUsage({ usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } })).toEqual({ inputTokens: 12, outputTokens: 8, totalTokens: 20 });
  });

  it("reads Responses and Anthropic-style token fields", () => {
    expect(extractTokenUsage({ usage: { input_tokens: 7, output_tokens: 5 } })).toEqual({ inputTokens: 7, outputTokens: 5, totalTokens: 12 });
  });

  it("does not invent counts when the upstream omits usage", () => {
    expect(extractTokenUsage({ choices: [] })).toEqual({ inputTokens: null, outputTokens: null, totalTokens: null });
  });

  it("reads usage from a streamed Responses completion event", () => {
    expect(extractTokenUsage({ type: "response.completed", response: { usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 } } })).toEqual({ inputTokens: 20, outputTokens: 10, totalTokens: 30 });
  });
});

describe("token estimation fallback", () => {
  it("counts CJK more densely than ASCII text", () => {
    expect(estimateTokens("你好世界")).toBe(4);
    expect(estimateTokens("abcdefgh")).toBe(2);
  });
});

describe("usage dashboard breakdowns", () => {
  it("returns the provider name for every popular-model row", async () => {
    const queries: string[] = [];
    const batches = [
      { results: [{ requests: 1, successes: 1, input_tokens: 2, output_tokens: 3, total_tokens: 5, metered_requests: 1, exact_requests: 1, avg_latency_ms: 10, avg_first_token_ms: 5, avg_duration_ms: 10, avg_output_tps: 300 }] },
      { results: [] },
      { results: [] },
      { results: [{ provider_name: "OpenRouter", name: "openai/gpt-oss-120b", requests: 1, input_tokens: 2, output_tokens: 3, total_tokens: 5, errors: 0 }] },
      { results: [{ total: 1 }] },
      { results: [] },
      { results: [{ total: 0 }] },
    ];
    const env = { USAGE: {
      prepare(query: string) {
        queries.push(query);
        const statement = { bind: () => statement };
        return statement;
      },
      batch: async () => batches,
    } } as unknown as Env;

    const summary = await getUsageSummary(env, { days: 30, modelPage: 1, modelPageSize: 10, logPage: 1, logPageSize: 10 });
    expect(queries[1]).toMatch(/SUM\(output_tokens\)/);
    expect(queries[1]).not.toMatch(/SUM\(total_tokens\)/);
    expect(queries[3]).toMatch(/SELECT\s+provider_name,\s*model AS name/);
    expect(queries[3]).toMatch(/SUM\(input_tokens\)/);
    expect(queries[3]).toMatch(/SUM\(output_tokens\)/);
    expect(summary.models).toEqual([expect.objectContaining({ provider_name: "OpenRouter", name: "openai/gpt-oss-120b", input_tokens: 2, output_tokens: 3, total_tokens: 5 })]);
  });
});

describe("stream instrumentation", () => {
  it("forwards SSE bytes unchanged and records final exact usage", async () => {
    const encoder = new TextEncoder();
    const source = 'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":3,"total_tokens":8}}\n\ndata: [DONE]\n\n';
    const writes: unknown[][] = [];
    const env = { USAGE: { prepare: () => ({ bind: (...values: unknown[]) => ({ run: async () => { writes.push(values); } }) }) } };
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); } } as ExecutionContext;
    const event: UsageEvent = { clientKeyId: "key", endpoint: "/v1/chat/completions", providerId: "provider", providerName: "Groq", providerType: "groq", model: "model", status: 200, startedAt: Date.now(), streaming: true, protocolAdapted: false };
    const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encoder.encode(source)); controller.close(); } }), { headers: { "content-type": "text/event-stream" } });
    const monitored = instrumentUsageResponse(env, ctx, response, event, { stream: true, messages: [{ role: "user", content: "Hello" }] });

    expect(await monitored.text()).toBe(source);
    await Promise.all(pending);
    expect(writes).toHaveLength(1);
    expect(writes[0][10]).toBe(5);
    expect(writes[0][11]).toBe(3);
    expect(writes[0][12]).toBe(8);
    expect(writes[0][17]).toBe("exact");
    expect(writes[0][18]).toBe(1);
    expect(writes[0][19]).toBe(8);
  });

  it("includes first-token latency in TPS for protocol-adapted responses", async () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(4_000).mockReturnValueOnce(4_000).mockReturnValue(5_000);
    const encoder = new TextEncoder();
    const source = 'data: {"type":"response.output_text.delta","delta":"Hi"}\n\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":5,"output_tokens":3,"total_tokens":8}}}\n\n';
    const writes: unknown[][] = [];
    const env = { USAGE: { prepare: () => ({ bind: (...values: unknown[]) => ({ run: async () => { writes.push(values); } }) }) } };
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); } } as ExecutionContext;
    const event: UsageEvent = { clientKeyId: "key", endpoint: "/v1/responses", providerId: "provider", providerName: "Nvidia", providerType: "nvidia", model: "model", status: 200, startedAt: 1_000, streaming: true, protocolAdapted: true };
    const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encoder.encode(source)); controller.close(); } }), { headers: { "content-type": "text/event-stream" } });
    const monitored = instrumentUsageResponse(env, ctx, response, event, { stream: true, input: "Hello" });

    await monitored.text();
    await Promise.all(pending);
    expect(writes[0][14]).toBe(3_000);
    expect(writes[0][15]).toBe(4_000);
    expect(writes[0][16]).toBe(0.75);
  });
});

describe("known token accounting", () => {
  it("records zero known tokens for a response without a body", async () => {
    const writes: unknown[][] = [];
    const env = { USAGE: { prepare: () => ({ bind: (...values: unknown[]) => ({ run: async () => { writes.push(values); } }) }) } };
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); } } as ExecutionContext;
    const event: UsageEvent = { clientKeyId: "key", endpoint: "/v1/chat/completions", providerId: "provider", providerName: "Groq", providerType: "groq", model: "model", status: 204, startedAt: Date.now(), streaming: false, protocolAdapted: false };
    const monitored = instrumentUsageResponse(env, ctx, new Response(null, { status: 204 }), event, { messages: [{ role: "user", content: "Hello" }] });
    expect(monitored.status).toBe(204);
    await Promise.all(pending);
    expect(writes[0][12]).toBeGreaterThan(0);
    expect(writes[0][19]).toBe(0);
  });
});
