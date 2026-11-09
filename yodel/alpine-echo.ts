import type { Note, Phrase } from "./score";

export const alpineEchoName = "Alpine Echo";
// These labels are part of shared scores. Each maps to one sung syllable.
export const alpineEchoPronunciations = {
  Bum: "bʊm", Duk: "dʊk", Tik: "tɪk", Ka: "kɑ", Bap: "bæp",
  Da: "dɑ", Tss: "təs", Yoh: "joʊ", Yee: "ji", Yah: "jɑ",
} as const;

type Sound = keyof typeof alpineEchoPronunciations;
type Hit = [tick: number, syllable: Sound, midi: number, length: number];

// Four original bars in E minor. Sixteen ticks to a beat let the ghost syllables
// land just behind the straight kicks. Bars two and four answer in head voice.
const bars: Hit[][] = [
  [
    [0, "Bum", 40, 6], [12, "Duk", 43, 2], [16, "Ka", 47, 4],
    [25, "Tik", 47, 2], [29, "Da", 45, 2], [32, "Bum", 40, 5],
    [44, "Duk", 40, 2], [48, "Bap", 50, 4], [60, "Tik", 43, 2],
  ],
  [
    [0, "Bum", 45, 6], [12, "Duk", 43, 2], [16, "Ka", 40, 5],
    [28, "Da", 43, 2], [32, "Yoh", 47, 4], [40, "Yee", 64, 6],
    [48, "Yoh", 47, 3], [53, "Yah", 67, 6], [61, "Tss", 43, 2],
  ],
  [
    [0, "Bum", 40, 5], [9, "Bum", 40, 3], [16, "Bap", 47, 4],
    [25, "Duk", 43, 2], [29, "Duk", 45, 2], [32, "Da", 47, 3],
    [41, "Tss", 43, 3], [48, "Bum", 40, 6], [60, "Tik", 50, 2],
  ],
  [
    [0, "Bum", 43, 6], [12, "Tik", 47, 2], [16, "Bap", 45, 4],
    [28, "Duk", 43, 2], [32, "Yoh", 40, 4], [40, "Yee", 69, 6],
    [48, "Yah", 67, 5], [56, "Bum", 40, 4],
  ],
];

// Leave the actual stop closures to the phoneme planner. Round the bass,
// spread the rim shots, and open the jaw on each backbeat.
const color: Partial<Record<Sound, Pick<Note, "larynx" | "mouth">>> = {
  Bum: { larynx: -0.65, mouth: { lipProt: 0.57 } },
  Duk: { larynx: -0.35 },
  Tik: { mouth: { lipWidth: 0.85 } },
  Ka: { mouth: { jaw: 1.3 } },
  Bap: { mouth: { jaw: 1.05, lipWidth: 0.74 } },
  Tss: { mouth: { lipWidth: 0.88 } },
  Yoh: { mouth: { lipProt: 0.4 } },
  Yee: { larynx: 0.3, mouth: { lipWidth: 0.9 } },
};

const leadTicks = 2;
const hits = bars.flatMap((bar, i) => bar.map(([tick, syllable, midi, length]) =>
  ({ tick: i * 64 + tick + leadTicks, syllable, midi, length })));
export const alpineEchoSong: Phrase = {
  bpm: 112,
  leadBeats: leadTicks / 16,
  notes: hits.map(({ tick, syllable, midi, length }, i) => ({
    id: "echo-" + i, syllable, midi, beats: length / 16,
    rest: ((hits[i + 1]?.tick ?? bars.length * 64) - tick - length) / 16,
    register: midi >= 64 ? "falsetto" : "chest",
    ...color[syllable],
  })),
};
