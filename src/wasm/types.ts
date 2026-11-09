/** Engine types as the UI sees them (the JSON shapes of the Rust engine's serde types). */
export type ArticKey = "jaw" | "tbX" | "tbY" | "ttX" | "ttY" | "ttCurl" | "root" | "lipAp" | "lipProt" | "lipWidth" | "labiodental" | "velum" | "larynx" | "epilarynx" | "ventricular" | "lateral" | "dorsum";
export type SourceKey = "abduction" | "closure" | "breath" | "f0" | "vibrato" | "posteriorGap";
export type ControlKey = ArticKey | SourceKey;

export interface Gesture {
  t0: number;
  t1: number;
  rampIn: number;
  rampOut: number;
  strength: number;
  targets: Partial<Record<ControlKey, number>>;
  /** articulator speed multiplier while active and during `releaseHold` seconds after t1 */
  speed?: number;
  releaseHold?: number;
  /** label for visualisation (phoneme / gesture name) */
  label?: string;
  /** open-ended gestures (a sung note held until its key is released) end via release(tag) */
  tag?: number;
}

export interface Vec {
  x: number;
  y: number;
}

export interface HumanArtic {
  jaw: number;
  tbX: number;
  tbY: number;
  ttX: number;
  ttY: number;
  ttCurl: number;
  root: number;
  lipAp: number;
  lipProt: number;
  lipWidth: number;
  labiodental: number;
  velum: number;
  larynx: number;
  epilarynx: number;
  ventricular: number;
  lateral: number;
  dorsum: number;
}

/**
 * A body between the three calibrated ones (mirrors the engine's BodyMix): `female` from the adult
 * male (0) to the adult female (1), `child` from adult (0) to child (1).
 */
export interface BodyMix {
  female: number;
  child: number;
}

export interface HumanBody {
  name: string;
  /** overall size scale (1 = adult male) */
  scale: number;
  /** extra pharynx length scale (female/child have proportionally shorter pharynx) */
  pharynx: number;
  /** tongue body radius (cm, before scale) */
  tongueRadius: number;
  /** max lip width (cm, before scale) */
  lipWidth: number;
}

export interface ArticSpec {
  min: number;
  max: number;
  /** natural frequency (Hz) of the critically damped tracking dynamics */
  hz: number;
}

export interface GridSample {
  inner: Vec;
  outer: Vec;
  mid: Vec;
  d: number;
  area: number;
  s: number;
  region: 0 | 1 | 2 | 3;
  ray: number;
}

export interface HumanFrame {
  outer: Vec[];
  inner: Vec[];
  tongue: Vec[];
  velum: Vec[];
  upperLip: Vec[];
  lowerLip: Vec[];
  upperTeeth: Vec[];
  lowerTeeth: Vec[];
  jawBone: Vec[];
  epiglottis: Vec[];
  nasalCavity: Vec[];
  glottis: Vec;
  grid: GridSample[];
  length: number;
  pharynxLength: number;
  teethS: number;
  lipS: number;
  velumPort: number;
  lipArea: number;
  tipGap: number;
  bodyGap: number;
  tongueCenter: Vec;
  tongueRadius: number;
  tip: Vec;
  splitIndex: number;
}

export interface VoiceSource {
  f0: number;
  glide: number;
  pressure: number;
  breathiness: number;
  tension: number;
  fry: number;
  roughness: number;
  vibratoDepth: number;
  vibratoRate: number;
  drift: number;
  voiced: boolean;
  /** 0 dark … 1 bright (default 0.25: as tension sets it) */
  brightness: number;
  respiration: boolean;
  posteriorGap: number;
  selfOscillating: boolean;
}

export interface RespiratoryTelemetry {
  enabled: boolean;
  volume: number;
  capacity: number;
  diaphragm: number;
  abdomen: number;
  ribCage: number;
  recoil: number;
  flow: number;
  pressure: number;
  phase: number;
  noseFlow: number;
  mouthFlow: number;
}

export interface VoiceTelemetry {
  artic: Float32Array;
  phAreas: Float32Array;
  orAreas: Float32Array;
  phLen: number;
  orLen: number;
  pressureRms: Float32Array;
  flow: Float32Array;
  velumPort: number;
  glottalArea: Float32Array;
  glottalFlow: Float32Array;
  f0: number;
  voicing: number;
  pLung: number;
  outRms: number;
  noiseLevel: number;
  noiseNode: number;
  gate: number;
  /** voice clock (s) for score playheads */
  clock: number;
  /** labels of gestures active now (most recent first) */
  active: string[];
  /** Available in live engine telemetry. Earlier recorded shows have no respiratory state. */
  respiration?: RespiratoryTelemetry;
}

export interface Segment {
  ipa: string;
  dur?: number;
  stress?: number;
  f0?: number;
  wordEnd?: boolean;
  nasalized?: boolean;
  syllabic?: boolean;
}

export interface PlannedSegment {
  ipa: string;
  t0: number;
  t1: number;
  stress?: number;
  kind: string;
}

export interface Plan {
  gestures: Gesture[];
  segments: PlannedSegment[];
  end: number;
}

export interface Phrase {
  segments: Segment[];
  intonation: "statement" | "question";
  /** pause after the phrase (s) */
  pause: number;
  words: string[];
}

export interface Syllable {
  text: string;
  onset: Segment[];
  nucleus: Segment;
  coda: Segment[];
  melisma?: boolean;
  wordEnd: boolean;
  phraseEnd: boolean;
}

export interface SungNote {
  midi: number;
  /** length in beats */
  beats: number;
  syl: Syllable;
}

export interface VowelRef {
  ipa: string;
  /** example word / description */
  example: string;
  male: [number, number, number];
  female: [number, number, number];
  child: [number, number, number];
  round: boolean;
  /** 0 close … 1 open */
  height: number;
  /** 0 front … 1 back */
  back: number;
}
