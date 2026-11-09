// Only the event fields consumed by the instrument enter its bundle.
import { readFile, writeFile } from "node:fs/promises";
const input = new URL("../local-scores/goatherd.json", import.meta.url);
const output = new URL("../yodel/performance.generated.json", import.meta.url);
let score = null;
try {
  score = JSON.parse(await readFile(input, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
if (score) {
  const { bpm, duration, events } = score;
  if (!Number.isInteger(bpm) || bpm < 60 || bpm > 400 || !Number.isFinite(duration) || duration <= 0 ||
      !Array.isArray(events) || events.length < 1 || events.length > 256) throw new Error("Invalid performance score");
  let previousEnd = 0;
  score = { bpm, duration, events: events.map(({ start, end, midi, register, ipa, text = "" }) => {
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < previousEnd - 1e-6 ||
        end <= start || end > duration + 1e-6 || !Number.isInteger(midi) || midi < 36 || midi > 79 ||
        !["falsetto", "chest"].includes(register) || typeof ipa !== "string" || !ipa.length ||
        typeof text !== "string") throw new Error("Invalid performance note");
    previousEnd = end;
    return { start, end, midi, register, ipa, text };
  }) };
}
await writeFile(output, JSON.stringify(score) + "\n");
console.log(score ? "Prepared the local performance score." : "Using the original Alpine Echo demo.");
