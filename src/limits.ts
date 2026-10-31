import type { ClientKey, Env, GatewayRequest } from "./types";
import { error } from "./utils";

interface UsageTotals {
  daily_requests: number;
  monthly_tokens: number;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function normalizeClientLimits(input: Partial<ClientKey>): Pick<ClientKey, "requestsPerMinute" | "dailyRequestLimit" | "monthlyTokenLimit" | "maxOutputTokensPerRequest"> {
  return {
    requestsPerMinute: positiveInteger(input.requestsPerMinute),
    dailyRequestLimit: positiveInteger(input.dailyRequestLimit),
    monthlyTokenLimit: positiveInteger(input.monthlyTokenLimit),
    maxOutputTokensPerRequest: positiveInteger(input.maxOutputTokensPerRequest),
  };
}

export function clientLimitsInputError(input: Partial<ClientKey>): string | null {
  const labels: Array<[keyof ReturnType<typeof normalizeClientLimits>, string]> = [
    ["requestsPerMinute", "每分钟请求上限"],
    ["dailyRequestLimit", "过去 24 小时请求上限"],
    ["monthlyTokenLimit", "本月 Token 上限"],
    ["maxOutputTokensPerRequest", "单次最大输出 Token"],
  ];
  for (const [field, label] of labels) {
    const value = input[field];
    if (value !== undefined && value !== null && positiveInteger(value) === undefined) return `${label}必须是正整数`;
  }
  return null;
}

function quotaError(message: string, retryAfter: number): Response {
  const response = error(message, 429, "quota_exceeded");
  const headers = new Headers(response.headers);
  headers.set("retry-after", String(retryAfter));
  return new Response(response.body, { status: response.status, headers });
}

function applyOutputLimit(key: ClientKey, body: GatewayRequest, path: string): Response | null {
  const limit = key.maxOutputTokensPerRequest;
  if (!limit) return null;
  const field = path.includes("responses") ? "max_output_tokens" : "max_tokens";
  const requested = body[field];
  if (requested === undefined || requested === null) {
    body[field] = limit;
    return null;
  }
  if (typeof requested !== "number" || !Number.isSafeInteger(requested) || requested <= 0) {
    return error(`${field} 必须是正整数`, 400, "invalid_request_error");
  }
  if (requested > limit) return quotaError(`单次最大输出 Token 为 ${limit}`, 60);
  return null;
}

function utcMonthStart(now: number): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

export async function enforceClientLimits(env: Env, ctx: ExecutionContext, key: ClientKey, body: GatewayRequest, path: string, now = Date.now()): Promise<Response | null> {
  const outputError = applyOutputLimit(key, body, path);
  if (outputError) return outputError;

  if (key.dailyRequestLimit || key.monthlyTokenLimit) {
    const includeEstimates: unknown = env.MONTHLY_QUOTA_INCLUDE_ESTIMATES;
    if (includeEstimates !== undefined && includeEstimates !== "true" && includeEstimates !== "false" && includeEstimates !== true && includeEstimates !== false) {
      throw new Error("MONTHLY_QUOTA_INCLUDE_ESTIMATES 必须为 true 或 false");
    }
    const tokenColumn = includeEstimates === "false" || includeEstimates === false ? "known_tokens" : "total_tokens";
    const dayStart = now - 86_400_000;
    const monthStart = utcMonthStart(now);
    const totals = await env.USAGE.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END), 0) AS daily_requests,
        COALESCE(SUM(CASE WHEN created_at >= ? THEN ${tokenColumn} ELSE 0 END), 0) AS monthly_tokens
      FROM usage_events
      WHERE client_key_id = ? AND created_at >= ?
    `).bind(dayStart, monthStart, key.id, Math.min(dayStart, monthStart)).first<UsageTotals>();
    if (key.dailyRequestLimit && Number(totals?.daily_requests || 0) >= key.dailyRequestLimit) {
      return quotaError(`过去 24 小时请求数已达到 ${key.dailyRequestLimit} 次`, 3600);
    }
    if (key.monthlyTokenLimit && Number(totals?.monthly_tokens || 0) >= key.monthlyTokenLimit) {
      return quotaError(`本月 Token 用量已达到 ${key.monthlyTokenLimit}`, 86_400);
    }
  }

  if (key.requestsPerMinute) {
    const windowStart = Math.floor(now / 60_000) * 60_000;
    const row = await env.USAGE.prepare(`
      INSERT INTO client_rate_windows (client_key_id, window_start, request_count)
      VALUES (?, ?, 1)
      ON CONFLICT(client_key_id, window_start) DO UPDATE SET request_count = request_count + 1
      WHERE request_count < ?
      RETURNING request_count
    `).bind(key.id, windowStart, key.requestsPerMinute).first<{ request_count: number }>();
    if (!row) return quotaError(`每分钟请求数已达到 ${key.requestsPerMinute} 次`, Math.max(1, Math.ceil((windowStart + 60_000 - now) / 1000)));
    if (new Date(now).getUTCMinutes() === 0) {
      ctx.waitUntil(env.USAGE.prepare("DELETE FROM client_rate_windows WHERE window_start < ?").bind(now - 172_800_000).run().catch(() => undefined));
    }
  }

  return null;
}
