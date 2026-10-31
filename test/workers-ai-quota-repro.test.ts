import { afterEach, describe, expect, it, vi } from "vitest";
import { enforceClientLimits } from "../src/limits";
import { runWorkersAI } from "../src/providers";
import { instrumentUsageResponse } from "../src/usage";
import type { ClientKey, Env, GatewayRequest, Provider } from "../src/types";

afterEach(() => vi.restoreAllMocks());

function reproduction(reportedUsage: boolean, upstreamUsage: unknown = { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 }, policy?: string) {
  const configuration: Record<string, string> = policy === undefined ? {} : { MONTHLY_QUOTA_INCLUDE_ESTIMATES: policy };
  const now = Date.UTC(2026, 9, 31, 6);
  vi.spyOn(Date, "now").mockReturnValue(now);
  const writes: unknown[][] = [];
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); } } as ExecutionContext;
  const key: ClientKey = {
    id: "quota-repro-key", name: "Quota reproduction", hash: "mock-hash",
    prefix: "mock", enabled: true, createdAt: new Date(now).toISOString(), monthlyTokenLimit: 1,
  };
  const provider: Provider = {
    id: "workers-ai", name: "Workers AI", type: "workers-ai", enabled: true,
    models: ["@cf/meta/llama-3.1-8b-instruct"],
  };
  const run = vi.fn<(model: string, input: unknown) => Promise<unknown>>().mockResolvedValue({
    response: "This response consumes tokens.",
    ...(reportedUsage ? { usage: upstreamUsage } : {}),
  });
  const prepare = vi.fn<D1Database["prepare"]>((query) => {
    let boundValues: unknown[] = [];
    const statement: D1PreparedStatement = {
      bind: vi.fn<D1PreparedStatement["bind"]>(),
      first: vi.fn<D1PreparedStatement["first"]>(),
      async run() {
        expect(query).toContain("INSERT INTO usage_events");
        writes.push(boundValues);
        return {
          success: true, results: [],
          meta: { duration: 0, size_after: 0, rows_read: 0, rows_written: 1, last_row_id: writes.length, changed_db: true, changes: 1 },
        };
      },
      async all() { throw new Error("Unexpected D1 all() call"); },
      async raw() { throw new Error("Unexpected D1 raw() call"); },
    };
    vi.mocked(statement.bind).mockImplementation((...values) => {
      boundValues = values;
      if (!query.includes("INSERT INTO usage_events")) {
        expect(query).toContain("FROM usage_events");
        expect(query).toMatch(/THEN (?:total_tokens|known_tokens)/);
        const tokenIndex = query.includes("THEN known_tokens") ? 19 : 12;
        const [dayStart, monthStart, clientKeyId, since] = values;
        const rows = writes.filter((row) => row[2] === clientKeyId && Number(row[1]) >= Number(since));
        vi.mocked(statement.first).mockResolvedValue({
          daily_requests: rows.filter((row) => Number(row[1]) >= Number(dayStart)).length,
          monthly_tokens: rows.filter((row) => Number(row[1]) >= Number(monthStart)).reduce((total, row) => total + Number(row[tokenIndex]), 0),
        });
      }
      return statement;
    });
    return statement;
  });
  const env = {
    ...configuration,
    AI: { run: (model: string, input: unknown) => run(model, input) } as Ai,
    USAGE: { prepare: (query: string) => prepare(query) },
  } as Env;

  async function request(shape: "chat" | "messages" | "responses", stream = false): Promise<Response> {
    const endpoint = shape === "chat" ? "/v1/chat/completions" : `/v1/${shape}`;
    const body: GatewayRequest = {
      model: provider.models[0], stream, messages: [{ role: "user", content: "Please say hello." }],
    };
    const denied = await enforceClientLimits(env, ctx, key, body, endpoint, now);
    if (denied) return denied;
    const response = await runWorkersAI(env, provider, body, shape);
    const monitored = instrumentUsageResponse(env, ctx, response, {
      clientKeyId: key.id, endpoint, providerId: provider.id, providerName: provider.name,
      providerType: provider.type, model: body.model!, status: response.status,
      startedAt: now, streaming: stream, protocolAdapted: shape !== "chat",
    }, body);
    const payload = await monitored.text();
    await Promise.all(pending.splice(0));
    return new Response(payload, { status: monitored.status, headers: monitored.headers });
  }

  return { request, run, writes, key, upstreamUsage, env };
}

