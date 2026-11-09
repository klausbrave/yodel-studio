import { lyricsToSyllables, planNoteOn, planSong } from "../src/wasm/engine";
import type { Gesture, Segment, Syllable } from "../src/wasm/types";
import { pronunciations, type Phrase } from "./score";
import type { Plans, SongWindows } from "./messages";

const body = { female: 0, child: 0 };
const options = { body, vibrato: 8, aspiration: "marked" as const };
const syllables = new Map<string, Syllable>();

export function sungSyllable(label: string) {
  const ipa = pronunciations[label];
  let syl = syllables.get(ipa);
  if (!syl) {
    [syl] = lyricsToSyllables("/" + ipa + "/");
    if (!syl) throw new Error("No sung syllable for " + label);
    syllables.set(ipa, syl);
  }
  return syl;
}

function withoutPitch(gestures: Gesture[]) {
  // The score changes pitch in the source itself at each beat, as in the film render.
  return gestures
    .map((g) => {
      const targets = { ...g.targets };
      delete targets.f0;
      return { ...g, targets };
    })
    .filter((g) => Object.keys(g.targets).length);
}

export function heldPlans(): Plans {
  return Object.fromEntries(
    Object.keys(pronunciations).map((label) => [
      label,
      withoutPitch(planNoteOn(sungSyllable(label), 60, { ...options, tag: 1 })).map((g) =>
        g.t1 > 20 ? { ...g, t1: 1e9 } : g,
      ),
    ]),
  );
}

const consonantDurations = new Map<string, number>();
function filmConsonant(segment: Segment): Segment {
  // Get the native sung consonant's duration at an uncrowded tempo, then apply the
  // original renderer's 0.65 articulation scale before planning the actual song.
  let dur = segment.dur ?? consonantDurations.get(segment.ipa);
  if (dur === undefined) {
    const syl: Syllable = {
      text: "",
      onset: [segment],
      nucleus: { ipa: "ɑ" },
      coda: [],
      wordEnd: true,
      phraseEnd: true,
    };
    const ref = planSong([{ midi: 60, beats: 2, syl }], { ...options, t0: 1, bpm: 60 });
    dur = 1 - ref.segments[0].t0;
    consonantDurations.set(segment.ipa, dur);
  }
  return { ...segment, dur: dur * 0.65 };
}

export function songWindows(phrase: Phrase): SongWindows {
  const second = 60 / phrase.bpm;
  const notes = phrase.notes;
  const starts: number[] = [];
  const gestures: Gesture[] = [];
  const spans: [number, number][] = [];
  let beat = phrase.leadBeats ?? 0,
    first = 0;
  for (let i = 0; i < notes.length; i++) {
    starts.push(beat * second);
    const note = notes[i];
    beat += note.beats + (note.rest ?? 0);
    if (!note.rest && i !== notes.length - 1) continue;
    const group = notes.slice(first, i + 1).map((n) => {
      const s = sungSyllable(n.syllable);
      return {
        midi: n.midi,
        beats: n.beats,
        syl: { ...s, onset: s.onset.map(filmConsonant), coda: s.coda.map(filmConsonant) },
      };
    });
    const plan = planSong(group, { ...options, bpm: phrase.bpm, t0: starts[first] });
    gestures.push(...withoutPitch(plan.gestures));
    spans.push([plan.segments[0].t0, plan.segments[plan.segments.length - 1].t1]);
    first = i + 1;
  }
  // Keep neighboring onsets and releases in each window, so an arbitrary seek
  // or a hold can resume at the current beat without queuing the rest of the song.
  return Object.fromEntries(
    notes.map((note, i) => {
      const origin = starts[i],
        from = i === 0 ? 0 : origin,
        to = starts[i + 1] ?? beat * second;
      const gates: [number, number][] = spans
        .filter(([a, b]) => a < to && b > from)
        .map(([a, b]) => [(a - origin) / second, (b - origin) / second]);
      return [
        note.id,
        {
          gates,
          gestures: gestures
            .filter((g) => g.t0 - g.rampIn < to && g.t1 + g.rampOut > from)
            .map((g) => ({ ...g, t0: g.t0 - origin, t1: g.t1 - origin })),
        },
      ];
    }),
  );
}
