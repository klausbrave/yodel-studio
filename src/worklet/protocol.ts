/** Messages between the main thread and the CHIMERA AudioWorklet. */
import type { HumanArtic } from "../wasm/types.ts";
import type { VoiceSource, VoiceTelemetry } from "../wasm/types.ts";
import type { Segment, PlannedSegment } from "../wasm/types.ts";
import type { Gesture } from "../wasm/types.ts";
import type { BodyMix } from "../wasm/types.ts";

export interface PhraseMsg {
  segments: Segment[];
  intonation?: "statement" | "question" | "flat";
  pause?: number;
}

export type BodyName = "male" | "female" | "child";

export type ToWorklet =
  | { type: "body"; body: BodyMix }
  | { type: "artic"; values: Partial<HumanArtic>; tipFree?: boolean }
  | { type: "source"; values: Partial<VoiceSource> }
  | { type: "gate"; level: number }
  | { type: "telemetry"; enabled: boolean }
  /** gestures planned on the main thread with times relative to "now" (the worklet adds its clock) */
  | { type: "schedule"; gestures: Gesture[]; segments: PlannedSegment[]; end: number; id: number; replace: boolean; lead?: number }
  | { type: "stopSpeech" }
  /** end the open-ended gestures with this tag now (a sung note released) */
  | { type: "release"; tag: number };

export interface TelemetryMessage {
  type: "telemetry";
  t: VoiceTelemetry;
  /** fraction of the render-quantum budget used by the engine (smoothed) */
  load: number;
  body: BodyMix;
  nPh: number;
  nOr: number;
}

export interface PlannedMessage {
  type: "planned";
  id: number;
  t0: number;
  end: number;
  segments: PlannedSegment[];
}

export type FromWorklet =
  | { type: "ready"; sampleRate: number; body: BodyMix; nPh: number; nOr: number }
  | TelemetryMessage
  | PlannedMessage
  | { type: "error"; message: string };
