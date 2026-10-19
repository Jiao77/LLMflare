import { handleAdmin } from "./admin";
import {
  cloudflareAccountId,
  enabledProviderModels,
  internalModelId,
  messagesToChat,
  proxyOpenAICompatible,
  publicModelId,
  runWorkersAI,
  workersAIBaseUrl,
  chatToMessagesPayload,
  chatToResponsesPayload,
} from "./providers";
import { authenticateClient, getProviders } from "./store";
import { chatStreamToMessages, chatStreamToResponses } from "./streaming";
import type { Env, GatewayRequest, Provider } from "./types";
import { instrumentUsageResponse } from "./usage";
import { enforceClientLimits } from "./limits";
import { bearer, cors, error, HttpError, json, readJson } from "./utils";

const NVIDIA_MESSAGES_FIRST_BYTE_TIMEOUT_MS = 60_000;
const MAX_UPSTREAM_ERROR_BYTES = 16_384;

async function boundedResponseText(response: Response, maxBytes = MAX_UPSTREAM_ERROR_BYTES): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let finished = false;
  try {
    while (bytes < maxBytes) {
      const result = await reader.read();
      if (result.done) { finished = true; break; }
      const remaining = maxBytes - bytes;
      chunks.push(result.value.byteLength <= remaining ? result.value : result.value.slice(0, remaining));
      bytes += Math.min(result.value.byteLength, remaining);
      if (result.value.byteLength > remaining) break;
    }
  } finally {
    if (!finished) await reader.cancel().catch(() => undefined);
  }
  const merged = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(merged).trim();
}

function anthropicErrorType(status: number): string {
  if (status === 401) return "authentication_error";
  if (status === 403) return "permission_error";
  if (status === 404) return "not_found_error";
  if (status === 413) return "request_too_large";
  if (status === 429) return "rate_limit_error";
  if (status === 529) return "overloaded_error";
  return status >= 500 ? "api_error" : "invalid_request_error";
}

async function messagesError(upstream: Response, providerName: string): Promise<Response> {
  const raw = await boundedResponseText(upstream);
  let detail = "";
  try {
    const data = JSON.parse(raw) as { error?: { message?: unknown }; message?: unknown };
    const candidate = data.error?.message ?? data.message;
    if (typeof candidate === "string") detail = candidate.trim();
  } catch {
    const contentType = upstream.headers.get("content-type")?.toLowerCase() || "";
    if (contentType.includes("text/plain") && raw && !raw.includes("<html")) detail = raw;
  }
  const summary = upstream.status === 524
    ? `${providerName} 上游请求超时（HTTP 524）`
    : upstream.status === 429
      ? `${providerName} 上游触发速率限制（HTTP 429）`
      : `${providerName} 上游请求失败（HTTP ${upstream.status}）`;
  const message = detail ? `${summary}：${detail}` : summary;
  return json({ type: "error", error: { type: anthropicErrorType(upstream.status), message } }, upstream.status, {
    "x-llm-provider": upstream.headers.get("x-llm-provider") || "",
    "x-upstream-status": String(upstream.status),
  });
}

function resolveProvider(providers: Provider[], body: GatewayRequest): Provider | undefined {
  if (body.provider) {
    const provider = providers.find((p) => p.id === body.provider && p.enabled);
    if (!provider || !body.model) return provider;
    const internal = internalModelId(provider, body.model);
    if (!internal) return undefined;
    body.model = internal;
    return provider;
  }
  const model = body.model || "";
  const prefix = model.includes("/") ? model.split("/")[0] : "";
  const byPrefix = providers.find((p) => p.enabled && (p.id === prefix || p.name === prefix || p.type === prefix));
  if (byPrefix) {
    const internal = internalModelId(byPrefix, model.slice(prefix.length + 1));
    if (!internal) return undefined;
    body.model = internal;
    return byPrefix;
  }
  for (const provider of providers.filter((item) => item.enabled)) {
    const internal = internalModelId(provider, model);
    if (internal) { body.model = internal; return provider; }
  }
  if (model) return undefined;
  return providers.find((p) => p.enabled && enabledProviderModels(p).length > 0);
}

