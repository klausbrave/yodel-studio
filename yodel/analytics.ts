import type { UsageAction, UsageBatch, UsageCount, UsageEvent } from "../shared/analytics";

// This is a public collection ID, not an API credential. Forks and localhost
// do not send analytics to the hosted studio's account.
const enabled = location.hostname === "yodel-studio.hackhumanity.workers.dev";
const seen = new Set<UsageEvent>();
const pending = new Map<UsageEvent, UsageCount>();
let timer: ReturnType<typeof setTimeout> | undefined;
let visibleSince: number | null = document.visibilityState === "visible" ? performance.now() : null;
let remainderMs = 0;

function addCount(name: UsageEvent, count: number) {
  const previous = pending.get(name);
  pending.set(name, {
    name,
    count: Math.min(name === "engagement" ? 300 : 100, (previous?.count ?? 0) + count),
    first: previous?.first ?? (seen.has(name) ? 0 : 1),
  });
  seen.add(name);
}

function accrueVisibleTime() {
  const now = performance.now();
  if (visibleSince !== null) {
    remainderMs += Math.max(0, now - visibleSince);
    visibleSince = now;
  }
  const seconds = Math.floor(remainderMs / 1000);
  if (seconds > 0) {
    addCount("engagement", seconds);
    remainderMs -= seconds * 1000;
  }
}

function flush() {
  accrueVisibleTime();
  clearTimeout(timer);
  timer = undefined;
  if (!pending.size) return;
  const batch: UsageBatch = { version: 1, events: Array.from(pending.values()) };
  pending.clear();
  // No cookies, identifiers, titles, notes, URLs or mouth settings are sent.
  // Never block the instrument or retry failed analytics requests.
  void fetch("/api/events", {
    method: "POST",
    credentials: "omit",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(batch),
    keepalive: true,
  }).catch(() => {});
}

export function trackUsage(name: UsageAction) {
  if (!enabled) return;
  addCount(name, 1);
  timer ??= setTimeout(flush, 2000);
}

if (enabled) {
  const script = document.createElement("script");
  script.type = "module";
  script.src = "https://static.cloudflareinsights.com/beacon.min.js";
  script.dataset.cfBeacon = JSON.stringify({ token: "3e35a3f18a694d6eabbb24199f68e89b", spa: false });
  document.head.append(script);
  addCount("engagement", 0);
  timer = setTimeout(flush, 2000);
  setInterval(flush, 30_000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      flush();
      visibleSince = null;
    } else visibleSince = performance.now();
  });
  window.addEventListener("pagehide", () => {
    flush();
    visibleSince = null;
  });
  window.addEventListener("pageshow", () => {
    visibleSince = document.visibilityState === "visible" ? performance.now() : null;
  });
}
