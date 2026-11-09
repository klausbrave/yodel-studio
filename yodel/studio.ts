import { Singer } from "./audio";
import { Editor } from "./editor";
import { SongMenu } from "./song-menu";
import { Portrait, drawFolds, PitchTrace } from "./views";
import {
  clamp,
  defaultPreset,
  frequency,
  highNote,
  inFalsetto,
  lowNote,
  noteName,
  presets,
  validPhrase,
  withDrag,
  type DragAdjustment,
  type Note,
  type Phrase,
  type Preset,
} from "./score";
import { dragMouth, stepMouth, type MouthPart } from "./mouth";
import type { HumanArtic } from "../src/wasm/types";
import type { TelemetryMessage } from "../src/worklet/protocol";

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const storageKey = "chimera.yodel-studio.v1";
let initialSong: string = defaultPreset;
const drafts = {} as Partial<Record<Preset, Phrase>>;
let loop = true;
let holdOnDrag = false;
try {
  const saved = JSON.parse(localStorage.getItem(storageKey) ?? "null");
  // Introduce the published performance once while retaining every pre-existing draft.
  if (saved?.edition === 2 && typeof saved.preset === "string") initialSong = saved.preset;
  for (const key of Object.keys(presets) as Preset[])
    if (validPhrase(saved?.drafts?.[key])) drafts[key] = saved.drafts[key];
  if (typeof saved?.loop === "boolean") loop = saved.loop;
  if (typeof saved?.holdOnDrag === "boolean") holdOnDrag = saved.holdOnDrag;
} catch {
  /* Storage may be disabled in private browsing. */
}
// Previously shared preset links now open the published yodel.
const url = new URL(location.href);
const legacyLink = url.searchParams.has("preset");
if (legacyLink) {
  initialSong = defaultPreset;
  url.searchParams.delete("preset");
  history.replaceState(history.state, "", url);
}
const songs = new SongMenu(drafts, initialSong, () => {
  phrase = songs.current.phrase;
  resetCursor();
});
if (legacyLink) save();
function save() {
  try {
    localStorage.setItem(storageKey, JSON.stringify({ edition: 2, preset: songs.localKey, drafts, loop, holdOnDrag }));
  } catch {
    /* In-memory editing still works. */
  }
}

let phrase = songs.current.phrase;
let selected = phrase.notes[0].id,
  cursor = selected;
let playing = false,
  held = false,
  sounding = false,
  requestedPlay = false;
let intent = 0,
  status = 0;
let telemetry: TelemetryMessage | null = null;
interface Grab {
  id: string;
  key: number | string;
  startX: number;
  startY: number;
  x: number;
  y: number;
  midi: number;
  part: "folds" | "throat" | "tongue" | MouthPart;
  live: boolean;
  adjustment: DragAdjustment | null;
  origin: HumanArtic;
}
let grab: Grab | null = null;

const portrait = new Portrait(),
  trace = new PitchTrace();
const singer = new Singer(
  (message) => {
    if (message.type === "telemetry") {
      if (sounding) {
        telemetry = message;
        trace.record(message, inFalsetto(currentNote()));
      }
    } else if (message.type === "position") {
      if (!phrase.notes.some((n) => n.id === message.id)) return;
      cursor = message.id;
      playing = message.playing;
      sounding = message.sounding;
      if (message.ended) {
        cancelGrab();
        requestedPlay = false;
        held = false;
        selected = phrase.notes[0].id;
        renderEditor();
        editor.rewind();
      }
      syncTransport();
    }
  },
  () => {
    singer.send({ type: "score", phrase, restart: true });
    singer.send({ type: "loop", on: loop });
  },
  audioError,
);

function audioError(message: string) {
  requestedPlay = playing = sounding = held = false;
  grab = null;
  ++intent;
  status = 0;
  el("error").hidden = false;
  el("error").textContent = message;
  syncTransport();
}
const editor = new Editor(
  (id) => {
    selected = cursor = id;
    singer.send({ type: "seek", id });
    renderEditor();
  },
  (notes, id) => {
    selected = id;
    if (!sounding || !notes.some((n) => n.id === cursor)) cursor = id;
    update({ ...phrase, notes });
    if (!sounding) singer.send({ type: "seek", id });
  },
  resetAll,
);

