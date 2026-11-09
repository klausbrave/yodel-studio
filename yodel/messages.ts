import type { Gesture } from "../src/wasm/types";
import type { DragAdjustment, Note, Phrase } from "./score";

export type Plans = Record<string, Gesture[]>;
export interface SongWindow {
  gestures: Gesture[];
  /** Intervals in beats around this note where the singer articulates, including pickups. */
  gates: [number, number][];
}
export type SongWindows = Record<string, SongWindow>;
export type Command =
  | { type: "configure"; plans: Plans }
  | { type: "score"; phrase: Phrase; restart?: boolean; windows?: SongWindows | null }
  | { type: "play" | "seek"; id: string }
  | { type: "pause" | "drop" }
  | { type: "grab"; id: string }
  | { type: "expression"; adjustment: DragAdjustment | null }
  | { type: "hold" | "loop"; on: boolean };

export interface Position {
  type: "position";
  id: Note["id"];
  playing: boolean;
  sounding: boolean;
  held: boolean;
  ended: boolean;
}