async function gateway(request: Request, env: Env, ctx: ExecutionContext, path: string): Promise<Response> {
  const startedAt = Date.now();
  const clientKey = await authenticateClient(env, bearer(request));
  if (!clientKey) return error("API Key 无效", 401, "authentication_error");
  const providers = await getProviders(env);
  if (path === "/v1/models" && request.method === "GET") {
    const seen = new Set<string>();
    const data = providers.filter((p) => p.enabled).flatMap((p) => enabledProviderModels(p).map((model) => ({ id: publicModelId(p, model), object: "model", owned_by: p.name }))).filter((model) => !seen.has(model.id) && Boolean(seen.add(model.id)));
    return json({ object: "list", data });
  }
  if (request.method !== "POST") return error("仅支持 POST", 405);
  const body = await readJson<GatewayRequest>(request);
  const limitError = await enforceClientLimits(env, ctx, clientKey, body, path);
  if (limitError) return limitError;
  let provider = resolveProvider(providers, body);
  if (!provider) return error(body.model ? "该模型未启用或不属于指定提供商" : "没有可用的 AI 提供商", body.model ? 400 : 503, body.model ? "model_not_enabled" : "provider_unavailable");
  const enabledModels = enabledProviderModels(provider);
  if (!body.model) body.model = provider.defaultModel && enabledModels.includes(provider.defaultModel) ? provider.defaultModel : enabledModels[0];
  if (!body.model) return error("请求与提供商均未指定模型", 400);
  const usageProvider = provider;
  const usageModel = body.model;
  const shape = path.includes("responses") ? "responses" : path.includes("messages") || path.endsWith("/message") ? "messages" : "chat";
  let workersRest = false;
  let protocolAdapted = false;
  let response: Response | undefined;
  if (provider.type === "workers-ai") {
    const accountId = cloudflareAccountId(provider.baseUrl);
    const apiToken = provider.apiKey;
    if (!accountId || !apiToken) {
      protocolAdapted = shape !== "chat";
      response = await runWorkersAI(env, provider, body, shape);
    }
    else {
      provider = { ...provider, type: "openai-compatible", apiKey: apiToken, baseUrl: workersAIBaseUrl(accountId) };
      workersRest = true;
    }
  }
  if (!response) {
    if (shape === "responses" && (provider.type === "groq" || workersRest)) response = await proxyOpenAICompatible(provider, body, "responses", request.signal);
    else {
      protocolAdapted = shape !== "chat";
      const firstByteTimeoutMs = shape === "messages" && usageProvider.type === "nvidia" ? NVIDIA_MESSAGES_FIRST_BYTE_TIMEOUT_MS : undefined;
      const upstream = await proxyOpenAICompatible(provider, shape === "chat" ? body : messagesToChat(body), "chat/completions", request.signal, firstByteTimeoutMs);
      if (!upstream.ok) response = shape === "messages" ? await messagesError(upstream, usageProvider.name) : upstream;
      else if (shape === "chat") response = upstream;
      else if (body.stream) response = shape === "messages" ? chatStreamToMessages(upstream, body.model) : chatStreamToResponses(upstream, body.model);
      else {
        const data = await upstream.json<Record<string, unknown>>();
        if (shape === "responses") response = json(chatToResponsesPayload(data), upstream.status, { "x-llm-provider": provider.id });
        else response = json(chatToMessagesPayload(data), upstream.status, { "x-llm-provider": provider.id });
      }
    }
  }
  return instrumentUsageResponse(env, ctx, response, {
    clientKeyId: clientKey.id,
    endpoint: path,
    providerId: usageProvider.id,
    providerName: usageProvider.name,
    providerType: usageProvider.type,
    model: usageModel,
    status: response.status,
    startedAt,
    streaming: Boolean(body.stream),
    protocolAdapted,
  }, body);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url); let response: Response;
    try {
      if (request.method === "OPTIONS") response = new Response(null, { status: 204 });
      else if (url.pathname === "/health") {
        const check = url.searchParams.get("check");
        if (check === "ready" || check === "readiness") {
          const checks: Record<string, string> = {};
          let ok = true;
          try {
            await env.USAGE.prepare("SELECT 1").first();
            checks.d1 = "ready";
          } catch (e) {
            checks.d1 = `error: ${e instanceof Error ? e.message : String(e)}`;
            ok = false;
          }
          checks.kv = env.CONFIG ? "ready" : "missing";
          if (checks.kv !== "ready") ok = false;
          response = json({ ok, service: "llmflare", ...checks }, ok ? 200 : 503);
        } else {
          response = json({ ok: true, service: "llmflare" });
        }
      }
      else if (url.pathname.startsWith("/admin/")) response = await handleAdmin(request, env, url.pathname);
      else if (["/v1/chat/completions", "/v1/responses", "/v1/messages", "/v1/message", "/v1/models"].includes(url.pathname)) response = await gateway(request, env, ctx, url.pathname);
      else response = await env.ASSETS.fetch(request);
    } catch (cause) {
      if (cause instanceof HttpError) {
        response = error(cause.message, cause.status, cause.type);
      } else {
        console.error(JSON.stringify({ event: "request_error", path: url.pathname, message: cause instanceof Error ? cause.message : String(cause) }));
        response = error(cause instanceof Error ? cause.message : "内部错误", 500, "gateway_error");
      }
    }
    return cors(request, response);
  }
} satisfies ExportedHandler<Env>;