function resetAll() {
  ++intent;
  cancelGrab();
  requestedPlay = playing = sounding = held = false;
  status = 0;
  singer.send({ type: "pause" });
  singer.volume(false);
  syncMute();
  loop = true;
  holdOnDrag = false;
  singer.send({ type: "loop", on: true });
  songs.reset();
  phrase = songs.current.phrase;
  telemetry = null;
  trace.clear();
  portrait.reset();
  try {
    localStorage.removeItem(storageKey);
  } catch {
    /* Private browsing. */
  }
  el("error").hidden = true;
  resetCursor();
  el("reset-status").textContent = "Factory settings restored.";
}

function resetCursor() {
  cancelGrab();
  selected = cursor = phrase.notes[0].id;
  held = false;
  singer.send({ type: "hold", on: false });
  singer.send({ type: "score", phrase, restart: true });
  renderEditor();
  editor.rewind();
  syncTransport();
  save();
}
function update(next: Phrase) {
  phrase = next;
  songs.update(next);
  el("reset-status").textContent = "";
  singer.send({ type: "score", phrase });
  renderEditor();
  save();
}
function renderEditor() {
  editor.render(phrase, selected);
  const tempo = el<HTMLInputElement>("tempo");
  const base = songs.current.baseBpm;
  tempo.max = String(Math.max(base * 2, phrase.bpm));
  tempo.value = String(phrase.bpm);
  const speed = Number((phrase.bpm / base).toFixed(2)) + "×";
  el<HTMLOutputElement>("bpm").value = speed;
  el("tempo").setAttribute("aria-valuetext", speed + " speed, " + phrase.bpm + " beats per minute");
  const shift = phrase.transpose ?? 0;
  el<HTMLInputElement>("transpose").value = String(shift);
  const pitchText = shift === 0 ? "Original" : (shift > 0 ? "+" : "") + shift + " st";
  el<HTMLOutputElement>("shift").value = pitchText;
  el("transpose").setAttribute("aria-valuetext", shift + " semitones");
  syncPitchSliders(currentNote().midi + shift, shift);
}

function syncPitchSliders(midi: number, shift: number) {
  for (const id of ["fold-pad", "larynx"]) {
    el(id).setAttribute("aria-valuemin", String(lowNote + shift));
    el(id).setAttribute("aria-valuemax", String(highNote + shift));
    el(id).setAttribute("aria-valuenow", String(midi));
    el(id).setAttribute("aria-valuetext", noteName(midi));
  }
}

function scoreNote() {
  const id = grab && !grab.live ? grab.id : playing || sounding ? cursor : selected;
  return phrase.notes.find((n) => n.id === id) ?? phrase.notes[0];
}
function currentNote() {
  return withDrag(scoreNote(), grab?.live ? grab.adjustment : null);
}
function adjustGrab(adjustment: DragAdjustment) {
  if (!grab) return;
  if (adjustment.mouth && grab.adjustment?.mouth)
    adjustment = { mouth: { ...grab.adjustment.mouth, ...adjustment.mouth } };
  grab.adjustment = adjustment;
  if (grab.live) {
    singer.send({ type: "expression", adjustment });
    return;
  }
  const note = scoreNote();
  const edited = withDrag(note, adjustment, grab.midi);
  if (
    note.midi === edited.midi && note.larynx === edited.larynx && note.root === edited.root &&
    note.tongue === edited.tongue && note.mouth === edited.mouth
  ) return;
  update({ ...phrase, notes: phrase.notes.map((n) => (n === note ? edited : n)) });
}
function syncTransport() {
  const play = el<HTMLButtonElement>("play"),
    hold = el<HTMLButtonElement>("hold");
  play.disabled = false;
  play.classList.toggle("is-playing", requestedPlay);
  play.querySelector("span")!.textContent = status ? "Starting…" : requestedPlay ? "Pause" : "Play yodel";
  hold.disabled = !playing;
  hold.setAttribute("aria-pressed", String(held));
  el("loop").setAttribute("aria-pressed", String(loop));
  el("hold-on-drag").setAttribute("aria-pressed", String(holdOnDrag));
  editor.playhead(sounding ? cursor : "");
}
async function togglePlay() {
  el("error").hidden = true;
  const ticket = ++intent;
  if (requestedPlay) {
    requestedPlay = false;
    status = 0;
    held = false;
    cancelGrab();
    selected = cursor;
    renderEditor();
    singer.send({ type: "pause" });
    syncTransport();
    return;
  }
  requestedPlay = true;
  syncGrabMode();
  status = 1;
  syncTransport();
  try {
    await singer.start();
    if (ticket !== intent || !requestedPlay) return;
    status = 0;
    singer.send({ type: "play", id: cursor });
    if (grab?.live && grab.adjustment) singer.send({ type: "expression", adjustment: grab.adjustment });
    syncTransport();
  } catch (err) {
    if (ticket === intent) audioError("Audio could not start. Try Play again. " + String(err));
  }
}
el("play").onclick = togglePlay;
el("hold").onclick = () => {
  held = !held;
  singer.send({ type: "hold", on: held });
  syncGrabMode();
  syncTransport();
};
el("loop").onclick = () => {
  loop = !loop;
  singer.send({ type: "loop", on: loop });
  syncTransport();
  save();
};
el("hold-on-drag").onclick = () => {
  holdOnDrag = !holdOnDrag;
  syncGrabMode();
  syncTransport();
  save();
};
el<HTMLInputElement>("transpose").oninput = (e) =>
  update({ ...phrase, transpose: Number((e.target as HTMLInputElement).value) });
