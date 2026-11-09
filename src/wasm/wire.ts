/**
 * The engine's binary gesture records (layout version 2, crates/chimera-wasm/src/lib.rs): how
 * gestures cross into the wasm engine on the audio thread, where JSON and TextEncoder are out of
 * reach. 280 little-endian bytes per gesture; NaN marks an absent value.
 */
import type { Gesture } from "./types.ts";

export const LAYOUT_VERSION = 2;
export const GESTURE_RECORD = 280;

/** Control keys in the engine's order: the 17 articulators, then the source channels. */
export const CONTROL_KEYS = [
  "jaw", "tbX", "tbY", "ttX", "ttY", "ttCurl", "root", "lipAp", "lipProt", "lipWidth", "labiodental", "velum", "larynx", "epilarynx", "ventricular", "lateral", "dorsum",
  "abduction", "closure", "breath", "f0", "vibrato", "posteriorGap",
] as const;
const KEY_INDEX: Record<string, number> = Object.fromEntries(CONTROL_KEYS.map((k, i) => [k, i]));
const LABEL_CAP = 24;
const LABEL_OFFSET = 64 + CONTROL_KEYS.length * 8;

/** UTF-8 encode (no TextEncoder in the AudioWorkletGlobalScope). */
export function utf8(s: string): number[] {
  const out: number[] = [];
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

/** UTF-8 decode (no TextDecoder in the AudioWorkletGlobalScope). */
export function fromUtf8(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; ) {
    const c = b[i];
    let cp: number;
    if (c < 0x80) (cp = c), (i += 1);
    else if (c < 0xe0) (cp = ((c & 31) << 6) | (b[i + 1] & 63)), (i += 2);
    else if (c < 0xf0) (cp = ((c & 15) << 12) | ((b[i + 1] & 63) << 6) | (b[i + 2] & 63)), (i += 3);
    else (cp = ((c & 7) << 18) | ((b[i + 1] & 63) << 12) | ((b[i + 2] & 63) << 6) | (b[i + 3] & 63)), (i += 4);
    s += String.fromCodePoint(cp);
  }
  return s;
}

/** Write gestures as records at byte offset `at` of `buf` (as many as fit in `max`). Returns the count written. */
export function writeGestures(buf: ArrayBuffer, at: number, gestures: readonly Gesture[], max: number, start = 0): number {
  const n = Math.min(gestures.length - start, max);
  const dv = new DataView(buf, at, n * GESTURE_RECORD);
  const bytes = new Uint8Array(buf, at, n * GESTURE_RECORD);
  for (let i = 0; i < n; i++) {
    const g = gestures[start + i];
    const o = i * GESTURE_RECORD;
    const head = [g.t0, g.t1, g.rampIn, g.rampOut, g.strength, g.speed ?? NaN, g.releaseHold ?? NaN, g.tag ?? NaN];
    for (let j = 0; j < 8; j++) dv.setFloat64(o + j * 8, head[j], true);
    for (let k = 0; k < CONTROL_KEYS.length; k++) dv.setFloat64(o + 64 + k * 8, NaN, true);
    for (const [key, value] of Object.entries(g.targets)) {
      const k = KEY_INDEX[key];
      if (k !== undefined && value !== undefined) dv.setFloat64(o + 64 + k * 8, value, true);
    }
    if (g.label === undefined) bytes[o + LABEL_OFFSET] = 255;
    else {
      let b = utf8(g.label);
      if (b.length > LABEL_CAP) {
        // cut at a character boundary (continuation bytes are 10xxxxxx)
        let n = LABEL_CAP;
        while (n > 0 && (b[n] & 0xc0) === 0x80) n--;
        b = b.slice(0, n);
      }
      bytes[o + LABEL_OFFSET] = b.length;
      bytes.set(b, o + LABEL_OFFSET + 1);
    }
  }
  return n;
}

/** Submit one score atomically between render calls. Each transfer batch uses the same voice
 * clock, and replacing an existing score clears it only on the first batch. */
export function scheduleGestures(
  x: { memory: WebAssembly.Memory } & Record<string, (...args: number[]) => number>, handle: number,
  gestures: readonly Gesture[], lead: number, replace: boolean,
): number {
  const room = x.engine_schedule_room(handle, Number(replace));
  if (gestures.length > room) throw new RangeError(`Score needs ${gestures.length} gestures, but only ${room} slots are available.`);
  if (!Number.isFinite(lead)) throw new RangeError("Schedule lead must be finite.");
  const batchSize = x.chimera_schedule_batch_size();
  let start = 0;
  let offset: number;
  do {
    const n = writeGestures(x.memory.buffer, x.engine_records(handle), gestures, batchSize, start);
    offset = x.engine_schedule(handle, n, lead, Number(replace && start === 0));
    if (!Number.isFinite(offset)) throw new RangeError("The engine could not schedule the score.");
    start += n;
  } while (start < gestures.length);
  return offset;
}
