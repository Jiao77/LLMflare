const encoder = new TextEncoder();

export class HttpError extends Error {
  constructor(public readonly status: number, message: string, public readonly type = "invalid_request_error") {
    super(message);
    this.name = "HttpError";
  }
}

export function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return Response.json(data, { status, headers: { "cache-control": "no-store", ...headers } });
}

export function error(message: string, status = 400, type = "invalid_request_error"): Response {
  return json({ error: { message, type, code: status } }, status);
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function secureToken(prefix = "llmf_"): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return prefix + [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function bearer(request: Request): string {
  const value = request.headers.get("authorization") || request.headers.get("x-api-key") || "";
  return value.replace(/^Bearer\s+/i, "").trim();
}

export async function timingSafeEqual(left: string, right: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256(left), sha256(right)]);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= a.charCodeAt(i % a.length) ^ b.charCodeAt(i % b.length);
  return diff === 0;
}

export async function readJson<T>(request: Request, maxBytes = 1_000_000): Promise<T> {
  const lengthHeader = request.headers.get("content-length");
  if (lengthHeader) {
    const length = Number(lengthHeader);
    if (Number.isFinite(length) && length > maxBytes) {
      throw new HttpError(413, "请求体超过 1 MB 限制", "request_too_large");
    }
  }
  if (!request.body) {
    throw new HttpError(400, "请求体不能为空");
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let done = false;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        done = true;
        break;
      }
      bytes += result.value.byteLength;
      if (bytes > maxBytes) {
        throw new HttpError(413, "请求体超过 1 MB 限制", "request_too_large");
      }
      chunks.push(result.value);
    }
  } finally {
    if (!done) {
      await reader.cancel().catch(() => undefined);
    }
  }
  const merged = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(merged);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError(400, "请求体不是有效的 JSON 格式");
  }
}

export function cors(request: Request, response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", request.headers.get("origin") || "*");
  headers.set("access-control-allow-headers", "authorization, content-type, x-api-key");
  headers.set("access-control-allow-methods", "GET, POST, PUT, DELETE, OPTIONS");
  headers.set("vary", "Origin");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
