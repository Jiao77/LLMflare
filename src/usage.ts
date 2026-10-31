import type { Env, GatewayRequest, UsageEvent } from "./types";

interface TokenUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

interface UsageMeasurement extends TokenUsage {
  knownTokens: number;
  firstTokenMs: number | null;
  durationMs: number;
  outputTps: number | null;
  usageSource: "exact" | "mixed" | "estimated";
  completed: boolean;
}

interface UsageSummaryRow {
  requests: number;
  successes: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  metered_requests: number;
  exact_requests: number;
  avg_latency_ms: number;
  avg_first_token_ms: number;
  avg_duration_ms: number;
  avg_output_tps: number;
}

interface DailyProviderRow { day: string; provider_id: string; provider_name: string; requests: number; output_tokens: number }
interface BreakdownRow {
  name: string;
  requests: number;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens: number;
  errors: number;
  avg_output_tps?: number | null;
  avg_first_token_ms?: number | null;
  avg_duration_ms?: number | null;
}
interface ModelBreakdownRow extends BreakdownRow { provider_name: string }

export interface UsageQuery {
  days: number;
  modelPage: number;
  modelPageSize: number;
  logPage: number;
  logPageSize: number;
}

export async function deleteProviderUsage(env: Pick<Env, "USAGE">, providerId: string): Promise<void> {
  await env.USAGE.prepare("DELETE FROM usage_events WHERE provider_id = ?").bind(providerId).run();
}

const EMPTY_USAGE: TokenUsage = { inputTokens: null, outputTokens: null, totalTokens: null };
const MAX_JSON_CAPTURE = 2_000_000;

function finiteToken(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function usageObject(payload: unknown): Record<string, unknown> | null {
  const root = object(payload);
  if (!root) return null;
  return object(root.usage) || object(object(root.response)?.usage) || object(object(root.message)?.usage);
}

export function extractTokenUsage(payload: unknown): TokenUsage {
  const item = usageObject(payload);
  if (!item) return { ...EMPTY_USAGE };
  const inputTokens = finiteToken(item.input_tokens ?? item.prompt_tokens);
  const outputTokens = finiteToken(item.output_tokens ?? item.completion_tokens);
  const totalTokens = finiteToken(item.total_tokens) ?? (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null);
  return { inputTokens, outputTokens, totalTokens };
}

export function estimateTokens(value: unknown): number {
  if (value === undefined || value === null) return 0;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  let cjk = 0;
  let other = 0;
  for (const char of text) {
    if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(char)) cjk += 1;
    else if (!/\s/u.test(char)) other += 1;
  }
  return cjk + Math.ceil(other / 4);
}

function mergeUsage(current: TokenUsage, next: TokenUsage): TokenUsage {
  const inputTokens = next.inputTokens === null ? current.inputTokens : Math.max(current.inputTokens || 0, next.inputTokens);
  const outputTokens = next.outputTokens === null ? current.outputTokens : Math.max(current.outputTokens || 0, next.outputTokens);
  const reportedTotal = next.totalTokens === null ? current.totalTokens : Math.max(current.totalTokens || 0, next.totalTokens);
  const calculatedTotal = inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null;
  return { inputTokens, outputTokens, totalTokens: reportedTotal === null ? calculatedTotal : Math.max(reportedTotal, calculatedTotal || 0) };
}

function streamText(payload: unknown): string {
  const root = object(payload);
  if (!root) return "";
  if (typeof root.delta === "string") return root.delta;
  const delta = object(root.delta);
  if (typeof delta?.text === "string") return delta.text;
  const choices = Array.isArray(root.choices) ? root.choices : [];
  return choices.map((choice) => {
    const content = object(object(choice)?.delta)?.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) return content.map((part) => typeof object(part)?.text === "string" ? object(part)?.text : "").join("");
    return "";
  }).join("");
}

function responseText(payload: unknown): string {
  const root = object(payload);
  if (!root) return "";
  if (typeof root.output_text === "string") return root.output_text;
  const choices = Array.isArray(root.choices) ? root.choices : [];
  const fromChoices = choices.map((choice) => {
    const content = object(object(choice)?.message)?.content;
    return typeof content === "string" ? content : "";
  }).join("");
  if (fromChoices) return fromChoices;
  const content = Array.isArray(root.content) ? root.content : [];
  return content.map((part) => typeof object(part)?.text === "string" ? object(part)?.text : "").join("");
}