el<HTMLInputElement>("tempo").oninput = (e) => update({ ...phrase, bpm: Number((e.target as HTMLInputElement).value) });
function syncMute() {
  el("mute").setAttribute("aria-pressed", String(singer.muted));
  el("mute").setAttribute("aria-label", singer.muted ? "Unmute audio" : "Mute audio");
  el("mute-label").textContent = singer.muted ? "Muted" : "Sound on";
}
el("mute").onclick = () => {
  singer.volume(!singer.muted);
  syncMute();
};

function dragFollowsPlayback() {
  return requestedPlay && !holdOnDrag && !held;
}
function beginGrab(key: number | string, part: Grab["part"], x = 0, y = 0) {
  if (grab) return;
  const n = currentNote();
  const session: Grab = {
    key,
    id: n.id,
    startX: x,
    startY: y,
    x,
    y,
    midi: n.midi,
    part,
    live: dragFollowsPlayback(),
    adjustment: null,
    origin: { ...portrait.artic },
  };
  grab = session;
  if (session.live) return;
  selected = n.id;
  renderEditor();
  el("error").hidden = true;
  void singer
    .start()
    .then(() => {
      if (grab !== session) return;
      singer.send({ type: "grab", id: session.id });
    })
    .catch((err) => {
      if (grab === session) audioError("Audio could not start. Try again. " + String(err));
    });
}
function cancelGrab(key?: number | string) {
  if (!grab || (key !== undefined && grab.key !== key)) return;
  if (grab.live) singer.send({ type: "expression", adjustment: null });
  else singer.send({ type: "drop" });
  grab = null;
}
function syncGrabMode() {
  if (!grab || grab.live === dragFollowsPlayback()) return;
  const { key, part, x, y } = grab;
  cancelGrab();
  beginGrab(key, part, x, y);
}
for (const id of ["fold-pad", "larynx", "throat", "tongue", "lips", "jaw", "velum"] as const) {
  const pad = el(id),
    part = id === "fold-pad" || id === "larynx" ? "folds" : id;
  pad.onpointerdown = (e) => {
    if (e.button !== 0 || grab) return;
    e.preventDefault();
    pad.focus({ preventScroll: true });
    pad.setPointerCapture(e.pointerId);
    beginGrab(e.pointerId, part, e.clientX, e.clientY);
  };
  pad.onpointermove = (e) => {
    if (!grab || grab.key !== e.pointerId) return;
    grab.x = e.clientX;
    grab.y = e.clientY;
    const dx = e.clientX - grab.startX,
      dy = e.clientY - grab.startY;
    if (part === "tongue") {
      adjustGrab({ tongue: portrait.tongueAt(grab.origin, dx, dy) });
    } else if (part === "throat") {
      adjustGrab({ root: clamp(Math.round((grab.origin.root + dx / 40) * 40) / 40, -1, 1) });
    } else if (part !== "folds") {
      const cm = portrait.cmPerPixel;
      adjustGrab({ mouth: dragMouth(part, grab.origin, dx * cm, dy * cm, e.shiftKey) });
    } else {
      const lift = clamp(Math.round((grab.origin.larynx - dy / 50) * 25) / 25, -1.6, 1.6);
      adjustGrab({ bend: -Math.round(dy / 5), larynx: lift });
    }
  };
  pad.onlostpointercapture = (e) => cancelGrab(e.pointerId);
  pad.onpointercancel = (e) => cancelGrab(e.pointerId);
  pad.onpointerup = (e) => cancelGrab(e.pointerId);
  pad.onkeydown = (e) => {
    if (e.key === "Escape") {
      cancelGrab();
      return;
    }
    if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    if (!grab) beginGrab("keyboard", part);
    if (!grab || grab.key !== "keyboard") return;
    const sign = e.key === "ArrowUp" || e.key === "ArrowRight" ? 1 : -1;
    if (part === "tongue") {
      const tongue = portrait.tongueAt(
        currentNote().tongue ?? grab.origin,
        e.key === "ArrowLeft" || e.key === "ArrowRight" ? sign * 3 : 0,
        e.key === "ArrowUp" || e.key === "ArrowDown" ? -sign * 3 : 0,
      );
      adjustGrab({ tongue });
    } else if (part === "throat") {
      adjustGrab({
        root:
          e.key === "Home"
            ? -1
            : e.key === "End"
              ? 1
              : clamp((currentNote().root ?? grab.origin.root) + sign * 0.1, -1, 1),
      });
    } else if (part !== "folds") {
      adjustGrab({ mouth: stepMouth(part, { ...grab.origin, ...currentNote().mouth }, e.key, e.shiftKey) });
    } else {
      const pitch = e.key === "Home" ? lowNote : e.key === "End" ? highNote : clamp(currentNote().midi + sign, lowNote, highNote);
      adjustGrab({ bend: pitch - (grab.live ? scoreNote().midi : grab.midi) });
    }
  };
  pad.onkeyup = () => cancelGrab("keyboard");
  pad.onblur = () => cancelGrab("keyboard");
}
window.addEventListener("blur", () => cancelGrab());
window.addEventListener("pagehide", () => {
  ++intent;
  cancelGrab();
  requestedPlay = held = false;
  status = 0;
  singer.send({ type: "pause" });
  syncTransport();
});

