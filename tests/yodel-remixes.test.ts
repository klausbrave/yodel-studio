import { describe, expect, test } from "bun:test";
import { alpineEchoSong } from "../yodel/alpine-echo";
import { defaultPreset, maxNotes, original, presets, validPhrase, type Phrase } from "../yodel/score";
import { readSong, songUrl, validTitle, type Song } from "../yodel/song-links";

const toWire = (song: Song) => JSON.parse(JSON.stringify(song, (key, value) => key === "id" ? undefined : value));
const address = "https://yodel.example/studio/?preset=old#instrument";

describe("portable yodel scores", () => {
  for (const preset of new Set([defaultPreset, "Yodel-ay refrain", "Rolling yodel"])) {
    test(preset + " keeps its performance timing and registers", async () => {
      const phrase = original(preset);
      const song = { title: "My alpine duet", baseBpm: phrase.bpm, phrase };
      const url = new URL(await songUrl(song, address));
      expect(url.pathname).toBe("/studio/");
      expect(url.search).toBe("");
      expect(url.href.length).toBeLessThan(2000);
      const restored = await readSong(url.hash);
      expect(toWire(restored)).toEqual(toWire(song));
      expect(new Set(restored.phrase.notes.map((note) => note.id)).size).toBe(phrase.notes.length);
    });
  }

  test("existing Alpine Echo shares still play after the preset is removed", async () => {
    expect(Object.hasOwn(presets, "Alpine Echo")).toBe(false);
    const song = { title: "My saved remix", baseBpm: alpineEchoSong.bpm, phrase: alpineEchoSong };
    const restored = await readSong(new URL(await songUrl(song, address)).hash);
    expect(toWire(restored)).toEqual(toWire(song));
  });

  test("a full custom score keeps edits on every note, with independent editor IDs", async () => {
    const phrase: Phrase = {
      bpm: 171, leadBeats: 0.25, transpose: -3,
      notes: Array.from({ length: maxNotes }, (_, i) => ({
        id: crypto.randomUUID(), midi: 40 + i % 38, beats: 0.125 + i % 7 / 7, syllable: i % 3 ? "Ee" : "Yo",
        register: i % 2 ? "chest" : "falsetto", rest: i % 3 / 3, larynx: i / maxNotes, root: -i / maxNotes,
        tongue: { tbX: -2.35 + i / maxNotes, tbY: 4.26 - i / maxNotes },
        mouth: { jaw: 0.261, lipAp: 0.7, lipProt: 0.98, lipWidth: 0.45, velum: i / maxNotes },
      })),
    };
    const song = { title: "Réponse 山", baseBpm: 144, phrase };
    const restored = await readSong(new URL(await songUrl(song, address)).hash);
    expect(toWire(restored)).toEqual(toWire(song));
    expect(restored.phrase.notes[0].id).not.toBe(phrase.notes[0].id);
    expect(validPhrase(restored.phrase)).toBe(true);
  });

  test("invalid or oversized link data is declined before use", async () => {
    await expect(readSong("#song=2z.x")).rejects.toThrow();
    await expect(readSong("#song=1j." + "x".repeat(220000))).rejects.toThrow();
    const song = { title: "Untitled", baseBpm: 144, phrase: original("Yodel-ay refrain") };
    const plain = (value: unknown) => "#song=1j." + Buffer.from(JSON.stringify(value)).toString("base64url");
    expect((await readSong(plain(song))).phrase.notes).toHaveLength(song.phrase.notes.length);
    await expect(readSong(plain({ ...song, title: "" }))).rejects.toThrow();
    await expect(readSong(plain({ ...song, phrase: { ...song.phrase, notes: [] } }))).rejects.toThrow();
    const note = song.phrase.notes[0];
    for (const invalid of [{ ...note, syllable: ["Yo"] }, { ...note, tongue: { tbX: 0, tbY: 0, extra: 1 } },
      { ...note, mouth: { jaw: "0" } }, { ...note, beats: -1 }, { ...note, midi: "55" }]) {
      await expect(readSong(plain({ ...song, phrase: { bpm: 144, notes: [invalid] } }))).rejects.toThrow();
    }
    expect(validPhrase({ bpm: 144, notes: [{ ...note, id: "" }] })).toBe(false);
    expect(validPhrase({ bpm: 144, notes: [note, note] })).toBe(false);
    expect(validTitle("\n")).toBe(false);
  });
});
