import type { HumanArtic } from "../src/wasm/types";

// The interaction ranges used by CHIMERA's sagittal anatomy view.
const ranges = {
  jaw: [-0.1, 2.6],
  lipAp: [-0.4, 2.4],
  lipProt: [-0.2, 1.5],
  lipWidth: [0, 1],
  velum: [0, 1.4],
} as const;
export type MouthPart = "jaw" | "lips" | "velum";
type Axis = keyof typeof ranges;
export type MouthShape = Partial<Pick<HumanArtic, Axis>>;
export const mouthAxes = Object.keys(ranges) as Axis[];

function bounded(axis: Axis, value: number) {
  const [min, max] = ranges[axis];
  return Math.max(min, Math.min(max, value));
}
export function validMouth(shape: unknown): shape is MouthShape {
  if (!shape || typeof shape !== "object" || Array.isArray(shape)) return false;
  return Object.entries(shape).every(([key, v]) =>
    Object.hasOwn(ranges, key) && Number.isFinite(v) && bounded(key as Axis, v) === v,
  );
}
export function dragMouth(part: MouthPart, origin: HumanArtic, dx: number, dy: number, spread: boolean): MouthShape {
  if (part === "jaw") return { jaw: bounded("jaw", origin.jaw + dy) };
  if (part === "velum") return { velum: bounded("velum", origin.velum + dy * 0.9) };
  if (spread) return { lipWidth: bounded("lipWidth", origin.lipWidth + dx * 0.6) };
  return { lipAp: bounded("lipAp", origin.lipAp + dy * 1.2), lipProt: bounded("lipProt", origin.lipProt + dx) };
}
export function stepMouth(part: MouthPart, origin: HumanArtic, key: string, spread: boolean): MouthShape {
  const horizontal = key === "ArrowLeft" || key === "ArrowRight";
  const axis: Axis = part === "lips" ? (spread ? "lipWidth" : horizontal ? "lipProt" : "lipAp") : part;
  const step = key === "ArrowRight" || key === "ArrowDown" ? 0.15 : -0.15;
  const [min, max] = ranges[axis];
  return { [axis]: key === "Home" ? min : key === "End" ? max : bounded(axis, origin[axis] + step) };
}
