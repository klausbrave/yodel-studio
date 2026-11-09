import { validUsageBatch } from "../shared/analytics";

const maxBytes = 1024;
const headers = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};
const response = (status: number) => new Response(null, { status, headers });

// Bound the actual stream, including requests without Content-Length.
async function readBatch(request: Request): Promise<unknown> {
  if (!request.body || Number(request.headers.get("content-length")) > maxBytes) return null;
  const reader = request.body.getReader();
  const bytes = new Uint8Array(maxBytes);
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.byteLength > maxBytes) {
        await reader.cancel();
        return null;
      }
      bytes.set(value, size);
      size += value.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(bytes.subarray(0, size)));
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/api/events" || url.search) return response(404);
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { ...headers, Allow: "POST" } });
    if (request.headers.get("origin") !== env.PUBLIC_ORIGIN ||
        (request.headers.has("sec-fetch-site") && request.headers.get("sec-fetch-site") !== "same-origin")) return response(403);
    if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") return response(415);
    const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
    if (!(await env.EVENT_LIMITER.limit({ key: ip })).success) return response(429);
    const batch = await readBatch(request);
    if (!validUsageBatch(batch)) return response(400);
    try {
      // A fresh sampling key per batch; no visitor identifier or IP is stored.
      const key = crypto.randomUUID();
      for (const event of batch.events) {
        env.USAGE.writeDataPoint({ indexes: [key], blobs: [event.name], doubles: [event.count, event.first] });
      }
      return response(204);
    } catch {
      console.error({ event: "usage_write_failed" });
      return response(503);
    }
  },
} satisfies ExportedHandler<Env>;
