import {
  clamp,
  highNote,
  inFalsetto,
  lowNote,
  maxNotes,
  noteName,
  pronunciations,
  totalBeats,
  type Note,
  type Phrase,
} from "./score";

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
export class Editor {
  private roll = el("score");
  private cells = new Map<string, HTMLButtonElement>();
  private phrase!: Phrase;
  private selected = "";
  private playing = "";
  private dragging: {
    pointer: number;
    id: string;
    x: number;
    y: number;
    midi: number;
    axis: "" | "x" | "y";
  } | null = null;

  constructor(
    private pick: (id: string) => void,
    private update: (notes: Note[], selected: string) => void,
    reset: () => void,
  ) {
    const pitch = el<HTMLSelectElement>("edit-pitch"),
      syllable = el<HTMLSelectElement>("syllable");
    for (let n = lowNote; n <= highNote; n++) pitch.add(new Option(noteName(n), String(n)));
    for (const name of Object.keys(pronunciations)) syllable.add(new Option(name));
    pitch.onchange = () => this.edit({ midi: Number(pitch.value) });
    syllable.onchange = () => this.edit({ syllable: syllable.value });
    const beats = el<HTMLInputElement>("beats");
    beats.onchange = () => {
      if (!beats.value || !Number.isFinite(beats.valueAsNumber)) {
        this.syncControls();
        return;
      }
      this.edit({ beats: clamp(Math.round(beats.valueAsNumber * 1000) / 1000, 0.125, 12) });
    };
    el("duplicate").onclick = () => {
      const notes = this.phrase.notes,
        i = this.selectedIndex;
      if (notes.length >= maxNotes) return;
      const copy = { ...notes[i], id: crypto.randomUUID() };
      this.update([...notes.slice(0, i + 1), copy, ...notes.slice(i + 1)], copy.id);
    };
    el("remove").onclick = () => {
      if (this.phrase.notes.length <= 1) return;
      const notes = this.phrase.notes.filter((n) => n.id !== this.selected);
      this.update(notes, notes[Math.min(this.selectedIndex, notes.length - 1)].id);
    };
    el("left").onclick = () => this.move(this.selectedIndex - 1);
    el("right").onclick = () => this.move(this.selectedIndex + 1);
    el("reset").onclick = reset;
    this.roll.addEventListener("pointerdown", (e) => this.down(e));
    this.roll.addEventListener("pointermove", (e) => this.drag(e));
    this.roll.addEventListener("lostpointercapture", () => {
      if (this.dragging) this.cells.get(this.dragging.id)?.classList.remove("dragging");
      this.dragging = null;
    });
    this.roll.addEventListener("click", (e) => {
      const cell = (e.target as HTMLElement).closest<HTMLButtonElement>(".cell");
      if (cell?.dataset.id && (e.detail === 0 || cell.dataset.id !== this.selected)) this.pick(cell.dataset.id);
    });
  }

  private get selectedIndex() {
    return this.phrase.notes.findIndex((n) => n.id === this.selected);
  }
  private edit(patch: Partial<Note>) {
    this.update(
      this.phrase.notes.map((n) => (n.id === this.selected ? { ...n, ...patch } : n)),
      this.selected,
    );
  }
  private move(to: number) {
    const notes = this.phrase.notes.slice(),
      from = this.selectedIndex;
    if (to < 0 || to >= notes.length || from === to) return;
    notes.splice(to, 0, notes.splice(from, 1)[0]);
    this.update(notes, this.selected);
  }
  private down(e: PointerEvent) {
    const bar = (e.target as HTMLElement).closest(".note-bar"),
      cell = bar?.parentElement;
    if (!cell?.dataset.id || e.button !== 0 || this.dragging) return;
    e.preventDefault();
    this.pick(cell.dataset.id);
    cell.focus({ preventScroll: true });
    this.dragging = {
      pointer: e.pointerId,
      id: this.selected,
      x: e.clientX,
      y: e.clientY,
      midi: this.phrase.notes[this.selectedIndex].midi,
      axis: "",
    };
    this.roll.setPointerCapture(e.pointerId);
    cell.classList.add("dragging");
  }
  private drag(e: PointerEvent) {
    const d = this.dragging;
    if (!d || e.pointerId !== d.pointer || !e.buttons) return;
    const dx = e.clientX - d.x,
      dy = d.y - e.clientY;
    if (!d.axis && Math.max(Math.abs(dx), Math.abs(dy)) >= 5) d.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
    if (d.axis === "y") {
      const midi = clamp(d.midi + Math.round(dy / 6), lowNote, highNote);
      if (midi !== this.phrase.notes[this.selectedIndex].midi) this.edit({ midi });
    }
    if (d.axis === "x") {
      const row = this.roll.getBoundingClientRect();
      const target = document.elementFromPoint(e.clientX, row.top + row.height / 2)?.closest<HTMLElement>(".cell");
      const index = this.phrase.notes.findIndex((n) => n.id === target?.dataset.id);
      if (index >= 0) this.move(index);
    }
  }

