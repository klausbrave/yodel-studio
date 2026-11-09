// Exercise sharing across independent browser profiles against the production build.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { chromium } from "playwright-core";

const base = process.env.YODEL_URL ?? "http://127.0.0.1:5343/";
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--mute-audio"] });
const errors = [];
async function visitor(width = 1280) {
  const context = await browser.newContext({ viewport: { width, height: 800 } });
  await context.addInitScript(() => {
    window.addEventListener("securitypolicyviolation", (e) => console.error("CSP " + e.effectiveDirective));
    const Worklet = window.AudioWorkletNode;
    window.heard = { notes: [], rms: 0 };
    window.AudioWorkletNode = class extends Worklet {
      constructor(ctx, name, options) {
        super(ctx, name, options);
        this.port.addEventListener("message", ({ data }) => {
          if (data.type === "position" && data.sounding && window.heard.notes.at(-1) !== data.id)
            window.heard.notes.push(data.id);
          if (data.type === "telemetry") window.heard.rms = Math.max(window.heard.rms, data.t.outRms);
        });
        this.port.start();
      }
    };
  });
  const page = await context.newPage();
  page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => { if (m.type() === "error" && m.text().startsWith("CSP")) errors.push(m.text()); });
  page.on("request", r => {
    const url = new URL(r.url()), origin = new URL(base).origin;
    if (r.method() === "GET" && url.origin === origin) return;
    if (origin === "https://yodel-studio.hackhumanity.workers.dev") {
      if (r.method() === "GET" && url.href === "https://static.cloudflareinsights.com/beacon.min.js") return;
      if (r.method() === "POST" && url.origin === "https://cloudflareinsights.com" && url.pathname === "/cdn-cgi/rum") return;
      if (r.method() === "POST" && url.origin === origin && url.pathname === "/api/events") return;
    }
    errors.push(r.url());
  });
  return page;
}
const currentTitle = (p) => p.locator("#preset option:checked").textContent();
async function opened(p, title) {
  await p.waitForFunction(t => document.querySelector("#preset option:checked")?.textContent === t &&
    document.querySelectorAll(".cell").length > 0 && !document.querySelector("#play").disabled, title);
}
async function remix(p, title) {
  await p.getByRole("button", { name: "Remix", exact: true }).click();
  await p.getByRole("textbox", { name: "Song name" }).fill(title);
  await p.getByRole("button", { name: "Create remix" }).click();
  await opened(p, title);
}
async function share(p) {
  await p.getByRole("button", { name: "Share", exact: true }).click();
  await p.waitForFunction(() => document.getElementById("song-link").value && !document.getElementById("copy-link").disabled);
  const url = await p.getByRole("textbox", { name: "Song link" }).inputValue();
  assert.equal(new URL(url).origin, new URL(base).origin);
  return url;
}
const done = (p) => p.getByRole("button", { name: "Done" }).click();
const notes = (p) => p.locator(".cell").evaluateAll(cells => cells.map(c => c.getAttribute("aria-label")));
const localSong = (p) => p.evaluate(() => JSON.parse(localStorage.getItem(document.getElementById("preset").value)));
const music = (phrase) => JSON.parse(JSON.stringify(phrase, (key, value) => key === "id" ? undefined : value));

