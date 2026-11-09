# Yodel Studio

Yodel Studio sings in your browser. Press **Play yodel**, grab the tongue or jaw to change a vowel, and pull the vocal folds to bend the pitch. You can turn the whole performance into a song of your own. [Play Yodel Studio](https://yodel-studio.hackhumanity.workers.dev/)

[![Yodel Studio with six draggable points on the singer, the vibrating vocal folds and the phrase editor](docs/yodel-studio.webp)](https://yodel-studio.hackhumanity.workers.dev/)

This project is a focused **fork and expansion of Jameson Hodge’s CHIMERA physical voice model**. Jameson built the simulated vocal tract, glottal source, singing planner and wireframe anatomy. Yodel Studio adds the yodel arrangements, chest-to-falsetto control, live instrument, phrase editor and portable remixes. [Original CHIMERA repository](https://github.com/jamesondh/chimera-vocal-synth) · [Jameson Hodge on X](https://x.com/jamesonhodge)

Here, “fork” describes the source-code lineage. This is currently a standalone repository with a fresh history containing only Yodel Studio, rather than a member of GitHub’s CHIMERA fork network.

## Play it

- Choose a yodel from the menu. The pitch and speed sliders apply to the whole song.
- Drag the **lips, jaw, soft palate, tongue, throat or vocal folds** while the music plays. Turn on **Hold on drag** to linger on a syllable. Turn on **Rotate view** when you want to turn the head.
- Select a note in the **Phrase editor** to change its syllable, pitch or duration. Drag vertically to repitch it, sideways to reorder it, or duplicate it to repeat it. **Reset all** restores the controls and preset phrases. Named remixes stay in your song list.
- **Remix** makes a full copy you can name and edit. **Share** gives you a playable snapshot. Anyone can open it and make the next remix. The notes and mouth settings travel in the URL fragment, and named drafts save in the current browser.

## Creating the original performance

The original performance is a 45-second solo arrangement of *The Lonely Goatherd* from *The Sound of Music*, synthesized with a simulated mouth and vocal folds. The song is by Richard Rodgers and Oscar Hammerstein II. [The performance](https://x.com/klausbrave/status/2119372853502177323)

1. **Reverse-engineer the tune.** The opening 65 seconds of the film clip served as a listening and timing reference. Measurements of recurring onsets in the mixed soundtrack gave a quarter-note pulse of about 0.30 seconds, or 200 BPM. Candidate notes were compared against the strength of their harmonics, with checks against published notation for the opening and the original manuscript for the chorus. The orchestra made some octave choices ambiguous. The final chorus phrase has approximate timing. [Film reference on YouTube](https://www.youtube.com/watch?v=UmmOJx_Hxto) · [Rodgers and Hammerstein manuscript](https://rodgersandhammerstein.com/wp-content/uploads/2020/11/The-Lonely-Goatherd.pdf)
2. **Write a score the mouth could sing.** The arrangement contains 160 notes in 17 phrases in F major. Each event specifies a pitch, duration, syllable in the International Phonetic Alphabet and vocal register. At 200 BPM a consonant cluster can use up most of the note. Shortening consonants to 65% of the planner’s usual duration and moving one pickup half a beat earlier gave the following word time to voice. [Live articulation planner](yodel/articulation.ts)
3. **Make the register break audible.** The native Rust renderer drove pitch at the glottal source. At each yodel break it switched pressure, tension, brightness, breathiness and the gap at the back of the vocal folds. The note pitch glided for six milliseconds while the mouth continued shaping the vowels and consonants. The film’s lead vocal was synthesized from that score. [Browser register controls](yodel/processor.ts)
4. **Give the singer a breath budget.** To model the diaphragm’s role between phrases, the respiration model integrates airflow through the simulated airway to track a finite volume of air in the lungs. Passive recoil, diaphragm effort and abdominal effort determine the pressure available for a phrase. The performance schedules short inhales at rests. A sustain check confirmed that its closing 2.4-second note held voicing for 2.38 seconds. The lung outline, pressure readout and diaphragm curve in the film follow that same simulated state. The interactive instrument uses regulated breath to support holding a note indefinitely. [Respiration model](crates/chimera/src/voice/respiration.rs) · [Breathing tests](crates/chimera/tests/respiration.rs)
5. **Render the picture from the voice.** The native run wrote a 48 kHz vocal track and time-stamped telemetry. A browser canvas drew the cutaway head, slowed vocal-fold opening, airflow, pitch trace and captions from those timestamps. An original plucked bass-and-chord accompaniment supports the vocal track. A headless browser stepped the canvas through 1,350 frames, and FFmpeg combined those frames and the stereo mix into the 1600 × 900, 30 fps H.264 video. The output passed the per-note pitch and phrase checks. A separate listening check with automatic transcription still misheard some words.

## From film to playable instrument

The studio was built in Codex Desktop using Astra 6 with extra high effort, with localhost previews in the built-in browser. Testing phrase playback, handle selection, held syllables and editor access led to six labelled grab targets, opt-in head rotation and a compact layout that puts the editor above the fold on a laptop.

The build compiles the Rust engine to WebAssembly. The browser loads the module once and runs a separate instance inside an AudioWorklet. The score schedules articulation on the audio clock. The UI reads pitch and tract geometry back from the simulation to draw the singer. The built app serves static files. Playback, editing, encoding a share link and decoding it all run on the listener’s device. [Audio integration](yodel/audio.ts) · [Live anatomy](yodel/views.ts) · [Song link format](yodel/song-links.ts)

## Run locally

Install Rust with rustup and Bun. The app was tested with Bun 1.3.13. Run these commands from the repository root.

```sh
rustup target add wasm32-unknown-unknown
bun install --frozen-lockfile
bun run dev
```

Open [the live-reload studio](http://127.0.0.1:5344/). Choose **Play yodel** to enable audio. TypeScript, CSS and HTML edits update the local page. After changing Rust, run `bun run wasm` and reload.

```sh
bun run test
bun run build
bun run preview
```

With the production preview running and Google Chrome installed, use a second terminal for `bun run test:browser`. It plays a shared song in an independent browser session, remixes it again and checks both generations. [Local production preview](http://127.0.0.1:5343/)

### Original scores and the hosted arrangement

The hosted studio preloads the arrangement of **The Lonely Goatherd**. The song is by Richard Rodgers and Oscar Hammerstein II. The MIT license covers the code. The original music, lyrics, score and film recording retain their respective copyrights.

If you are rebuilding the hosted version and have the local *Goatherd* performance data, place its `performance.json` at `local-scores/goatherd.json` before running `bun run dev` or `bun run build`. The build imports the tempo, duration and timed vocal events. It keeps that input and the generated score out of Git.

## Following CHIMERA improvements

To connect a local checkout to Jameson’s repository, add the upstream remote once, then fetch its branches.

```sh
git remote add upstream https://github.com/jamesondh/chimera-vocal-synth.git
git fetch --no-tags upstream
git log --oneline -10 upstream/main
```

Run `git fetch --no-tags upstream` again to retrieve later changes. Fetching leaves Yodel Studio’s files and deployed app unchanged. Because this repository has a fresh history and a smaller codebase, review and port relevant changes on a branch, then run the tests and build before deploying. A blanket merge would bring back unrelated CHIMERA files and requires reconciling the separate histories.

## Credits

Built by [Klaus Bravenboer](https://klaus.co.nz/) from [Hack Humanity](https://hackhumanity.com/). Inspired by [CHIMERA](https://github.com/jamesondh/chimera-vocal-synth) by [Jameson Hodge](https://x.com/jamesonhodge).

The code is licensed under [MIT](LICENSE). Jameson’s original copyright and permission notice is preserved, with a separate copyright notice for Klaus Bravenboer’s Yodel Studio additions and modifications under the same terms. Archivo is distributed under the [SIL Open Font License](public/fonts/OFL.txt), and Three.js under its MIT license. Every production build includes these notices in `licenses.txt`.
