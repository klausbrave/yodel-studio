import { ChimeraProcessor } from "../src/worklet/processor";
import { frequency, inFalsetto, withDrag, type DragAdjustment, type Phrase } from "./score";
import type { Command, Plans, Position, SongWindows } from "./messages";
import { mouthAxes } from "./mouth";

declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;

// Same glottal pressure, tension, brightness, aspiration and gap as the film's register controller.
const chest = { pressure: 9, tension: 0.74, brightness: 0.36, breathiness: 0.045, posteriorGap: 0.003 };
const falsetto = { pressure: 8.2, tension: 0.1, brightness: 0.13, breathiness: 0.16, posteriorGap: 0.014 };
// Regulated breath lets the visitor hold a vowel for as long as they like.
const liveSource = { glide: 0.006, drift: 0.8, roughness: 0.025, vibratoDepth: 8, respiration: false };
const shapeTag = 18;

class YodelProcessor extends ChimeraProcessor {
  private plans: Plans | null = null;
  private windows: SongWindows | null = null;
  private phrase: Phrase = { bpm: 144, notes: [] };
  private index = 0;
  private beat = 0;
  private playing = false;
  private held = false;
  private grabbed = false;
  private expression: DragAdjustment | null = null;
  private loop = true;
  private tail = 0;
  private gateOpen = false;

  constructor(options: { processorOptions: { module: WebAssembly.Module } }) {
    super(options);
    this.port.onmessage = (e: MessageEvent<Command>) => this.command(e.data);
  }

  private get note() {
    return this.phrase.notes[this.index];
  }
  private get active() {
    return this.playing || this.grabbed;
  }

  private startBeat() {
    return this.index === 0 ? -(this.phrase.leadBeats ?? 0) : 0;
  }

  private syncGate() {
    const gates = this.windows?.[this.note.id]?.gates;
    const open =
      this.active &&
      (this.held || this.grabbed || !gates || gates.some(([from, to]) => this.beat >= from && this.beat < to));
    if (open === this.gateOpen) return false;
    this.gateOpen = open;
    this.handle({ type: "gate", level: open ? 1 : 0 });
    return true;
  }

  private position(ended = false) {
    if (!this.note) return;
    const state: Position = {
      type: "position",
      id: this.note.id,
      playing: this.playing,
      sounding: this.active && this.gateOpen,
      held: this.held || this.grabbed,
      ended,
    };
    this.port.postMessage(state);
  }

  private tune() {
    const note = withDrag(this.note, this.expression);
    this.handle({
      type: "source",
      values: {
        ...liveSource,
        ...(inFalsetto(note) ? falsetto : chest),
        f0: frequency(note.midi + (this.phrase.transpose ?? 0)),
      },
    });
  }

  private shape() {
    this.handle({ type: "release", tag: shapeTag });
    const { larynx, root, tongue, mouth } = withDrag(this.note, this.expression);
    if (larynx === undefined && root === undefined && !tongue && !mouth) return;
    this.handle({
      type: "schedule",
      replace: false,
      lead: 0,
      segments: [],
      end: 0,
      id: 0,
      gestures: [
        {
          t0: 0,
          t1: 1e9,
          rampIn: 0.012,
          rampOut: 0.015,
          strength: 80,
          targets: { larynx, root, ...tongue, ...mouth },
          tag: shapeTag,
          label: "tract shape",
        },
      ],
    });
  }

  private sing() {
    if (!this.note || !this.plans) return;
    this.tune();
    this.syncGate();
    const window = !this.grabbed && !this.held ? this.windows?.[this.note.id] : undefined;
    this.handle({
      type: "schedule",
      replace: true,
      lead: window ? (-this.beat * 60) / this.phrase.bpm : 0,
      segments: [],
      end: 0,
      id: 0,
      gestures: window?.gestures ?? this.plans[this.note.syllable],
    });
    this.shape();
  }

