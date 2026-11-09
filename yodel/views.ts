import * as THREE from "three";
import { VoiceModel } from "../src/ui/analysis";
import { Anatomy3D } from "../src/ui/render/anatomy3d";
import { AnatomyRenderer, faceHandles } from "../src/ui/render/anatomy";
import { ARTIC_SPECS, NEUTRAL } from "../src/wasm/engine";
import type { HumanArtic, Vec } from "../src/wasm/types";
import type { TelemetryMessage } from "../src/worklet/protocol";
import { clamp, inFalsetto, type Note } from "./score";
import { sungSyllable } from "./articulation";

const flags = { pressure: true, particles: true, grid: false, calipers: false };
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function sizeCanvas(canvas: HTMLCanvasElement) {
  const w = Math.max(1, canvas.clientWidth),
    h = Math.max(1, canvas.clientHeight);
  const ratio = Math.min(window.devicePixelRatio || 1, 1.75);
  if (canvas.width !== Math.round(w * ratio) || canvas.height !== Math.round(h * ratio)) {
    canvas.width = Math.round(w * ratio);
    canvas.height = Math.round(h * ratio);
  }
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

export class Portrait {
  private model = new VoiceModel({ female: 0, child: 0 }, 48000);
  private box = $("head-image");
  private gl: THREE.WebGLRenderer | null = null;
  private anatomy: Anatomy3D | null = null;
  private flat: AnatomyRenderer | null = null;
  private surface = document.createElement("canvas");
  private closeUp = true;
  private rotationEnabled = false;
  private turn: { id: number; x: number; y: number } | null = null;
  private angle = 0.16;
  private elevation = 0.065;
  private w = 1;
  private h = 1;
  private flatScale = 1;
  private dirty = true;
  private labels = new Map<string, [number, number]>();
  private lastTele: TelemetryMessage | null = null;
  private lastNote: Note | null = null;
  artic: HumanArtic = { ...NEUTRAL };

  constructor() {
    try {
      this.gl = new THREE.WebGLRenderer({
        canvas: this.surface,
        antialias: true,
        alpha: false,
        powerPreference: "low-power",
      });
      this.gl.outputColorSpace = THREE.LinearSRGBColorSpace;
      this.gl.setClearColor(0x000000);
      this.anatomy = new Anatomy3D();
      this.anatomy.centred = true;
    } catch {
      this.surface = document.createElement("canvas");
      this.flat = new AnatomyRenderer();
      // The same interactive HTML targets sit over the flat and 3D renderers.
      this.flat.handles = () => [];
      $("rotate").hidden = true;
    }
    const zoom = $("zoom");
    zoom.onclick = () => {
      this.closeUp = !this.closeUp;
      zoom.textContent = this.closeUp ? "Full head" : "Throat close-up";
      zoom.setAttribute("aria-pressed", String(this.closeUp));
      zoom.setAttribute(
        "aria-label",
        this.closeUp ? "Throat close-up. Switch to full head" : "Switch to throat close-up",
      );
      this.dirty = true;
    };
    $("rotate").onclick = () => this.setRotation(!this.rotationEnabled);
    this.box.append(this.surface);
    new ResizeObserver(() => {
      this.resize();
    }).observe(this.box);
    this.resize();
    this.box.onpointerdown = (e) => {
      if (!this.rotationEnabled || e.button !== 0 || this.turn) return;
      this.turn = { id: e.pointerId, x: e.clientX, y: e.clientY };
      this.box.setPointerCapture(e.pointerId);
    };
    this.box.onpointermove = (e) => {
      const prev = this.turn;
      if (!prev || prev.id !== e.pointerId) return;
      this.angle = clamp(this.angle + (e.clientX - prev.x) * 0.009, -1.15, 1.3);
      this.elevation = clamp(this.elevation + (prev.y - e.clientY) * 0.005, -0.28, 0.44);
      prev.x = e.clientX;
      prev.y = e.clientY;
      this.dirty = true;
    };
    this.box.onlostpointercapture = (e) => {
      if (this.turn?.id === e.pointerId) this.turn = null;
    };
    this.box.ondblclick = () => {
      if (!this.rotationEnabled) return;
      this.angle = 0.16;
      this.elevation = 0.065;
      this.dirty = true;
    };
  }

  private setRotation(on: boolean) {
    this.rotationEnabled = on;
    if (this.turn && this.box.hasPointerCapture(this.turn.id)) this.box.releasePointerCapture(this.turn.id);
    this.turn = null;
    this.box.classList.toggle("can-rotate", on);
    $("rotate").setAttribute("aria-pressed", String(on));
    $("handle-hint").textContent = on ? "Drag the background to rotate" : "Drag a handle";
  }
  reset() {
    this.setRotation(false);
    this.angle = 0.16;
    this.elevation = 0.065;
    this.closeUp = true;
    this.dirty = true;
    this.anatomy?.resetMotion();
    const zoom = $("zoom");
    zoom.textContent = "Full head";
    zoom.setAttribute("aria-pressed", "true");
    zoom.setAttribute("aria-label", "Throat close-up. Switch to full head");
  }

  private resize() {
    this.w = Math.max(1, this.box.clientWidth);
    this.h = Math.max(1, this.box.clientHeight);
    this.gl?.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
    this.gl?.setSize(this.w, this.h, false);
    this.anatomy?.resize(this.w, this.h);
    this.flat?.resize(520, 610);
    this.flatScale = Math.min(this.h / 485, this.w / 365);
    this.dirty = true;
  }

  draw(tele: TelemetryMessage | null, note: Note, dt: number) {
    if (!this.dirty && this.lastTele === tele && this.lastNote === note) return;
    const layoutChanged = this.dirty;
    this.lastTele = tele;
    this.lastNote = note;
    this.dirty = false;
    const vowel = sungSyllable(note.syllable).nucleus.ipa;
    this.artic = tele
      ? VoiceModel.articFromArray(tele.t.artic)
      : {
          ...NEUTRAL,
          ...this.model.vowels.find((v) => v.ipa === (vowel === "oʊ" ? "o" : vowel === "eɪ" ? "e" : vowel))?.artic,
        };
    if (!tele) {
      if (note.larynx !== undefined) this.artic.larynx = note.larynx;
      if (note.root !== undefined) this.artic.root = note.root;
      if (note.tongue) Object.assign(this.artic, note.tongue);
      if (note.mouth) Object.assign(this.artic, note.mouth);
    }
    const frame = this.model.frame(this.artic);
    let project: (p: Vec) => [number, number];
    if (this.gl && this.anatomy) {
      const a = this.anatomy;
      a.face.update(tele, dt);
      a.face.nod = 0;
      a.face.tilt = 0;
      const pose = a.poses(this.model);
      const distance = pose.home.distanceTo(pose.target) / (this.closeUp ? 2.04 : 1.09);
      const target = pose.target;
      target.y -= this.closeUp ? 5.0 : 0.85;
      if (this.closeUp) target.x += 0.8;
      a.camera.position
        .set(
          Math.sin(this.angle) * Math.cos(this.elevation),
          Math.sin(this.elevation),
          Math.cos(this.angle) * Math.cos(this.elevation),
        )
        .multiplyScalar(distance)
        .add(target);
      a.camera.lookAt(target);
      a.update(this.model, frame, this.artic, tele, flags, dt);
      this.gl.render(a.scene, a.camera);
      project = (p) => a.project(p.x, p.y, 0);
    } else {
      const renderer = this.flat!;
      const { ctx, w, h } = sizeCanvas(this.surface);
      const k = this.flatScale * (this.closeUp ? 1.83 : 1);
      const x = w / 2 - 260 * k,
        y = h / 2 - (this.closeUp ? 366 : 293) * k;
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(k, k);
      renderer.face.update(tele, dt);
      renderer.draw(ctx, this.model, frame, this.artic, tele, flags, {
        hover: null,
        drag: null,
        dt,
        formants: [],
        slots: [],
        info: [],
      });
      ctx.restore();
      project = (p) => [x + renderer.X(p) * k, y + renderer.Y(p) * k];
    }
    const handles = faceHandles(this.model, frame, this.artic).filter((h) => h.id !== "tip");
    const positions = [...handles, { id: "throat", pos: frame.epiglottis[frame.epiglottis.length - 1] }]
      .map(({ id, pos }) => {
        const [x, y] = project(pos);
        return { pin: $(id), x, y };
      });
    // Keep labels still through fast syllables. Reposition them when the visitor moves the camera.
    if (layoutChanged) {
      const xs = positions.map((p) => p.x);
      for (const side of ["left", "right"]) {
        const group = positions.filter(({ pin }) => pin.dataset.side === side).sort((a, b) => a.y - b.y);
        const rail = side === "left" ? Math.max(72, Math.min(...xs) - 28) : Math.min(this.w - 80, Math.max(...xs) + 28);
        let previous = 10;
        group.forEach(({ pin, y }, i) => {
          const row = clamp(y, previous + 32, this.h - 40 - (group.length - i - 1) * 32);
          this.labels.set(pin.id, [rail, row]);
          previous = row;
        });
      }
    }
    for (const { pin, x, y } of positions) {
      const [labelX, labelY] = this.labels.get(pin.id)!;
      const dx = labelX - x, dy = labelY - y;
      pin.style.setProperty("--label-x", dx.toFixed(1) + "px");
      pin.style.setProperty("--label-y", dy.toFixed(1) + "px");
      pin.style.setProperty("--leader-length", Math.hypot(dx, dy).toFixed(1) + "px");
      pin.style.setProperty("--leader-angle", Math.atan2(dy, dx).toFixed(3) + "rad");
      pin.style.left = x + "px";
      pin.style.top = y + "px";
      pin.hidden = false;
    }
    $("jaw").setAttribute("aria-valuenow", this.artic.jaw.toFixed(2));
    $("velum").setAttribute("aria-valuenow", Math.max(0, this.artic.velum).toFixed(2));
  }

  get cmPerPixel() {
    return (this.closeUp ? 19 : 32) / Math.max(200, this.h);
  }
  tongueAt(origin: Pick<HumanArtic, "tbX" | "tbY">, dx: number, dy: number) {
    const scale = this.cmPerPixel;
    return {
      tbX: clamp(origin.tbX + dx * scale, ARTIC_SPECS.tbX.min, ARTIC_SPECS.tbX.max),
      tbY: clamp(origin.tbY - dy * scale, ARTIC_SPECS.tbY.min, ARTIC_SPECS.tbY.max),
    };
  }
}

/** The film's paired fold contours, traversing the engine's two-cycle glottal-area scope in slow motion. */
export function drawFolds(canvas: HTMLCanvasElement, note: Note, tele: TelemetryMessage | null, sounding: boolean) {
  const { ctx: c, w, h } = sizeCanvas(canvas);
  const high = inFalsetto(note),
    color = high ? "145,217,231" : "255,189,120";
  const tint = (a: number) => "rgba(" + color + "," + a + ")";
  const size = Math.min(h * 0.92, w * 0.75),
    cx = w * 0.48,
    cy = h * 0.5;
  c.save();
  c.translate(cx, cy);
  c.scale(size / 200, size / 200);
  // The reticle locates the opening when the shape changes between registers.
  for (const r of [83, 97]) {
    c.beginPath();
    c.arc(0, 0, r, 0, 2 * Math.PI);
    c.strokeStyle = r === 97 ? "#77908d41" : "#778c881f";
    c.lineWidth = 0.65;
    c.stroke();
  }
  for (let j = 0; j < 48; j++) {
    c.save();
    c.rotate((j * Math.PI) / 24);
    c.beginPath();
    c.moveTo(0, -97);
    c.lineTo(0, j % 4 === 0 ? -92 : -95);
    c.strokeStyle = "#899c9657";
    c.lineWidth = 0.7;
    c.stroke();
    c.restore();
  }
  c.setLineDash([2, 5]);
  c.beginPath();
  c.moveTo(-109, 0);
  c.lineTo(-63, 0);
  c.moveTo(63, 0);
  c.lineTo(109, 0);
  c.strokeStyle = "#92a19a80";
  c.stroke();
  c.setLineDash([]);
  const scope = tele?.t.glottalArea;
  const phase = ((tele?.t.clock ?? 0) / 1.8) % 1;
  const index = scope ? Math.min(scope.length - 1, Math.floor(phase * scope.length)) : 0;
  const area = sounding && scope ? scope[index] : 0.07;
  const gap = clamp((area - 0.009) * 107, 0.7, 27);
  const posterior = 2.5 + 0.26 * gap;
  c.scale(high ? 0.91 : 1, high ? 1.045 : 1);
  for (const side of [-1, 1]) {
    c.save();
    c.scale(side, 1);
    const outline = new Path2D();
    outline.moveTo(0, -76);
    outline.bezierCurveTo(28, -68, 57, 12, 43, 63);
    outline.quadraticCurveTo(36, 83, posterior, 61);
    outline.bezierCurveTo(gap * 1.25, 25, gap * 0.81, -47, 0, -76);
    outline.closePath();
    const grad = c.createLinearGradient(0, 0, 53, 0);
    grad.addColorStop(0, tint(0.32));
    grad.addColorStop(0.39, tint(0.16));
    grad.addColorStop(1, tint(0.025));
    c.fillStyle = grad;
    c.fill(outline);
    c.strokeStyle = tint(0.84);
    c.lineWidth = 1.15;
    c.stroke(outline);
    c.save();
    c.clip(outline);
    for (let n = 1; n <= 13; n++) {
      const f = n / 14;
      c.beginPath();
      c.moveTo(-1, -78 + f * 2);
      c.bezierCurveTo(gap * 0.65 + f * 30, -50 + f * 5, gap * 1.1 + f * 49, 21 + f * 9, posterior + f * 38, 65 + f * 5);
      c.strokeStyle = tint(0.13 + f * 0.17);
      c.lineWidth = 0.65;
      c.stroke();
    }
    c.restore();
    c.beginPath();
    c.moveTo(0, -76);
    c.bezierCurveTo(gap * 0.81, -47, gap * 1.25, 25, posterior, 61);
    c.shadowColor = tint(0.8);
    c.shadowBlur = 4;
    c.strokeStyle = tint(0.97);
    c.lineWidth = 2;
    c.stroke();
    c.shadowBlur = 0;
    c.beginPath();
    c.ellipse(posterior + 10, 66, 13, 7, 0.25, 0, Math.PI * 2);
    c.fillStyle = tint(0.1);
    c.fill();
    c.strokeStyle = tint(0.48);
    c.lineWidth = 0.85;
    c.stroke();
    c.restore();
  }
  c.restore();
}

export class PitchTrace {
  private samples: { time: number; pitch: number | null; falsetto: boolean }[] = [];
  clear() {
    this.samples.length = 0;
  }
  record(tele: TelemetryMessage, falsetto: boolean) {
    const t = tele.t,
      last = this.samples.at(-1);
    if (last && t.clock - last.time < 0.031) return;
    this.samples.push({
      time: t.clock,
      falsetto,
      pitch: t.outRms > 0.001 && t.voicing > 0.25 ? 69 + 12 * Math.log2(t.f0 / 440) : null,
    });
    while (this.samples.length && this.samples[0].time < t.clock - 3.2) this.samples.shift();
  }
  draw(canvas: HTMLCanvasElement) {
    const { ctx: c, w, h } = sizeCanvas(canvas);
    c.strokeStyle = "#63807a5e";
    c.lineWidth = 1;
    for (const y of [0.25, 0.75]) {
      c.beginPath();
      c.moveTo(0, y * h);
      c.lineTo(w, y * h);
      c.stroke();
    }
    const end = this.samples.at(-1)?.time ?? 0;
    let previous: [number, number] | null = null;
    for (const s of this.samples) {
      if (s.pitch === null) {
        previous = null;
        continue;
      }
      const next: [number, number] = [
        w - ((end - s.time) * w) / 3.2,
        h - 2 - clamp((s.pitch - 46) / 35, 0, 1) * (h - 4),
      ];
      if (previous) {
        c.beginPath();
        c.moveTo(...previous);
        c.lineTo(...next);
        c.strokeStyle = s.falsetto ? "#91d9e7" : "#ffbd78";
        c.lineWidth = 1.65;
        c.stroke();
      }
      previous = next;
    }
  }
}