  render(phrase: Phrase, selected: string) {
    this.phrase = phrase;
    this.selected = selected;
    const notes = phrase.notes;
    const shift = phrase.transpose ?? 0;
    const options = el<HTMLSelectElement>("edit-pitch").options;
    for (let i = 0; i < options.length; i++) options[i].text = noteName(lowNote + i + shift);
    const min = Math.min(55, ...notes.map((n) => n.midi)) - 1,
      max = Math.max(67, ...notes.map((n) => n.midi)) + 1;
    for (const [id, node] of this.cells)
      if (!notes.some((n) => n.id === id)) {
        node.remove();
        this.cells.delete(id);
      }
    notes.forEach((note, index) => {
      let node = this.cells.get(note.id);
      if (!node) {
        node = document.createElement("button");
        node.className = "cell";
        node.dataset.id = note.id;
        const bar = document.createElement("span");
        bar.className = "note-bar";
        bar.append(document.createElement("b"), document.createElement("small"));
        node.append(bar);
        this.cells.set(note.id, node);
      }
      if (this.roll.children[index] !== node) this.roll.insertBefore(node, this.roll.children[index] ?? null);
      node.classList.toggle("high", inFalsetto(note));
      node.classList.toggle("playing", note.id === this.playing);
      node.setAttribute("aria-pressed", String(note.id === selected));
      node.setAttribute(
        "aria-label",
        "Note " +
          (index + 1) +
          ", " +
          note.syllable +
          ", " +
          noteName(note.midi + shift) +
          ", " +
          note.beats +
          " beats",
      );
      const height = (max - note.midi) / (max - min);
      node.style.setProperty("--top", 13 + 74 * height + "%");
      node.style.setProperty("--weight", String(note.beats));
      node.style.setProperty("--min", 47 + note.beats * 3 + "px");
      node.querySelector("b")!.textContent = note.syllable;
      node.querySelector("small")!.textContent = noteName(note.midi + shift);
    });
    el("axis-high").textContent = noteName(max - 1 + shift);
    el("axis-low").textContent = noteName(min + 1 + shift);
    el("axis-mid").textContent = noteName(Math.round((max + min) / 2) + shift);
    this.syncControls();
  }
  private syncControls() {
    const i = this.selectedIndex,
      n = this.phrase.notes[i];
    el("selected").textContent = "Note " + String(i + 1).padStart(2, "0");
    el<HTMLSelectElement>("edit-pitch").value = String(n.midi);
    el<HTMLSelectElement>("syllable").value = n.syllable;
    el<HTMLInputElement>("beats").value = String(n.beats);
    el<HTMLButtonElement>("left").disabled = i === 0;
    el<HTMLButtonElement>("right").disabled = i === this.phrase.notes.length - 1;
    el<HTMLButtonElement>("remove").disabled = this.phrase.notes.length === 1;
    el<HTMLButtonElement>("duplicate").disabled = this.phrase.notes.length >= maxNotes;
    el("phrase-info").textContent =
      this.phrase.notes.length +
      " notes · " +
      ((totalBeats(this.phrase) * 60) / this.phrase.bpm).toFixed(2) + " s";
  }
  playhead(id: string) {
    if (this.playing === id) return;
    this.cells.get(this.playing)?.classList.remove("playing");
    this.playing = id;
    const cell = this.cells.get(id);
    cell?.classList.add("playing");
    if (cell && !this.dragging && this.phrase.leadBeats !== undefined) {
      const scroll = this.roll.parentElement!;
      const viewport = scroll.getBoundingClientRect(),
        note = cell.getBoundingClientRect();
      if (note.left < viewport.left || note.right > viewport.right) scroll.scrollLeft += note.left - viewport.left;
    }
  }

  rewind() {
    this.roll.parentElement!.scrollLeft = 0;
  }
}