interface UsageWriterEnv {
  USAGE: {
    prepare(query: string): { bind(...values: unknown[]): { run(): Promise<unknown> } };
  };
}

async function writeUsage(env: UsageWriterEnv, event: UsageEvent, measurement: UsageMeasurement): Promise<void> {
  await env.USAGE.prepare(`
    INSERT INTO usage_events (
      id, created_at, client_key_id, endpoint, provider_id, provider_name, provider_type,
      model, status, latency_ms, input_tokens, output_tokens, total_tokens, streaming,
      first_token_ms, duration_ms, output_tps, usage_source, completed, known_tokens
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    crypto.randomUUID(), Date.now(), event.clientKeyId, event.endpoint, event.providerId,
    event.providerName, event.providerType, event.model, event.status,
    measurement.firstTokenMs ?? measurement.durationMs, measurement.inputTokens,
    measurement.outputTokens, measurement.totalTokens, event.streaming ? 1 : 0,
    measurement.firstTokenMs, measurement.durationMs, measurement.outputTps,
    measurement.usageSource, measurement.completed ? 1 : 0, measurement.knownTokens,
  ).run();
}

function logWrite(env: UsageWriterEnv, ctx: ExecutionContext, event: UsageEvent, measurement: UsageMeasurement): void {
  ctx.waitUntil(writeUsage(env, event, measurement).catch((cause) => console.error(JSON.stringify({ event: "usage_write_error", message: cause instanceof Error ? cause.message : String(cause) }))));
}

export function instrumentUsageResponse(env: UsageWriterEnv, ctx: ExecutionContext, response: Response, event: UsageEvent, requestBody: GatewayRequest): Response {
  const inputEstimate = estimateTokens({ messages: requestBody.messages, input: requestBody.input, system: requestBody.system, tools: requestBody.tools });
  const startedAt = event.startedAt;
  if (!response.body) {
    const durationMs = Math.max(0, Date.now() - startedAt);
    logWrite(env, ctx, event, { inputTokens: inputEstimate, outputTokens: 0, totalTokens: inputEstimate, knownTokens: 0, firstTokenMs: null, durationMs, outputTps: null, usageSource: "estimated", completed: true });
    return response;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const isSse = response.headers.get("content-type")?.toLowerCase().includes("text/event-stream") || Boolean(requestBody.stream);
  let exact = { ...EMPTY_USAGE };
  let hasExact = false;
  let estimatedOutput = 0;
  let firstByteAt: number | null = null;
  let firstTokenAt: number | null = null;
  let textBuffer = "";
  let captureTruncated = false;
  let finalized = false;

  const consumePayload = (payload: unknown, streaming: boolean) => {
    const usage = extractTokenUsage(payload);
    if (usage.inputTokens !== null || usage.outputTokens !== null || usage.totalTokens !== null) {
      exact = mergeUsage(exact, usage);
      hasExact = true;
    }
    const output = streaming ? streamText(payload) : responseText(payload);
    if (output) {
      firstTokenAt ||= Date.now();
      estimatedOutput += estimateTokens(output);
    }
  };

  const consumeSse = (text: string, flush = false) => {
    textBuffer += text;
    const lines = textBuffer.split(/\r?\n/);
    textBuffer = flush ? "" : lines.pop() || "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try { consumePayload(JSON.parse(data), true); }
      catch { /* Ignore non-JSON SSE keepalives and vendor extensions. */ }
    }
    if (textBuffer.length > 262_144) textBuffer = textBuffer.slice(-262_144);
  };

  const consumeChunk = (chunk: Uint8Array) => {
    const text = decoder.decode(chunk, { stream: true });
    if (isSse) consumeSse(text);
    else if (!captureTruncated) {
      if (textBuffer.length + text.length <= MAX_JSON_CAPTURE) textBuffer += text;
      else { estimatedOutput = Math.max(estimatedOutput, estimateTokens(textBuffer)); textBuffer = ""; captureTruncated = true; }
    }
  };

  const finalize = (completed: boolean) => {
    if (finalized) return;
    finalized = true;
    const tail = decoder.decode();
    if (isSse) consumeSse(tail, true);
    else if (!captureTruncated) {
      textBuffer += tail;
      try { consumePayload(JSON.parse(textBuffer), false); }
      catch { estimatedOutput ||= estimateTokens(textBuffer); }
    }
    const durationMs = Math.max(0, Date.now() - startedAt);
    const firstTokenMs = firstTokenAt !== null ? Math.max(0, firstTokenAt - startedAt) : firstByteAt !== null ? Math.max(0, firstByteAt - startedAt) : null;
    const knownTokens = exact.totalTokens ?? (exact.inputTokens ?? 0) + (exact.outputTokens ?? 0);
    let inputTokens = exact.inputTokens;
    let outputTokens = exact.outputTokens;
    if (exact.totalTokens !== null && inputTokens !== null && outputTokens === null) outputTokens = Math.max(0, exact.totalTokens - inputTokens);
    if (exact.totalTokens !== null && outputTokens !== null && inputTokens === null) inputTokens = Math.max(0, exact.totalTokens - outputTokens);
    const mixed = hasExact && (inputTokens === null || outputTokens === null);
    inputTokens ??= inputEstimate;
    outputTokens ??= estimatedOutput;
    const totalTokens = exact.totalTokens ?? inputTokens + outputTokens;
    const generationMs = firstTokenMs === null ? durationMs : Math.max(1, durationMs - firstTokenMs);
    const tpsWindowMs = event.protocolAdapted ? Math.max(1, durationMs) : generationMs;
    const outputTps = outputTokens > 0 ? Number((outputTokens / (tpsWindowMs / 1000)).toFixed(2)) : null;
    logWrite(env, ctx, event, { inputTokens, outputTokens, totalTokens, knownTokens, firstTokenMs, durationMs, outputTps, usageSource: hasExact ? mixed ? "mixed" : "exact" : "estimated", completed });
  };

  const monitored = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) { controller.close(); finalize(true); return; }
        firstByteAt ||= Date.now();
        controller.enqueue(result.value);
        consumeChunk(result.value);
      } catch (cause) {
        controller.error(cause);
        finalize(false);
      }
    },
    async cancel(reason) {
      try { await reader.cancel(reason); }
      finally { finalize(false); }
    },
  });
  return new Response(monitored, { status: response.status, statusText: response.statusText, headers: response.headers });
}

export async function getUsageSummary(env: Env, query: UsageQuery): Promise<Record<string, unknown>> {
  const since = Date.now() - query.days * 86_400_000;
  const modelOffset = (query.modelPage - 1) * query.modelPageSize;
  const logOffset = (query.logPage - 1) * query.logPageSize;
  const [summaryResult, dailyProvidersResult, providersResult, modelsResult, modelCountResult, logsResult, logCountResult] = await env.USAGE.batch([
    env.USAGE.prepare(`SELECT
      COUNT(*) AS requests,
      SUM(CASE WHEN status BETWEEN 200 AND 299 THEN 1 ELSE 0 END) AS successes,
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(total_tokens), 0) AS total_tokens,
      SUM(CASE WHEN total_tokens IS NOT NULL THEN 1 ELSE 0 END) AS metered_requests,
      SUM(CASE WHEN usage_source = 'exact' THEN 1 ELSE 0 END) AS exact_requests,
      COALESCE(ROUND(AVG(latency_ms)), 0) AS avg_latency_ms,
      COALESCE(ROUND(AVG(first_token_ms)), 0) AS avg_first_token_ms,
      COALESCE(ROUND(AVG(duration_ms)), 0) AS avg_duration_ms,
      COALESCE(ROUND(AVG(output_tps), 2), 0) AS avg_output_tps
      FROM usage_events WHERE created_at >= ?`).bind(since),
    env.USAGE.prepare(`SELECT date(created_at / 1000, 'unixepoch') AS day,
      provider_id, provider_name, COUNT(*) AS requests,
      COALESCE(SUM(output_tokens), 0) AS output_tokens
      FROM usage_events WHERE created_at >= ?
      GROUP BY day, provider_id, provider_name ORDER BY day, provider_name`).bind(since),
    env.USAGE.prepare(`SELECT provider_name AS name, COUNT(*) AS requests,
      COALESCE(SUM(total_tokens), 0) AS total_tokens,
      SUM(CASE WHEN status < 200 OR status >= 300 THEN 1 ELSE 0 END) AS errors
      FROM usage_events WHERE created_at >= ? GROUP BY provider_id, provider_name
      ORDER BY requests DESC LIMIT 20`).bind(since),
    env.USAGE.prepare(`SELECT provider_name, model AS name, COUNT(*) AS requests,
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(total_tokens), 0) AS total_tokens,
      ROUND(AVG(output_tps), 2) AS avg_output_tps,
      ROUND(AVG(first_token_ms)) AS avg_first_token_ms,
      ROUND(AVG(duration_ms)) AS avg_duration_ms,
      SUM(CASE WHEN status < 200 OR status >= 300 THEN 1 ELSE 0 END) AS errors
      FROM usage_events WHERE created_at >= ? GROUP BY provider_id, provider_name, model
      ORDER BY requests DESC, total_tokens DESC LIMIT ? OFFSET ?`).bind(since, query.modelPageSize, modelOffset),
    env.USAGE.prepare(`SELECT COUNT(*) AS total FROM (
      SELECT 1 FROM usage_events WHERE created_at >= ? GROUP BY provider_id, provider_name, model
    )`).bind(since),
    env.USAGE.prepare(`SELECT created_at, provider_name, model, status, input_tokens,
      output_tokens, total_tokens, first_token_ms, duration_ms, output_tps,
      streaming, usage_source, completed FROM usage_events
      WHERE created_at >= ? ORDER BY created_at DESC LIMIT ? OFFSET ?`).bind(since, query.logPageSize, logOffset),
    env.USAGE.prepare(`SELECT COUNT(*) AS total FROM usage_events WHERE created_at >= ?`).bind(since),
  ]);
  const summary = (summaryResult.results[0] || {
    requests: 0, successes: 0, input_tokens: 0, output_tokens: 0,
    total_tokens: 0, metered_requests: 0, exact_requests: 0, avg_latency_ms: 0,
    avg_first_token_ms: 0, avg_duration_ms: 0, avg_output_tps: 0,
  }) as UsageSummaryRow;
  return {
    range: { days: query.days, since: new Date(since).toISOString() },
    summary: {
      requests: Number(summary.requests || 0),
      successes: Number(summary.successes || 0),
      errors: Number(summary.requests || 0) - Number(summary.successes || 0),
      successRate: summary.requests ? Number(((summary.successes / summary.requests) * 100).toFixed(1)) : 0,
      inputTokens: Number(summary.input_tokens || 0),
      outputTokens: Number(summary.output_tokens || 0),
      totalTokens: Number(summary.total_tokens || 0),
      meteredRequests: Number(summary.metered_requests || 0),
      exactRequests: Number(summary.exact_requests || 0),
      avgLatencyMs: Number(summary.avg_latency_ms || 0),
      avgFirstTokenMs: Number(summary.avg_first_token_ms || 0),
      avgDurationMs: Number(summary.avg_duration_ms || 0),
      avgOutputTps: Number(summary.avg_output_tps || 0),
    },
    dailyProviders: dailyProvidersResult.results as unknown as DailyProviderRow[],
    providers: providersResult.results as unknown as BreakdownRow[],
    models: modelsResult.results as unknown as ModelBreakdownRow[],
    logs: logsResult.results,
    pagination: {
      models: {
        page: query.modelPage,
        pageSize: query.modelPageSize,
        total: Number((modelCountResult.results[0] as { total?: number } | undefined)?.total || 0),
      },
      logs: {
        page: query.logPage,
        pageSize: query.logPageSize,
        total: Number((logCountResult.results[0] as { total?: number } | undefined)?.total || 0),
      },
    },
  };
}
