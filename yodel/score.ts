import { publishedName, publishedPronunciations, publishedSong } from "./published";
import { alpineEchoName, alpineEchoPronunciations, alpineEchoSong } from "./alpine-echo";
import { validMouth, type MouthShape } from "./mouth";

const practiceSounds = { Yo: "joʊ", De: "də", Lay: "leɪ", Hee: "hi", Hoo: "hu", Oh: "o", Ah: "ɑ", Ee: "i", Oo: "u" };
export const pronunciations: Record<string, string> = { ...practiceSounds, ...publishedPronunciations, ...alpineEchoPronunciations };
type Vocable = keyof typeof practiceSounds;
export interface Note {
  id: string;
  midi: number;
  beats: number;
  syllable: string;
  register?: "chest" | "falsetto";
  /** Silent beats after this note, including the release after the final note. */
  rest?: number;
  larynx?: number;
  root?: number;
  tongue?: { tbX: number; tbY: number };
  mouth?: MouthShape;
}
export type DragAdjustment = Pick<Note, "larynx" | "root" | "tongue" | "mouth"> & { bend?: number };

/** A fold drag bends each successive note by the same number of semitones. */
export function withDrag(note: Note, drag: DragAdjustment | null, pitchOrigin = note.midi): Note {
  if (!drag) return note;
  const { bend, mouth, ...shape } = drag;
  return {
    ...note, ...shape,
    mouth: mouth ? { ...note.mouth, ...mouth } : note.mouth,
    midi: bend === undefined ? note.midi : clamp(pitchOrigin + bend, lowNote, highNote),
  };
}

export interface Phrase {
  notes: Note[];
  bpm: number;
  leadBeats?: number;
  transpose?: number;
}
type FilmNote = [number, number, Vocable];

const syllables: Vocable[] = ["Yo", "De", "Lay", "Yo", "De", "Lay", "Yo", "De", "Lay", "Hee", "Hoo"];
const closing = [
  [55, 0.25],
  [67, 0.35],
  [55, 0.25],
  [67, 0.35],
  [52, 0.25],
  [64, 0.35],
  [55, 0.25],
  [67, 0.55],
  [60, 0.5],
  [72, 2.5],
  [60, 0.9],
];
const refrain: FilmNote[] = closing.map(([midi, seconds], i) => [midi, seconds, syllables[i]]);
const octave: FilmNote[] = [
  [55, 0.45, "Oh"],
  [67, 1.75, "Ee"],
  [55, 0.22, "Oh"],
  [67, 0.28, "Ee"],
  [55, 0.22, "Oh"],
  [67, 0.38, "Ee"],
  [52, 0.22, "Ah"],
  [64, 0.28, "Ee"],
  [52, 0.22, "Ah"],
  [64, 0.38, "Ee"],
  [55, 0.22, "Oh"],
  [67, 0.28, "Ee"],
  [57, 0.22, "Oh"],
  [69, 0.38, "Ee"],
  [55, 0.24, "Oh"],
  [67, 0.24, "Ee"],
  [52, 0.24, "Ah"],
  [64, 0.24, "Ee"],
  [55, 0.4, "Oh"],
  [67, 2.05, "Ee"],
  [55, 0.59, "Oh"],
];
const rolling: FilmNote[] = [];
for (const [low, high] of [
  [55, 67],
  [52, 64],
  [55, 67],
  [57, 69],
  [55, 67],
  [52, 64],
]) {
  rolling.push([low, 0.18, "Oh"], [high, 0.24, "Ee"], [low, 0.18, "Oh"], [high, 0.36, "Ee"]);
}
rolling.push([55, 0.4, "Oh"], [67, 2.2, "Ee"], [55, 0.35, "Oh"], [64, 0.45, "Oo"], [52, 0.4, "Ah"]);

/** The wordless practice passages use durations in seconds at 144 BPM. */
function wordless(pattern: FilmNote[]): Phrase {
  return {
    bpm: 144,
    notes: pattern.map(([midi, seconds, syllable], i) => ({
      id: "n" + i,
      midi,
      beats: Math.round(seconds * 2400) / 1000,
      syllable,
    })),
  };
}
export const presets: Record<string, Phrase> = {
  [publishedName]: publishedSong,
  [alpineEchoName]: alpineEchoSong,
  "Yodel-ay refrain": wordless(refrain),
  "Sustained octaves": wordless(octave),
  "Rolling yodel": wordless(rolling),
};
export type Preset = keyof typeof presets;
export const lowNote = 36,
  highNote = 79,
  maxNotes = 256;
export const clamp = (n: number, low: number, high: number) => Math.max(low, Math.min(n, high));
export const frequency = (midi: number) => 440 * 2 ** ((midi - 69) / 12);
const names = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"];
export const noteName = (midi: number) => names[Math.round(midi) % 12] + (Math.floor(Math.round(midi) / 12) - 1);
export const highRegister = (midi: number) => midi >= 64;
export const inFalsetto = (note: Note) => (note.register ? note.register === "falsetto" : highRegister(note.midi));
export const totalBeats = (phrase: Phrase) =>
  phrase.notes.reduce((sum, n) => sum + n.beats + (n.rest ?? 0), phrase.leadBeats ?? 0);
export function original(name: Preset): Phrase {
  return structuredClone(presets[name]);
}

export function validPhrase(value: unknown): value is Phrase {
  const p = value as Phrase | null;
  if (
    !p || typeof p !== "object" || Array.isArray(p) ||
    !Number.isInteger(p.bpm) ||
    p.bpm < 60 ||
    p.bpm > 400 ||
    (p.leadBeats !== undefined && !(Number.isFinite(p.leadBeats) && p.leadBeats >= 0 && p.leadBeats <= 16)) ||
    !Array.isArray(p.notes) ||
    (p.transpose !== undefined && (!Number.isInteger(p.transpose) || Math.abs(p.transpose) > 12)) ||
    !p.notes.length ||
    p.notes.length > maxNotes
  )
    return false;
  return (
    p.notes.every(
      (n) =>
        n && typeof n === "object" && !Array.isArray(n) &&
        typeof n.id === "string" &&
        n.id.length > 0 && n.id.length <= 64 &&
        Number.isInteger(n.midi) &&
        n.midi >= lowNote &&
        n.midi <= highNote &&
        Number.isFinite(n.beats) &&
        n.beats >= 0.125 &&
        n.beats <= 12 &&
        typeof n.syllable === "string" && Object.hasOwn(pronunciations, n.syllable) &&
        (n.register === undefined || n.register === "chest" || n.register === "falsetto") &&
        (n.rest === undefined || (Number.isFinite(n.rest) && n.rest >= 0 && n.rest <= 16)) &&
        (n.larynx === undefined || (Number.isFinite(n.larynx) && Math.abs(n.larynx) <= 1.6)) &&
        (n.root === undefined || (Number.isFinite(n.root) && Math.abs(n.root) <= 1)) &&
        (n.mouth === undefined || validMouth(n.mouth)) &&
        (n.tongue === undefined ||
          (n.tongue && typeof n.tongue === "object" && !Array.isArray(n.tongue) &&
            Object.keys(n.tongue).every((key) => key === "tbX" || key === "tbY") &&
            Number.isFinite(n.tongue.tbX) &&
            Number.isFinite(n.tongue.tbY) &&
            Math.abs(n.tongue.tbX) < 20 &&
            Math.abs(n.tongue.tbY) < 20)),
    ) && new Set(p.notes.map((n) => n.id)).size === p.notes.length
  );
}
