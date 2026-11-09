/**
 * CHIMERA AudioWorklet processor: the Rust engine (wasm) on the audio thread.
 *
 * Messages map to engine calls as they arrive (between render quanta, on this thread), so their
 * order is the order they take effect. process() renders, measures load and posts fixed-size
 * telemetry (~60 Hz). If the engine traps (a bug), the processor outputs silence from then on and
 * reports once; the main thread may build a new node, which restarts playback state.
 */
import { scheduleGestures, fromUtf8, CONTROL_KEYS } from "../wasm/wire.ts";
import type { ToWorklet, FromWorklet, TelemetryMessage } from "./protocol.ts";
import type { BodyMix } from "../wasm/types.ts";

// Minimal AudioWorkletGlobalScope typings
declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}

type Fn = (...a: number[]) => number;
type Exports = { memory: WebAssembly.Memory } & Record<string, Fn>;

const ARTIC_KEYS = CONTROL_KEYS.slice(0, 17);
const SOURCE_KEYS = ["f0", "glide", "pressure", "breathiness", "tension", "fry", "roughness", "vibratoDepth", "vibratoRate", "drift", "voiced", "brightness", "respiration", "posteriorGap", "selfOscillating"];
/** scalars at the head of the human telemetry block (crates/chimera-wasm/src/lib.rs) */
const TELE_HEADER = 16;

export class ChimeraProcessor extends AudioWorkletProcessor {
  private readonly x: Exports;
  private readonly h: number;
  private failed = false;
  private telemetryOn = true;
  private blocks = 0;
  private load = 0;

  constructor(options: { processorOptions: { module: WebAssembly.Module } }) {
    super();
    this.x = new WebAssembly.Instance(options.processorOptions.module, {}).exports as unknown as Exports;
    this.h = this.x.engine_new(sampleRate);
    this.port.onmessage = (e: MessageEvent<ToWorklet>) => {
      if (this.failed) return;
      try {
        this.handle(e.data);
      } catch (err) {
        this.fail(err);
      }
    };
    this.postReady();
  }

  private post(msg: FromWorklet): void {
    this.port.postMessage(msg);
  }

  private fail(err: unknown): void {
    if (this.failed) return;
    this.failed = true;
    this.post({ type: "error", message: `engine stopped: ${String(err)}` });
  }

  private get mem(): ArrayBuffer {
    return this.x.memory.buffer;
  }

  private body(): BodyMix {
    return { female: this.x.engine_body_female(this.h), child: this.x.engine_body_child(this.h) };
  }

  private postReady(): void {
    const x = this.x, h = this.h;
    this.post({ type: "ready", sampleRate, body: this.body(), nPh: x.engine_n_ph(h), nOr: x.engine_n_or(h) });
  }

  /** The engine's value area, cleared to NaN ("unchanged"). */
  private values(): Float64Array {
    return new Float64Array(this.mem, this.x.engine_values(this.h), 32).fill(NaN);
  }

  protected handle(m: ToWorklet): void {
    const x = this.x, h = this.h;
    switch (m.type) {
      case "body":
        x.engine_set_body(h, m.body.female, m.body.child);
        this.postReady();
        break;
      case "artic": {
        const v = this.values();
        for (const [k, val] of Object.entries(m.values)) {
          const i = ARTIC_KEYS.indexOf(k as never);
          if (i >= 0 && typeof val === "number") v[i] = val;
        }
        x.engine_set_artic(h, m.tipFree === undefined ? 2 : m.tipFree ? 1 : 0);
        break;
      }
      case "source": {
        const v = this.values();
        for (const [k, val] of Object.entries(m.values)) {
          const i = SOURCE_KEYS.indexOf(k);
          if (i >= 0) v[i] = typeof val === "boolean" ? (val ? 1 : 0) : (val as number);
        }
        x.engine_set_source(h);
        break;
      }
      case "gate":
        x.engine_set_gate(h, m.level);
        break;
      case "telemetry":
        this.telemetryOn = m.enabled;
        break;
      case "schedule": {
        // planning happened on the main thread; the engine shifts the gestures onto its clock
        let off: number;
        try {
          off = scheduleGestures(x, h, m.gestures, m.lead ?? 0.03, m.replace);
        } catch (error) {
          if (!(error instanceof RangeError)) throw error;
          this.post({ type: "error", message: error.message });
          break;
        }
        if (m.segments.length) this.post({ type: "planned", id: m.id, t0: off, end: m.end + off, segments: m.segments.map((s) => ({ ...s, t0: s.t0 + off, t1: s.t1 + off })) });
        break;
      }
      case "stopSpeech":
        x.engine_stop_speech(h);
        break;
      case "release":
        x.engine_release(h, m.tag);
        break;
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    if (!out || out.length === 0) return true;
    const ch0 = out[0];
    if (this.failed) {
      for (const ch of out) ch.fill(0);
      return true;
    }
    const t0 = Date.now();
    try {
      const p = this.x.engine_render(this.h, ch0.length);
      ch0.set(new Float32Array(this.mem, p, ch0.length));
    } catch (err) {
      ch0.fill(0);
      this.fail(err);
    }
    for (let c = 1; c < out.length; c++) out[c].set(ch0);
    const dt = Date.now() - t0;
    const budget = (ch0.length / sampleRate) * 1000;
    this.load += 0.05 * (dt / budget - this.load);
    if (this.telemetryOn && !this.failed && ++this.blocks % 6 === 0) {
      try {
        this.post(this.humanTelemetry());
      } catch (err) {
        this.fail(err);
      }
    }
    return true;
  }

  /** The human voice's telemetry block → the message the UI reads. */
  private humanTelemetry(): TelemetryMessage {
    const x = this.x, h = this.h;
    const p = x.engine_telemetry(h);
    const [phLen, orLen, velumPort, f0, voicing, pLung, outRms, noiseLevel, noiseNode, gate, clock, nArtic, nPh, nOr, nScope, nActive] = new Float64Array(this.mem, p, TELE_HEADER);
    const all = new Float64Array(this.mem, p, TELE_HEADER + nArtic + 3 * (nPh + nOr) + 2 * nScope);
    let o = TELE_HEADER;
    const take = (n: number) => Float32Array.from(all.subarray(o, (o += n)));
    const artic = take(nArtic), phAreas = take(nPh), orAreas = take(nOr), pressureRms = take(nPh + nOr), flow = take(nPh + nOr), glottalArea = take(nScope), glottalFlow = take(nScope);
    const labels = new Uint8Array(this.mem, x.engine_tele_labels(h), 4 * 25);
    const active: string[] = [];
    for (let i = 0; i < nActive; i++) active.push(fromUtf8(labels.subarray(i * 25 + 1, i * 25 + 1 + labels[i * 25])));
    const [enabled, volume, capacity, diaphragm, abdomen, ribCage, recoil, respiratoryFlow, pressure, phase, noseFlow, mouthFlow] = new Float64Array(this.mem, x.engine_respiration(h), 12);
    const respiration = { enabled: !!enabled, volume, capacity, diaphragm, abdomen, ribCage, recoil, flow: respiratoryFlow, pressure, phase, noseFlow, mouthFlow };
    return {
      type: "telemetry",
      t: { artic, phAreas, orAreas, phLen, orLen, pressureRms, flow, velumPort, glottalArea, glottalFlow, f0, voicing, pLung, outRms, noiseLevel, noiseNode, gate, clock, active, respiration },
      load: this.load,
      body: this.body(),
      nPh,
      nOr,
    };
  }


}

registerProcessor("chimera", ChimeraProcessor);
