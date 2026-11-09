import { hasPerformance, publishedName } from "./published";
import { trackUsage } from "./analytics";
import { defaultPreset, original, presets, type Phrase, type Preset } from "./score";
import { maxTitle, readSong, songFragment, songUrl, validSong, validTitle, type Song } from "./song-links";

const remixPrefix = "chimera.yodel-remix.v1.";
const sharedKey = "shared";
const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const isPreset = (key: string): key is Preset => Object.hasOwn(presets, key);
const notice = (text: string) => { el("song-status").textContent = text; };

export class SongMenu {
  private remixes = new Map<string, Song>();
  private shared: { song: Song; hash: string } | null = null;
  private key: string;
  localKey: string;
  current: Song;

  constructor(
    private drafts: Partial<Record<Preset, Phrase>>,
    initialKey: string,
    private onSelect: () => void,
  ) {
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key?.startsWith(remixPrefix)) continue;
        const raw = localStorage.getItem(key);
        if (!raw || raw.length > 192 * 1024) continue;
        try {
          const song = JSON.parse(raw);
          if (validSong(song)) this.remixes.set(key, song);
        } catch { /* An unreadable copy does not affect the others. */ }
      }
    } catch { /* A disabled store still allows playing, remixing and sharing. */ }
    this.localKey = isPreset(initialKey) || this.remixes.has(initialKey) ? initialKey : defaultPreset;
    this.key = this.localKey;
    this.current = this.lookup(this.key);
    for (const name of Object.keys(presets)) el("local-songs").before(new Option(name));
    this.render();

    el<HTMLSelectElement>("preset").onchange = (e) => {
      const key = (e.target as HTMLSelectElement).value;
      this.setAddress(key === sharedKey ? this.shared!.hash : "");
      this.choose(key);
      notice("");
      this.onSelect();
    };
    window.addEventListener("hashchange", async () => {
      if (await this.readLocation()) this.onSelect();
    });
    // The studio wordmark scrolls to the instrument without discarding an open song link.
    document.querySelector<HTMLAnchorElement>(".brand")!.onclick = (e) => {
      if (!location.hash.startsWith(songFragment)) return;
      e.preventDefault();
      el("instrument").scrollIntoView();
    };
    this.bindNaming();
    this.bindSharing();
  }

  private lookup(key: string): Song {
    if (key === sharedKey) return this.shared!.song;
    if (isPreset(key)) return { title: key, baseBpm: presets[key].bpm, phrase: this.drafts[key] ?? original(key) };
    return this.remixes.get(key)!;
  }

  private render() {
    const local = el<HTMLOptGroupElement>("local-songs"), incoming = el<HTMLOptGroupElement>("shared-songs");
    local.replaceChildren(...Array.from(this.remixes, ([id, song]) => new Option(song.title, id)));
    local.hidden = !this.remixes.size;
    incoming.replaceChildren(...(this.shared ? [new Option(this.shared.song.title, sharedKey)] : []));
    incoming.hidden = !this.shared;
    el<HTMLSelectElement>("preset").value = this.key;
    el("rename-song").hidden = !this.remixes.has(this.key);
    el("original-performance").hidden = !hasPerformance || this.key !== publishedName;
    document.title = this.key === defaultPreset ? "Yodel Studio" : this.current.title + " · Yodel Studio";
  }

  private choose(key: string) {
    this.key = key;
    if (key !== sharedKey) this.localKey = key;
    this.current = this.lookup(key);
    this.render();
  }

  private setAddress(hash: string) {
    if (location.hash === hash || (!hash && !location.hash.startsWith(songFragment))) return;
    const url = new URL(location.href);
    url.hash = hash;
    history.pushState(null, "", url);
  }

  async readLocation() {
    const hash = location.hash;
    if (hash.startsWith(songFragment)) {
      try {
        const song = await readSong(hash);
        if (location.hash !== hash) return false;
        this.shared = { hash, song };
        this.choose(sharedKey);
        trackUsage("shared_open");
        notice("");
        return true;
      } catch {
        if (location.hash !== hash) return false;
        notice("This song link could not be opened. Check the full link or try a current browser.");
      }
    } else {
      notice("");
    }
    if (this.key !== sharedKey) return false;
    this.choose(this.localKey);
    return true;
  }

  reset() {
    for (const key of Object.keys(presets) as Preset[]) delete this.drafts[key];
    this.setAddress("");
    this.choose(defaultPreset);
    notice("");
  }

  private store(key: string, song: Song) {
    this.remixes.set(key, song);
    try {
      // A separate record per composition keeps other tabs' songs intact.
      localStorage.setItem(key, JSON.stringify(song));
    } catch {
      notice("This browser couldn’t save the remix. Copy its share link to keep it.");
    }
  }

  private create(song: Song) {
    const key = remixPrefix + crypto.randomUUID();
    this.store(key, song);
    this.setAddress("");
    this.choose(key);
    trackUsage("remix_created");
  }

  update(phrase: Phrase) {
    if (this.key === sharedKey) {
      // Direct edits to a shared performance also become an independent local remix.
      notice("You’re editing your own remix. The shared version is in the song list.");
      this.create({ ...this.current, phrase, title: this.suggestName() });
      return;
    }
    this.current = { ...this.current, phrase };
    if (isPreset(this.key)) this.drafts[this.key] = phrase;
    else this.store(this.key, this.current);
  }

  private nameTaken(title: string, except = "") {
    return isPreset(title) || Array.from(this.remixes).some(([key, song]) => key !== except && song.title === title);
  }

  private suggestName() {
    const stem = this.current.title.replace(/ remix(?: \d+)?$/, "").slice(0, maxTitle - 12).trimEnd();
    const base = stem + " remix";
    let candidate = base, n = 1;
    while (this.nameTaken(candidate) || candidate === this.current.title) candidate = base + " " + ++n;
    return candidate;
  }

  private bindNaming() {
    const dialog = el<HTMLDialogElement>("name-dialog"), input = el<HTMLInputElement>("song-name");
    let renaming = false;
    const open = (rename: boolean) => {
      renaming = rename;
      input.value = rename ? this.current.title : this.suggestName();
      input.setCustomValidity("");
      el("name-heading").textContent = rename ? "Rename song" : "Remix song";
      el("name-submit").textContent = rename ? "Save name" : "Create remix";
      dialog.showModal();
      input.select();
    };
    el("remix-song").onclick = () => open(false);
    el("rename-song").onclick = () => open(true);
    el("name-cancel").onclick = () => dialog.close();
    input.oninput = () => input.setCustomValidity("");
    el<HTMLFormElement>("name-form").onsubmit = (e) => {
      e.preventDefault();
      const title = input.value.trim();
      if (!validTitle(title) || this.nameTaken(title, renaming ? this.key : "")) {
        input.setCustomValidity(validTitle(title) ? "A song already uses this name." : "Enter a song name.");
        input.reportValidity();
        return;
      }
      notice("");
      if (renaming) {
        this.current = { ...this.current, title };
        this.store(this.key, this.current);
        this.render();
      } else {
        this.create({ ...this.current, title, phrase: structuredClone(this.current.phrase) });
        this.onSelect();
      }
      dialog.close();
    };
  }

  private bindSharing() {
    const dialog = el<HTMLDialogElement>("share-dialog"), field = el<HTMLInputElement>("song-link");
    const copy = el<HTMLButtonElement>("copy-link"), status = el("share-status");
    let generation = 0;
    el("share-song").onclick = async () => {
      const request = ++generation;
      el("share-heading").textContent = "Share “" + this.current.title + "”";
      field.value = "";
      copy.disabled = true;
      status.textContent = "Preparing link…";
      dialog.showModal();
      try {
        const url = await songUrl(this.current, location.href);
        if (request !== generation) return;
        field.value = url;
        copy.disabled = false;
        status.textContent = "Anyone with this link can play and remix this version.";
        trackUsage("share_created");
      } catch {
        if (request === generation) status.textContent = "The share link could not be created.";
      }
    };
    copy.onclick = async () => {
      try {
        await navigator.clipboard.writeText(field.value);
        status.textContent = "Link copied.";
        trackUsage("share_copied");
      } catch {
        field.focus();
        field.select();
        status.textContent = "The link is selected. Use your device’s Copy command.";
      }
    };
    field.onclick = () => field.select();
    el("share-close").onclick = () => dialog.close();
  }
}
