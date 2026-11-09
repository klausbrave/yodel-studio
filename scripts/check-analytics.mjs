// Serve the built files at localhost, but exercise production-only analytics.
// All application events and RUM posts are intercepted; this check adds no live data.
import assert from "node:assert/strict";
import { chromium } from "playwright-core";

const local = process.env.YODEL_URL ?? "http://127.0.0.1:5380/";
const production = "https://yodel-studio.hackhumanity.workers.dev";
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--mute-audio"] });
const errors = [], rum = [];
async function visitor(blocked = false) {
  const context = await browser.newContext();
  const events = [];
  await context.addInitScript(() => window.addEventListener("securitypolicyviolation", event =>
    console.error("CSP " + event.effectiveDirective)));
  await context.route(production + "/**", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname === "/api/events") {
      assert.equal(request.method(), "POST");
      assert.equal(request.headers()["cookie"], undefined);
      const batch = request.postDataJSON();
      assert.deepEqual(Object.keys(batch).sort(), ["events", "version"]);
      assert.equal(batch.version, 1);
      events.push(...batch.events);
      return blocked ? route.abort() : route.fulfill({ status: 204 });
    }
    const response = await route.fetch({ url: new URL(url.pathname + url.search, local).href });
    await route.fulfill({ response });
  });
  await context.route("https://cloudflareinsights.com/**", route => {
    rum.push(route.request().postData() ?? "");
    return route.fulfill({ status: 204, headers: { "access-control-allow-origin": production } });
  });
  if (blocked) await context.route("https://static.cloudflareinsights.com/**", route => route.abort());
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error" && message.text().startsWith("CSP")) errors.push(message.text());
  });
  return { page, context, events };
}
const ready = page => page.waitForFunction(() => !document.getElementById("play").disabled);
async function play(page) {
  await page.getByRole("button", { name: "Play yodel", exact: true }).click();
  await page.getByRole("button", { name: "Pause", exact: true }).waitFor();
  await page.waitForTimeout(350);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
}
async function flush(page) {
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  await page.waitForTimeout(200);
}
function totals(events, name) {
  return events.filter(event => event.name === name).reduce((sum, event) => ({
    actions: sum.actions + event.count, visits: sum.visits + event.first,
  }), { actions: 0, visits: 0 });
}

try {
  const author = await visitor();
  await author.page.goto(production);
  await ready(author.page);
  await play(author.page);
  await play(author.page);
  await author.page.getByRole("button", { name: "Remix", exact: true }).click();
  await author.page.getByRole("textbox", { name: "Song name" }).fill("Private analytics canary");
  await author.page.getByRole("button", { name: "Create remix" }).click();
  await author.page.getByRole("button", { name: "Share", exact: true }).click();
  await author.page.waitForFunction(() => !document.getElementById("copy-link").disabled);
  const share = await author.page.locator("#song-link").inputValue();
  await author.context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: production });
  await author.page.getByRole("button", { name: "Copy link", exact: true }).click();
  await author.page.getByText("Link copied.", { exact: true }).waitFor();
  await author.page.getByRole("button", { name: "Done", exact: true }).click();
  // Renaming is not creating another remix.
  await author.page.getByRole("button", { name: "Rename song", exact: true }).click();
  await author.page.getByRole("textbox", { name: "Song name" }).fill("Still private");
  await author.page.getByRole("button", { name: "Save name", exact: true }).click();
  await flush(author.page);
  assert.deepEqual(totals(author.events, "play"), { actions: 2, visits: 1 });
  for (const name of ["remix_created", "share_created", "share_copied"])
    assert.deepEqual(totals(author.events, name), { actions: 1, visits: 1 });
  assert.deepEqual(totals(author.events, "shared_open"), { actions: 0, visits: 0 });

  const listener = await visitor();
  await listener.page.goto(share);
  await ready(listener.page);
  await play(listener.page);
  await flush(listener.page);
  assert.deepEqual(totals(listener.events, "shared_open"), { actions: 1, visits: 1 });
  assert.deepEqual(totals(listener.events, "play"), { actions: 1, visits: 1 });

  const invalid = await visitor();
  await invalid.page.goto(production + "/#song=invalid");
  await ready(invalid.page);
  await flush(invalid.page);
  assert.equal(invalid.events.filter(event => event.name !== "engagement").length, 0);

  const unavailable = await visitor(true);
  await unavailable.page.goto(production);
  await ready(unavailable.page);
  await play(unavailable.page);
  await flush(unavailable.page);
  await play(unavailable.page);
  assert.equal(await unavailable.page.locator("#error").isVisible(), false);

  const localhost = await browser.newPage();
  const outgoing = [];
  localhost.on("request", request => {
    if (new URL(request.url()).origin !== new URL(local).origin || request.method() !== "GET") outgoing.push(request.url());
  });
  await localhost.goto(local);
  await ready(localhost);
  await play(localhost);
  await flush(localhost);
  assert.deepEqual(outgoing, []);
  // A controlled clock proves that background time is excluded without a long wait.
  const timing = await visitor();
  await timing.page.goto(production);
  await ready(timing.page);
  await timing.page.evaluate(() => {
    const realNow = performance.now.bind(performance);
    let offset = 0;
    performance.now = () => realNow() + offset;
    window.advanceAnalyticsClock = ms => { offset += ms; };
    window.analyticsVisibility = value => {
      Object.defineProperty(document, "visibilityState", { value, configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    };
    window.advanceAnalyticsClock(5000);
    window.analyticsVisibility("hidden");
  });
  await timing.page.waitForTimeout(150);
  const beforeBackground = totals(timing.events, "engagement");
  await timing.page.evaluate(() => window.advanceAnalyticsClock(100_000));
  await flush(timing.page);
  assert.deepEqual(totals(timing.events, "engagement"), beforeBackground);
  await timing.page.evaluate(() => {
    window.analyticsVisibility("visible");
    window.advanceAnalyticsClock(7000);
  });
  await flush(timing.page);
  const measured = totals(timing.events, "engagement");
  assert.equal(measured.visits, 1);
  assert.ok(measured.actions >= 12 && measured.actions <= 14, JSON.stringify(measured));
  const sent = JSON.stringify([...author.events, ...listener.events, ...rum]);
  assert.ok(!sent.includes("Private analytics canary") && !sent.includes("Still private") && !sent.includes("#song="));
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ author: author.events, listener: listener.events, rumPosts: rum.length,
    localAnalyticsRequests: 0, playbackSurvivedBlockedAnalytics: true, privateSongDataSent: false,
    visibleSeconds: measured.actions, backgroundSecondsExcluded: 100 }));
} finally {
  await browser.close();
}