describe("security regression: native Workers AI non-streaming monthly quota", () => {
  it.each([
    ["chat", true], ["chat", false], ["messages", true], ["messages", false],
    ["responses", true], ["responses", false],
  ] as const)("meters %s and rejects subsequent requests with a one-token quota (upstream usage: %s)", async (shape, reportedUsage) => {
    const repro = reproduction(reportedUsage);
    const response = await repro.request(shape);
    expect(response.status).toBe(200);
    if (reportedUsage) {
      await expect(response.json()).resolves.toMatchObject({
        usage: shape === "chat"
          ? { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 }
          : { input_tokens: 12, output_tokens: 8 },
      });
      expect(repro.writes[0].slice(10, 13)).toEqual([12, 8, 20]);
    } else {
      expect(await response.json()).not.toHaveProperty("usage");
      expect(repro.writes[0][10]).toBeGreaterThan(0);
      expect(repro.writes[0][11]).toBeGreaterThan(0);
    }
    expect(repro.writes).toHaveLength(1);
    expect(repro.writes[0][2]).toBe(repro.key.id);
    expect(repro.writes[0][12]).toBeGreaterThan(repro.key.monthlyTokenLimit!);
    expect(repro.writes[0][17]).toBe(reportedUsage ? "exact" : "estimated");
    expect(repro.writes[0][19]).toBe(reportedUsage ? 20 : 0);
    expect(repro.writes[0][18]).toBe(1);

    for (let attempt = 0; attempt < 2; attempt++) {
      const denied = await repro.request(shape);
      expect(denied.status).toBe(429);
      await expect(denied.json()).resolves.toMatchObject({ error: { type: "quota_exceeded" } });
    }
    expect(repro.run).toHaveBeenCalledTimes(1);
    expect(repro.writes).toHaveLength(1);
    expect(repro.run).toHaveBeenCalledWith("@cf/meta/llama-3.1-8b-instruct", expect.objectContaining({ stream: false }));
  });

  it("still enforces the daily request limit on the affected chat route", async () => {
    const repro = reproduction(true);
    repro.key.monthlyTokenLimit = undefined;
    repro.key.dailyRequestLimit = 2;
    expect((await repro.request("chat")).status).toBe(200);
    expect((await repro.request("chat")).status).toBe(200);
    const denied = await repro.request("chat");
    expect(denied.status).toBe(429);
    await expect(denied.json()).resolves.toMatchObject({ error: { type: "quota_exceeded" } });
    expect(repro.run).toHaveBeenCalledTimes(2);
    expect(repro.writes).toHaveLength(2);
  });

  it.each(["chat", "messages", "responses"] as const)("normalizes input/output token names for %s", async (shape) => {
    const repro = reproduction(true, { input_tokens: 12, output_tokens: 8 });
    expect((await repro.request(shape)).status).toBe(200);
    expect(repro.writes[0].slice(10, 13)).toEqual([12, 8, 20]);
    expect(repro.writes[0][17]).toBe("exact");
    expect((await repro.request(shape)).status).toBe(429);
  });

  it.each(["chat", "messages", "responses"] as const)("estimates only the missing output count for %s", async (shape) => {
    const repro = reproduction(true, { prompt_tokens: 12 });
    const response = await repro.request(shape);
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toMatchObject({ usage: shape === "chat" ? { prompt_tokens: 12 } : { input_tokens: 12 } });
    expect(payload).not.toHaveProperty(shape === "chat" ? "usage.completion_tokens" : "usage.output_tokens");
    expect(repro.writes[0][10]).toBe(12);
    expect(repro.writes[0][11]).toBeGreaterThan(0);
    expect(repro.writes[0][12]).toBeGreaterThan(12);
    expect(repro.writes[0][17]).toBe("mixed");
    expect(repro.writes[0][19]).toBe(12);
    expect((await repro.request(shape)).status).toBe(429);
  });

  it.each(["chat", "messages", "responses"] as const)("falls back to estimates for invalid %s usage", async (shape) => {
    const repro = reproduction(true, { prompt_tokens: -1, completion_tokens: "8", total_tokens: null });
    const response = await repro.request(shape);
    expect(response.status).toBe(200);
    expect(await response.json()).not.toHaveProperty("usage");
    expect(repro.writes).toHaveLength(1);
    expect(repro.writes[0][12]).toBeGreaterThan(repro.key.monthlyTokenLimit!);
    expect(repro.writes[0][17]).toBe("estimated");
    expect((await repro.request(shape)).status).toBe(429);
  });

  it.each(["chat", "messages", "responses"] as const)("retains a reported total without inventing input/output counts for %s", async (shape) => {
    const repro = reproduction(true, { total_tokens: 100 });
    const response = await repro.request(shape);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ usage: { total_tokens: 100 } });
    expect(repro.writes[0][12]).toBe(100);
    expect(repro.writes[0][17]).toBe("mixed");
    expect(repro.writes[0][19]).toBe(100);
    expect((await repro.request(shape)).status).toBe(429);
  });

  describe("monthly quota estimate deployment policy", () => {
    it.each([
      ["true", false, 429], ["false", false, 200], ["false", true, 429],
    ] as const)("applies policy %s to streaming usage (reported: %s)", async (policy, reportedUsage, nextStatus) => {
      const repro = reproduction(reportedUsage, undefined, policy);
      const source = `data: ${JSON.stringify({
        response: "This response consumes tokens.",
        ...(reportedUsage ? { usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } } : {}),
      })}\n\ndata: [DONE]\n\n`;
      repro.run.mockImplementation(async () => new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(source));
          controller.close();
        },
      }));
      const response = await repro.request("chat", true);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("This response consumes tokens.");
      expect(repro.writes[0][12]).toBeGreaterThan(0);
      expect(repro.writes[0][13]).toBe(1);
      expect(repro.writes[0][19]).toBe(reportedUsage ? 20 : 0);
      expect((await repro.request("chat", true)).status).toBe(nextStatus);
    });

    it.each(["chat", "messages", "responses"] as const)("keeps %s dashboard estimates without charging them when disabled", async (shape) => {
      const repro = reproduction(false, undefined, "false");
      for (let attempt = 0; attempt < 3; attempt++) {
        expect((await repro.request(shape)).status).toBe(200);
        expect(repro.writes[attempt][12]).toBeGreaterThan(0);
        expect(repro.writes[attempt][17]).toBe("estimated");
        expect(repro.writes[attempt][19]).toBe(0);
      }
      expect(repro.run).toHaveBeenCalledTimes(3);
    });

    it.each([
      { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
      { prompt_tokens: 12 },
      { completion_tokens: 8 },
      { total_tokens: 100 },
    ])("still charges known tokens with estimates disabled: %j", async (usage) => {
      const repro = reproduction(true, usage, "false");
      expect((await repro.request("chat")).status).toBe(200);
      expect(repro.writes[0][19]).toBeGreaterThan(0);
      expect((await repro.request("chat")).status).toBe(429);
      expect(repro.run).toHaveBeenCalledTimes(1);
    });

    it("does not charge an estimated output component of mixed usage", async () => {
      const repro = reproduction(true, { prompt_tokens: 1 }, "false");
      repro.key.monthlyTokenLimit = 2;
      expect((await repro.request("chat")).status).toBe(200);
      expect(repro.writes[0][12]).toBeGreaterThan(2);
      expect(repro.writes[0][19]).toBe(1);
      expect((await repro.request("chat")).status).toBe(200);
      expect((await repro.request("chat")).status).toBe(429);
    });

    it("preserves daily limits when estimates are disabled", async () => {
      const repro = reproduction(false, undefined, "false");
      repro.key.dailyRequestLimit = 2;
      expect((await repro.request("chat")).status).toBe(200);
      expect((await repro.request("chat")).status).toBe(200);
      expect((await repro.request("chat")).status).toBe(429);
      expect(repro.run).toHaveBeenCalledTimes(2);
    });

    it("recalculates existing monthly records when the policy changes", async () => {
      const repro = reproduction(false, undefined, "false");
      expect((await repro.request("chat")).status).toBe(200);
      Object.assign(repro.env, { MONTHLY_QUOTA_INCLUDE_ESTIMATES: "true" });
      expect((await repro.request("chat")).status).toBe(429);
      Object.assign(repro.env, { MONTHLY_QUOTA_INCLUDE_ESTIMATES: "false" });
      expect((await repro.request("chat")).status).toBe(200);
    });

    it("supports boolean deployment values", async () => {
      const repro = reproduction(false);
      Object.assign(repro.env, { MONTHLY_QUOTA_INCLUDE_ESTIMATES: false });
      expect((await repro.request("chat")).status).toBe(200);
      expect((await repro.request("chat")).status).toBe(200);
      Object.assign(repro.env, { MONTHLY_QUOTA_INCLUDE_ESTIMATES: true });
      expect((await repro.request("chat")).status).toBe(429);
    });

    it("rejects an invalid policy instead of silently disabling protection", async () => {
      const repro = reproduction(false, undefined, "disabled");
      await expect(repro.request("chat")).rejects.toThrow("MONTHLY_QUOTA_INCLUDE_ESTIMATES");
      expect(repro.run).not.toHaveBeenCalled();
      expect(repro.writes).toHaveLength(0);
    });
  });

  it.each(["chat", "messages", "responses"] as const)("preserves genuine zero-valued %s usage", async (shape) => {
    const repro = reproduction(true, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
    expect((await repro.request(shape)).status).toBe(200);
    expect(repro.writes[0].slice(10, 13)).toEqual([0, 0, 0]);
    expect(repro.writes[0][17]).toBe("exact");
  });
});
