import data from "./performance.generated.json";
import dictionary from "./pronunciations.json";
import { alpineEchoName, alpineEchoSong } from "./alpine-echo";
import type { Note, Phrase } from "./score";

interface PerformanceEvent {
  start: number;
  end: number;
  midi: number;
  register: string;
  ipa: string;
  text: string;
}
const performance = data as { bpm: number; duration: number; events: PerformanceEvent[] } | null;
export const hasPerformance = performance !== null;
export const publishedName = hasPerformance ? "The Lonely Goatherd" : alpineEchoName;
const { bpm, duration, events } = performance ?? { bpm: alpineEchoSong.bpm, duration: 0, events: [] };

// This is the editable arrangement used to render Klaus's 45-second X post.
const wordless: Record<string, string> = { leɪ: "Lay", iː: "Ee", oʊ: "O", dəl: "dl", uː: "Oo" };
const beats = (seconds: number) => Math.round((seconds * bpm * 1000) / 60) / 1000;
export const publishedPronunciations: Record<string, string> = { ...dictionary };
const notes: Note[] = events.map((event, i) => {
  const syllable = event.text || wordless[event.ipa];
  if (!syllable || (publishedPronunciations[syllable] && publishedPronunciations[syllable] !== event.ipa))
    throw new Error("Unknown or inconsistent pronunciation in the published score at note " + (i + 1));
  publishedPronunciations[syllable] = event.ipa;
  const rest = beats((events[i + 1]?.start ?? duration) - event.end);
  return {
    id: "song-" + i,
    midi: event.midi,
    beats: beats(event.end - event.start),
    syllable,
    register: event.register === "falsetto" ? "falsetto" : "chest",
    ...(rest ? { rest } : {}),
  };
});
export const publishedSong: Phrase = events.length ? { bpm, leadBeats: beats(events[0].start), notes } : alpineEchoSong;
