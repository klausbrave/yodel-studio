import { chimeraModule } from "../src/wasm/chimera";
import { heldPlans, songWindows } from "./articulation";
import type { FromWorklet } from "../src/worklet/protocol";
import type { Command, Position } from "./messages";
import workletUrl from "./processor.ts?worker&url";

export class Singer {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private gain: GainNode | null = null;
  private loading: Promise<void> | null = null;
  private timingKey = "";
  muted = false;

  constructor(
    private receive: (message: FromWorklet | Position) => void,
    private configure: () => void,
    private failed: (message: string) => void,
  ) {}

  send(command: Command) {
    if (!this.node) return;
    if (command.type === "score") {
      const p = command.phrase;
      const key =
        p.leadBeats === undefined
          ? ""
          : JSON.stringify([p.bpm, p.leadBeats, p.notes.map((n) => [n.id, n.syllable, n.beats, n.rest])]);
      // Pitch and tract edits go straight through without rebuilding word timing.
      if (key !== this.timingKey || command.restart) {
        command = { ...command, windows: key ? songWindows(p) : null };
        this.timingKey = key;
      }
    }
    this.node.port.postMessage(command);
  }

  async start() {
    if (this.loading) return this.loading;
    if (this.node && this.ctx) {
      await this.ctx.resume();
      return;
    }
    const ctx = new AudioContext({ latencyHint: "interactive" });
    this.ctx = ctx;
    // Resume inside the original user gesture, including on iOS.
    const resume = ctx.resume();
    this.loading = (async () => {
      await Promise.all([resume, ctx.audioWorklet.addModule(workletUrl)]);
      const node = new AudioWorkletNode(ctx, "yodel", {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: { module: chimeraModule() },
      });
      this.node = node;
      this.gain = ctx.createGain();
      this.gain.gain.value = this.muted ? 0 : 0.85;
      node.connect(this.gain).connect(ctx.destination);
      node.port.onmessage = (e) => {
        if (e.data.type === "error") this.fail(e.data.message);
        else this.receive(e.data);
      };
      node.onprocessorerror = () => this.fail("The audio engine stopped. Press Play to restart.");
      this.send({ type: "configure", plans: heldPlans() });
      this.configure();
    })();
    try {
      await this.loading;
    } catch (err) {
      this.close();
      throw err;
    } finally {
      this.loading = null;
    }
  }

  volume(muted: boolean) {
    this.muted = muted;
    if (this.ctx && this.gain) this.gain.gain.setTargetAtTime(muted ? 0 : 0.85, this.ctx.currentTime, 0.012);
  }
  private fail(message: string) {
    this.close();
    this.failed(message);
  }
  private close() {
    this.node?.disconnect();
    this.node?.port.close();
    this.node = null;
    if (this.ctx) void this.ctx.close().catch(() => {});
    this.ctx = null;
    this.gain = null;
  }
}
