import type { ClientKey, Env, Provider } from "./types";
import { getClientKeys, getProviders, redactProvider, saveClientKeys, saveProviders } from "./store";
import { bearer, error, json, readJson, secureToken, sha256, timingSafeEqual } from "./utils";
import { discoverProviderModels, enabledProviderModels, normalizeProviderFreeModels, reconcileEnabledModels } from "./providers";
import { deleteProviderUsage, getUsageSummary, type UsageQuery } from "./usage";
import { clientLimitsInputError, normalizeClientLimits } from "./limits";

const PAGE_SIZES = new Set([10, 25, 50]);

function positiveInteger(value: string | null, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function pageSize(value: string | null): number {
  const parsed = positiveInteger(value, 10);
  return PAGE_SIZES.has(parsed) ? parsed : 10;
}

export function parseUsageQuery(url: string): UsageQuery {
  const params = new URL(url).searchParams;
  return {
    days: Math.min(90, positiveInteger(params.get("days"), 30)),
    modelPage: positiveInteger(params.get("modelPage"), 1),
    modelPageSize: pageSize(params.get("modelPageSize")),
    logPage: positiveInteger(params.get("logPage"), 1),
    logPageSize: pageSize(params.get("logPageSize")),
  };
}

async function authorized(request: Request, env: Env): Promise<boolean> {
  return Boolean(env.ADMIN_TOKEN) && timingSafeEqual(bearer(request), env.ADMIN_TOKEN);
}

export async function handleAdmin(request: Request, env: Env, path: string): Promise<Response> {
  if (!(await authorized(request, env))) return error("管理员凭据无效", 401, "authentication_error");
  if (path === "/admin/session" && request.method === "GET") return json({ authenticated: true });
  if (path === "/admin/usage" && request.method === "GET") {
    return json(await getUsageSummary(env, parseUsageQuery(request.url)));
  }

  if (path === "/admin/providers" && request.method === "GET") return json({ data: (await getProviders(env)).map(redactProvider) });
  if (path === "/admin/providers/discover" && request.method === "POST") {
    const input = await readJson<Partial<Provider>>(request);
    const stored = input.id ? (await getProviders(env)).find((provider) => provider.id === input.id) : undefined;
    const type = input.type || stored?.type;
    if (!type) return error("请先选择提供商类型");
    const candidate: Provider = { id: stored?.id || "preview", name: input.name || stored?.name || "preview", type, enabled: true, apiKey: input.apiKey || stored?.apiKey, baseUrl: input.baseUrl ?? stored?.baseUrl, models: [] };
    try { const catalog = await discoverProviderModels(candidate, env); return json({ data: catalog.models, count: catalog.models.length, freeModels: catalog.freeModels, freeCount: catalog.freeModels.length }); }
    catch (cause) { return error(cause instanceof Error ? cause.message : "模型发现失败", 400, "provider_discovery_error"); }
  }
  if (path === "/admin/providers" && request.method === "POST") {
    const input = await readJson<Partial<Provider>>(request);
    if (!input.name || !input.type) return error("name 和 type 为必填项");
    const providers = await getProviders(env);
    const models = input.models || [];
    const enabledModels = Array.isArray(input.enabledModels) ? models.filter((model) => input.enabledModels?.includes(model)) : [...models];
    const freeModels = normalizeProviderFreeModels({ type: input.type, models, freeModels: input.freeModels });
    const provider: Provider = { id: crypto.randomUUID(), name: input.name, type: input.type, enabled: input.enabled !== false, apiKey: input.apiKey, baseUrl: input.baseUrl, models, freeModels, enabledModels, defaultModel: enabledModels.includes(input.defaultModel || "") ? input.defaultModel : enabledModels[0] };
    providers.push(provider); await saveProviders(env, providers); return json(redactProvider(provider), 201);
  }
  const providerMatch = path.match(/^\/admin\/providers\/([^/]+)$/);
  if (providerMatch && request.method === "PUT") {
    const input = await readJson<Partial<Provider>>(request); const providers = await getProviders(env); const index = providers.findIndex((p) => p.id === providerMatch[1]);
    if (index < 0) return error("提供商不存在", 404); const prior = providers[index]; const next = { ...prior, ...input, id: prior.id, apiKey: input.apiKey || prior.apiKey };
    if (Array.isArray(input.enabledModels)) next.enabledModels = next.models.filter((model) => input.enabledModels?.includes(model));
    else if (input.models && prior.enabledModels !== undefined) next.enabledModels = next.models.filter((model) => prior.enabledModels?.includes(model));
    next.freeModels = normalizeProviderFreeModels(next);
    const enabledModels = enabledProviderModels(next);
    if (!next.defaultModel || !enabledModels.includes(next.defaultModel)) next.defaultModel = enabledModels[0];
    providers[index] = next;
    await saveProviders(env, providers); return json(redactProvider(providers[index]));
  }
  if (providerMatch && request.method === "DELETE") {
    const providers = await getProviders(env);
    const providerId = providerMatch[1];
    if (!providers.some((provider) => provider.id === providerId)) return error("提供商不存在", 404);
    await saveProviders(env, providers.filter((provider) => provider.id !== providerId));
    await deleteProviderUsage(env, providerId);
    return new Response(null, { status: 204 });
  }
  const discoverMatch = path.match(/^\/admin\/providers\/([^/]+)\/discover$/);
  if (discoverMatch && request.method === "POST") {
    const providers = await getProviders(env); const index = providers.findIndex((p) => p.id === discoverMatch[1]);
    if (index < 0) return error("提供商不存在", 404);
    try { const catalog = await discoverProviderModels(providers[index], env); const priorSelection = providers[index].enabledModels; providers[index].models = catalog.models; providers[index].freeModels = catalog.freeModels;
      providers[index].enabledModels = reconcileEnabledModels(priorSelection, catalog.models);
      const enabledModels = enabledProviderModels(providers[index]); if (!providers[index].defaultModel || !enabledModels.includes(providers[index].defaultModel || "")) providers[index].defaultModel = enabledModels[0];
      await saveProviders(env, providers); return json({ data: catalog.models, count: catalog.models.length, freeModels: catalog.freeModels, freeCount: catalog.freeModels.length, provider: redactProvider(providers[index]) }); }
    catch (cause) { return error(cause instanceof Error ? cause.message : "模型发现失败", 400, "provider_discovery_error"); }
  }

  if (path === "/admin/keys" && request.method === "GET") { const keys = await getClientKeys(env); return json({ data: keys.map(({ hash, ...safe }) => safe) }); }
  if (path === "/admin/keys" && request.method === "POST") {
    const input = await readJson<Partial<ClientKey> & { key?: string }>(request); const raw = input.key?.trim() || secureToken();
    if (raw.length < 24) return error("自定义密钥至少需要 24 个字符");
    const limitError = clientLimitsInputError(input); if (limitError) return error(limitError);
    const keys = await getClientKeys(env); const item: ClientKey = { id: crypto.randomUUID(), name: input.name || "未命名密钥", hash: await sha256(raw), key: raw, prefix: `${raw.slice(0, 10)}…${raw.slice(-4)}`, enabled: true, createdAt: new Date().toISOString(), ...normalizeClientLimits(input) };
    keys.push(item); await saveClientKeys(env, keys); const { hash, ...safe } = item; return json({ ...safe, key: raw }, 201);
  }
  const keyMatch = path.match(/^\/admin\/keys\/([^/]+)$/);
  if (keyMatch && request.method === "PUT") {
    const input = await readJson<Partial<ClientKey>>(request); const keys = await getClientKeys(env); const index = keys.findIndex((key) => key.id === keyMatch[1]);
    if (index < 0) return error("客户端密钥不存在", 404);
    const limitError = clientLimitsInputError(input); if (limitError) return error(limitError);
    const limitFields = ["requestsPerMinute", "dailyRequestLimit", "monthlyTokenLimit", "maxOutputTokensPerRequest"] as const;
    const normalized = normalizeClientLimits(input);
    const limitPatch = Object.fromEntries(limitFields.filter((field) => Object.hasOwn(input, field)).map((field) => [field, normalized[field]]));
    let keyUpdate: Partial<ClientKey> = {};
    if (input.key && typeof input.key === "string" && input.key.trim().length >= 24) {
      const raw = input.key.trim();
      keyUpdate = { key: raw, hash: await sha256(raw), prefix: `${raw.slice(0, 10)}…${raw.slice(-4)}` };
    }
    keys[index] = { ...keys[index], name: input.name?.trim() || keys[index].name, enabled: input.enabled ?? keys[index].enabled, ...limitPatch, ...keyUpdate };
    await saveClientKeys(env, keys); const { hash, ...safe } = keys[index]; return json(safe);
  }
  if (keyMatch && request.method === "DELETE") { const keys = await getClientKeys(env); await saveClientKeys(env, keys.filter((key) => key.id !== keyMatch[1])); return new Response(null, { status: 204 }); }
  return error("管理接口不存在", 404);
}