let last = 0;
const folds = el<HTMLCanvasElement>("folds"),
  plot = el<HTMLCanvasElement>("trace");
const regs = el("register"),
  noteNameEl = el("pitch-name"),
  hzEl = el("pitch-hz");
let priorNote: Note | null = null,
  priorTelemetry: TelemetryMessage | null = null,
  wasSounding = false;
let priorShift = 0;
let resized = true;
new ResizeObserver(() => {
  resized = true;
}).observe(folds);
function paint(now: number) {
  requestAnimationFrame(paint);
  if (now - last < 1000 / 30) return;
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  const note = currentNote(),
    t = telemetry?.t;
  portrait.draw(sounding ? telemetry : null, note, dt);
  const shift = phrase.transpose ?? 0,
    midi = note.midi + shift;
  if (
    !resized &&
    priorShift === shift &&
    priorNote === note &&
    priorTelemetry === telemetry &&
    wasSounding === sounding
  )
    return;
  priorNote = note;
  priorShift = shift;
  priorTelemetry = telemetry;
  wasSounding = sounding;
  resized = false;
  const live = sounding && !!t && t.voicing > 0.25 && t.outRms > 0.001;
  const hz = live ? t.f0 : frequency(midi);
  const label = noteName(midi);
  drawFolds(folds, note, telemetry, sounding);
  trace.draw(plot);
  noteNameEl.textContent = label;
  hzEl.textContent = Math.round(hz) + " Hz";
  el("syllable-readout").textContent = playing && !sounding ? "·" : note.syllable;
  regs.textContent = inFalsetto(note) ? "Falsetto" : "Chest voice";
  regs.classList.toggle("high", inFalsetto(note));
  folds.parentElement!.style.setProperty("--marker", ((highNote - note.midi) / (highNote - lowNote)) * 100 + "%");
  folds.parentElement!.style.setProperty("--marker-color", inFalsetto(note) ? "var(--ice)" : "var(--amber)");
  el("throat").setAttribute("aria-valuenow", portrait.artic.root.toFixed(2));
  syncPitchSliders(midi, shift);
}
if (await songs.readLocation()) {
  phrase = songs.current.phrase;
  selected = cursor = phrase.notes[0].id;
}
renderEditor();
syncTransport();
requestAnimationFrame(paint);