  private silence() {
    this.gateOpen = false;
    this.handle({ type: "stopSpeech" });
    this.handle({ type: "gate", level: 0 });
    this.tail = Math.ceil(sampleRate * 0.42);
  }

  private command(cmd: Command) {
    const old = this.note;
    switch (cmd.type) {
      case "configure":
        this.plans = cmd.plans;
        break;
      case "score": {
        const oldShift = this.phrase.transpose ?? 0;
        this.phrase = cmd.phrase;
        if (cmd.windows !== undefined) this.windows = cmd.windows;
        const next = this.phrase.notes.findIndex((n) => n.id === old?.id);
        this.index = cmd.restart ? 0 : next >= 0 ? next : Math.min(this.index, this.phrase.notes.length - 1);
        if (cmd.restart || old?.id !== this.note.id) this.beat = this.startBeat();
        else this.beat = Math.min(this.beat, this.note.beats + (this.note.rest ?? 0));
        if (this.active) {
          if (cmd.restart || cmd.windows || old?.id !== this.note.id || old.syllable !== this.note.syllable)
            this.sing();
          else {
            if (old.midi !== this.note.midi || oldShift !== (this.phrase.transpose ?? 0)) this.tune();
            if (
              old.larynx !== this.note.larynx ||
              old.root !== this.note.root ||
              mouthAxes.some((axis) => old.mouth?.[axis] !== this.note.mouth?.[axis]) ||
              old.tongue?.tbX !== this.note.tongue?.tbX ||
              old.tongue?.tbY !== this.note.tongue?.tbY
            )
              this.shape();
          }
        }
        this.position();
        break;
      }
      case "seek":
      case "play":
      case "grab": {
        const index = this.phrase.notes.findIndex((n) => n.id === cmd.id);
        if (index < 0) break;
        const wasActive = this.active;
        const changed = this.index !== index;
        this.index = index;
        if (changed || cmd.type === "seek") this.beat = this.startBeat();
        if (cmd.type === "play") this.playing = true;
        if (cmd.type === "grab") this.grabbed = true;
        if (this.active && (!wasActive || changed || cmd.type === "seek" || (this.windows && cmd.type === "grab")))
          this.sing();
        this.position();
        break;
      }
      case "drop":
        this.grabbed = false;
        if (!this.playing) this.silence();
        else if (this.windows) this.sing();
        this.position();
        break;
      case "expression": {
        if (!this.playing) break;
        const previous = this.expression;
        this.expression = cmd.adjustment;
        if (previous?.bend !== this.expression?.bend) this.tune();
        if (previous || this.expression) this.shape();
        break;
      }
      case "pause":
        this.playing = this.held = this.grabbed = false;
        this.expression = null;
        this.silence();
        this.position();
        break;
      case "hold":
        if (this.held !== cmd.on) {
          this.held = cmd.on;
          if (this.windows && this.active) this.sing();
        }
        this.position();
        break;
      case "loop":
        this.loop = cmd.on;
        break;
    }
  }

  override process(inputs: Float32Array[][], outputs: Float32Array[][]) {
    if (!this.active && this.tail <= 0) return true;
    const frames = outputs[0]?.[0]?.length ?? 0;
    super.process(inputs, outputs);
    if (!this.active) this.tail -= frames;
    if (this.playing && !this.held && !this.grabbed) {
      this.beat += ((frames / sampleRate) * this.phrase.bpm) / 60;
      const length = this.note.beats + (this.note.rest ?? 0);
      if (this.beat >= length) {
        this.beat -= length;
        this.index++;
        if (this.index >= this.phrase.notes.length) {
          this.index = 0;
          this.beat += this.startBeat();
          if (!this.loop) {
            this.playing = false;
            this.expression = null;
            this.beat = this.startBeat();
            this.silence();
            this.position(true);
            return true;
          }
        }
        this.sing();
        this.position();
      } else if (this.windows && this.syncGate()) this.position();
    }
    return true;
  }
}
registerProcessor("yodel", YodelProcessor);