try {
  const creator = await visitor();
  await creator.goto(base);
  await creator.waitForFunction(() => !document.querySelector("#play").disabled);
  const initialTitle = await currentTitle(creator);
  assert.ok(!(await creator.locator("#preset option").allTextContents()).includes("Alpine Echo"));
  await creator.evaluate(() => localStorage.setItem("chimera.yodel-studio.v1",
    JSON.stringify({ edition: 2, preset: "Alpine Echo", drafts: {} })));
  await creator.reload();
  await opened(creator, initialTitle);
  const originalTempo = Number(await creator.locator("#tempo").inputValue());
  const github = creator.getByRole("link", { name: "Yodel Studio on GitHub (opens in a new tab)" });
  assert.equal(await github.getAttribute("href"), "https://github.com/klausbrave/yodel-studio");
  assert.equal(await github.getAttribute("target"), "_blank");
  assert.ok((await github.getAttribute("rel")).includes("noopener"));
  await opened(creator, initialTitle);
  const original = await notes(creator);
  assert.equal(original.length, initialTitle === "Yodel-ay refrain" ? 11 : 160);
  await remix(creator, "Alpine Postcard");
  assert.deepEqual(await notes(creator), original);
  await creator.locator("#edit-pitch").selectOption("62");
  await creator.locator("#transpose").press("ArrowRight");
  await creator.locator("#tempo").press("PageDown");
  await creator.locator("#jaw").press("End");
  const composition = await localSong(creator);
  assert.equal(composition.phrase.notes[0].midi, 62);
  assert.equal(composition.phrase.notes[0].mouth.jaw, 2.6);
  assert.equal(composition.phrase.transpose, 1);
  assert.ok(composition.phrase.bpm < originalTempo);
  const creatorKey = await creator.locator("#preset").inputValue();
  await creator.reload();
  await opened(creator, "Alpine Postcard");
  await creator.locator("#preset").selectOption(initialTitle);
  assert.deepEqual(await notes(creator), original);
  await creator.locator("#preset").selectOption(creatorKey);
  const expected = await notes(creator);
  const first = await share(creator);
  await creator.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(base).origin });
  await creator.getByRole("button", { name: "Copy link" }).click();
  await creator.waitForFunction(() => document.getElementById("share-status").textContent === "Link copied.");
  assert.equal(await creator.evaluate(() => navigator.clipboard.readText()), first);
  await done(creator);
  await creator.locator("#edit-pitch").selectOption("66");

  const listener = await visitor(390);
  await listener.goto(first);
  await opened(listener, "Alpine Postcard");
  assert.equal(await listener.locator("#preset").inputValue(), "shared");
  assert.equal(await listener.locator("#local-songs option").count(), 0);
  assert.equal(await listener.locator("#tempo").inputValue(), String(composition.phrase.bpm));
  assert.equal(await listener.locator("#transpose").inputValue(), "1");
  assert.deepEqual(await notes(listener), expected);
  await listener.locator(".brand").click();
  assert.equal(listener.url(), first);
  await listener.getByRole("button", { name: "Play yodel" }).click();
  await listener.waitForFunction(() => window.heard.notes.length >= 2 && window.heard.rms > 0.003);
  await listener.getByRole("button", { name: "Pause" }).click();

  await remix(listener, "The Alpine Reply");
  assert.equal(new URL(listener.url()).hash, "");
  assert.deepEqual(music((await localSong(listener)).phrase), music(composition.phrase));
  await listener.locator(".cell").first().click();
  await listener.locator("#syllable").selectOption("Oo");
  await listener.locator("#duplicate").click();
  await listener.getByRole("button", { name: "Rename song" }).click();
  await listener.getByRole("textbox", { name: "Song name" }).fill("Echo <Duet> & Co.");
  await listener.getByRole("button", { name: "Save name" }).click();
  const second = await share(listener);
  assert.notEqual(second, first);
  // Denied clipboard access leaves the complete URL selected for manual copying.
  await listener.evaluate(() => Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true }));
  await listener.getByRole("button", { name: "Copy link" }).click();
  await listener.waitForFunction(() => document.getElementById("share-status").textContent.includes("selected"));
  assert.equal(await listener.locator("#song-link").evaluate(input => input.selectionEnd - input.selectionStart), second.length);
  await done(listener);

  const next = await visitor(320);
  await next.goto(second);
  await opened(next, "Echo <Duet> & Co.");
  assert.equal(await next.locator(".cell").count(), original.length + 1);
  assert.equal(await next.locator("#syllable").inputValue(), "Oo");
  assert.equal(await next.evaluate(() => document.documentElement.scrollWidth), 320);
  await next.getByRole("button", { name: "Play yodel" }).click();
  await next.waitForFunction(() => window.heard.notes.length >= 2 && window.heard.rms > 0.003);
  await next.getByRole("button", { name: "Pause" }).click();
  await next.locator(".cell").first().click();
  // Editing a link immediately also forks, without altering either shared composition.
  await next.locator("#edit-pitch").selectOption("56");
  assert.equal(await currentTitle(next), "Echo <Duet> & Co. remix");
  assert.equal(new URL(next.url()).hash, "");
  await next.goBack();
  await opened(next, "Echo <Duet> & Co.");
  assert.equal(await next.locator("#edit-pitch").inputValue(), "62");
  await next.goto(first);
  await opened(next, "Alpine Postcard");
  assert.deepEqual(await notes(next), expected);
  await next.goto(second);
  await opened(next, "Echo <Duet> & Co.");
  await next.locator("#reset").click();
  assert.equal(await currentTitle(next), initialTitle);
  assert.equal(await next.locator("#local-songs option").count(), 1);
  await next.goto(new URL("#song=unrecognized", base).href);
  await next.waitForFunction(() => document.getElementById("song-status").textContent.includes("could not be opened"));
  assert.equal(await currentTitle(next), initialTitle);
  // With local storage unavailable, a named in-memory copy can still be kept as a share link.
  await next.goto(base);
  await opened(next, initialTitle);
  await next.evaluate(() => {
    const write = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith("chimera.yodel-remix.")) throw new DOMException("Store is full", "QuotaExceededError");
      return write.call(this, key, value);
    };
  });
  await remix(next, "Pocket yodel");
  assert.match(await next.locator("#song-status").textContent(), /Copy its share link/);
  const unsaved = await share(next);
  const bounds = await next.locator("#share-dialog").boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 320);
  assert.ok(unsaved.includes("#song="));
  await done(next);
  assert.deepEqual(errors, []);
  if (process.env.YODEL_SAMPLE_PATH) writeFileSync(process.env.YODEL_SAMPLE_PATH, new URL(first).hash + "\n");
  console.log(JSON.stringify({ sharedNotes: original.length, nextRemixNotes: original.length + 1, firstUrlCharacters: first.length,
    firstFragmentCharacters: new URL(first).hash.length, nextUrlCharacters: second.length, visitorProfiles: 3 }));
} finally {
  await browser.close();
}
