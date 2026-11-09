import { expect, test } from "bun:test";
import worker from "../worker/index.ts";

const origin = "https://yodel-studio.hackhumanity.workers.dev";
const valid = { version: 1, events: [{ name: "play", count: 2, first: 1 }] };
function fixture({ limited = false, fails = false } = {}) {
  const writes = [];
  const env = {
    PUBLIC_ORIGIN: origin,
    EVENT_LIMITER: { limit: async () => ({ success: !limited }) },
    USAGE: { writeDataPoint: data => { if (fails) throw Error("unavailable"); writes.push(data); } },
  };
  const send = (body = valid, options = {}) => worker.fetch(new Request(origin + "/api/events", {
    method: "POST", headers: { origin, "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: typeof body === "string" ? body : JSON.stringify(body), ...options,
  }), env);
  return { send, writes, env };
}

test("writes action and first-visit counts with no user data", async () => {
  const { send, writes } = fixture();
  const result = await send({ version: 1, events: [
    { name: "play", count: 2, first: 1 }, { name: "share_copied", count: 1, first: 0 },
  ] });
  expect(result.status).toBe(204);
  expect(result.headers.get("cache-control")).toBe("no-store");
  expect(result.headers.has("access-control-allow-origin")).toBe(false);
  expect(writes.map(({ blobs, doubles }) => ({ blobs, doubles }))).toEqual([
    { blobs: ["play"], doubles: [2, 1] }, { blobs: ["share_copied"], doubles: [1, 0] },
  ]);
  expect(writes[0].indexes[0]).toMatch(/^[0-9a-f-]{36}$/);
  expect(writes[0].indexes).toEqual(writes[1].indexes);
  await send();
  expect(writes[2].indexes).not.toEqual(writes[0].indexes);
});

test.each([
  "{", "null", "[]", "x".repeat(1025),
  { ...valid, title: "private song title" }, { ...valid, version: 2 }, { version: 1, events: [] },
  { version: 1, events: [...valid.events, ...valid.events] },
  ...[0, -1, 1.2, 101, "1"].map(count => ({ version: 1, events: [{ name: "play", count, first: 1 }] })),
  { version: 1, events: [{ name: "arbitrary", count: 1, first: 1 }] },
  { version: 1, events: [{ name: "play", count: 1, first: 2 }] },
  { version: 1, events: [{ name: "play", count: 1, first: 1, song: "private" }] },
])("rejects invalid or excessive event data: %j", async body => {
  const { send, writes } = fixture();
  expect((await send(body)).status).toBe(400);
  expect(writes).toEqual([]);
});

test("rejects cross-origin posts, wrong content types and non-POST routes", async () => {
  const { send, writes, env } = fixture();
  for (const headers of [
    { "content-type": "application/json" },
    { origin: "https://elsewhere.example", "content-type": "application/json" },
    { origin, "content-type": "application/json", "sec-fetch-site": "cross-site" },
  ]) expect((await send(valid, { headers })).status).toBe(403);
  expect((await send(valid, { headers: { origin, "content-type": "text/plain" } })).status).toBe(415);
  expect((await worker.fetch(new Request(origin + "/api/events"), env)).status).toBe(405);
  expect((await worker.fetch(new Request(origin + "/elsewhere"), env)).status).toBe(404);
  expect((await worker.fetch(new Request(origin + "/api/events?song=private"), env)).status).toBe(404);
  expect(writes).toEqual([]);
});

test("bounds a chunked request body even without Content-Length", async () => {
  const { send, writes } = fixture();
  const stream = new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array(700));
    controller.enqueue(new Uint8Array(700));
    controller.close();
  } });
  expect((await send(valid, { body: stream, duplex: "half" })).status).toBe(400);
  expect(writes).toEqual([]);
});

test("accepts short-visit and elapsed-time measurements but caps their size", async () => {
  const { send, writes } = fixture();
  expect((await send({ version: 1, events: [{ name: "engagement", count: 0, first: 1 }] })).status).toBe(204);
  expect((await send({ version: 1, events: [{ name: "engagement", count: 30, first: 0 }] })).status).toBe(204);
  expect((await send({ version: 1, events: [{ name: "engagement", count: 301, first: 0 }] })).status).toBe(400);
  expect(writes.map(write => write.doubles)).toEqual([[0, 1], [30, 0]]);
});

test("rate limits before writing and reports unavailable analytics", async () => {
  const limited = fixture({ limited: true });
  expect((await limited.send()).status).toBe(429);
  expect(limited.writes).toEqual([]);
  expect((await fixture({ fails: true }).send()).status).toBe(503);
});
