/** Browser facade over CHIMERA's human anatomy and singing planner. Load after initChimera(). */
import { call } from "./chimera.ts";
import type { ArticKey, ArticSpec, BodyMix, Gesture, HumanArtic, HumanBody, HumanFrame, Plan, SungNote, Syllable, VowelRef } from "./types.ts";
export type * from "./types.ts";

interface Catalog {
  neutral: HumanArtic;
  articKeys: ArticKey[];
  articSpecs: Record<ArticKey, ArticSpec>;
  vowelTargets: Record<string, Record<string, { artic: Partial<HumanArtic>; formants: number[] }>>;
  vowels: VowelRef[];
}
const CATALOG = call<Catalog>("catalog");

export const NEUTRAL: Readonly<HumanArtic> = CATALOG.neutral;
export const ARTIC_KEYS: readonly ArticKey[] = CATALOG.articKeys;
export const ARTIC_SPECS: Readonly<Record<ArticKey, ArticSpec>> = CATALOG.articSpecs;
export const VOWEL_TARGETS = CATALOG.vowelTargets;
export const VOWELS: readonly VowelRef[] = CATALOG.vowels;

export function lyricsToSyllables(text: string): Syllable[] {
  return call("lyricsToSyllables", { text });
}

export type Aspiration = "english" | "marked";

export function planSong(notes: SungNote[], options: { body: BodyMix; bpm: number; t0: number; vibrato: number; aspiration?: Aspiration }): Plan {
  return call("planSong", { notes, options });
}

export function planNoteOn(syl: Syllable, midi: number, options: { body: BodyMix; vibrato: number; tag: number; legatoFrom?: { syl: Syllable; midi: number }; aspiration?: Aspiration }): Gesture[] {
  return call("planNoteOn", { syl, midi, options });
}

/** Template ↔ body coordinates of one body (mirrors HumanVocalTract::p / un_p, for drawing and dragging). */
export class TractMap {
  readonly scale: number;
  private readonly ph: number;
  constructor(body: HumanBody) {
    this.scale = body.scale;
    this.ph = body.pharynx;
  }
  P(x: number, y: number): { x: number; y: number } {
    const k = this.scale;
    const xx = x > 0.5 ? 0.5 + (x - 0.5) * 0.86 : x;
    const yy = y < 7 ? 7 - (7 - y) * this.ph : y;
    return { x: xx * k, y: yy * k };
  }
  unP(x: number, y: number): { x: number; y: number } {
    const k = this.scale;
    let xx = x / k, yy = y / k;
    if (xx > 0.5) xx = 0.5 + (xx - 0.5) / 0.86;
    if (yy < 7) yy = 7 - (7 - yy) / this.ph;
    return { x: xx, y: yy };
  }
}

/** The main thread's mirror of the worklet's airway for one body and sample rate. */
export interface AirwayModel {
  model: number;
  body: HumanBody;
  nPh: number;
  nOr: number;
  pharynxBranches: { base: number; n: number };
  oralBranches: { base: number; n: number };
  glottisPort: number;
}

export function airwayModel(body: BodyMix, sampleRate: number): AirwayModel {
  return call("model", { body, sampleRate });
}

/** Free a model (its id is invalid afterwards). */
export function dropAirwayModel(m: AirwayModel): void {
  call("dropModel", { model: m.model });
}

export function airwayFrame(m: AirwayModel, artic: HumanArtic): HumanFrame {
  return call("frame", { model: m.model, artic });
}

/** The tract's area function (what the worklet's airway would be given) for an articulation. */
export function airwayAreas(m: AirwayModel, artic: HumanArtic): { phAreas: number[]; orAreas: number[]; phLen: number; orLen: number } {
  return call("apply", { model: m.model, artic });
}

/** Transfer function (dB at 360 log-spaced frequencies 60 Hz–8 kHz) and formants. */
export function airwayTransfer(m: AirwayModel, artic: HumanArtic): { freqs: number[]; db: number[]; formants: number[] } {
  return call("transfer", { model: m.model, artic });
}
