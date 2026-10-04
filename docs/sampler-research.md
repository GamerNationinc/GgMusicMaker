# GgMusicMaker — Sampler Instrument Mode: Feature Research

**Deep-dive on what to build into the SP-404-style instrument, from the universally loved to the genuinely weird.**

_Research, 2026-10-04. Nothing in here is built yet unless the note below says so._

**Built (2026-10-04):**
- Skip-back (§3.1) and resample (§3.3): a 120 s ring of the output in both
  engines (`native/src/skipback.rs`, `public/skipback-processor.js`,
  `src/audio/skipback.ts`). In Studio / SYNTH they land on a new layer; in
  the PADS kit, on a pad. Controls: ⟲ / ◉ in the transport, B / Shift+B,
  Instrument mode R3 / L1·R1+R3.
- Pad engine (§2.1–2.3): 10 × 16 pads in the project, one-shot / gate /
  latching loop, reverse, gain, pan, repitch, attack/release, choke groups,
  mono/poly — `src/pads/pads.ts`, `native/src/pads.rs`, `src/audio/sampler.ts`.
  Instrument mode → PADS kit (Menu tap); loading from a clip, files,
  skip-back or resample.
- Chop lab (§2.4): waveform, tap-to-audition, draggable cuts, transient /
  equal auto-chop, slices → pads (`src/pads/chop.ts`, `ChopLab.svelte`).
- Character FX buses (§3.2): VINYL, CASSETTE, LO-FI, FILTER+DRIVE, ECHO,
  LOOPER on four buses (1–2 per pad, 3–4 master), latched or grabbed with R2,
  left pad = XY macros (`public/fxbus-core.js`, `native/src/fxbus.rs`,
  `src/fx/fxbus.ts`).

Not yet: resonator / isolator / reverb / ducker effects, FX automation,
time-stretch, polyphony limit setting, drunk chop, zero-crossing
snap, BPM-grid chop, pinch zoom in the chop lab, named "ghost" snapshots,
ghost tape (§6.2).

## How this relates to what exists (read first)

- **Instrument mode today is not a sampler.** It is a scale-locked synth on the
  right trackpad plus four drum/chord pads on ABXY (`src/input/instrument.ts`,
  `src/audio/live.ts`; spec in `docs/deck-dual-mode.md`). The sampler below is a
  new pad engine. Whether it replaces that layout or sits beside it (e.g. an
  INSTRUMENT ⇄ SAMPLER sub-mode) is undecided.
- **§7's control map is a proposal and conflicts with the shipped map** (back
  buttons, D-pad, triggers and gyro arming all do different things today). Pick
  one per mode before building the sampler's input layer.
- **Stem separation already exists** — HTDemucs in the native engine
  (`native/src/separate.rs`, `src/audio/stems.ts`, `StemsDialog.svelte`).
  §4.7 is "route stems to pads", not "integrate a model".
- **Name clash:** "PUNCH" in this repo is the drums+bass enhancer
  (`src/fx/punch.ts`). The EP-133-style momentary effects in §4.1 need another
  name (e.g. "STAB FX" / "GRAB FX") in UI and code.
- **There is no project tempo yet** (MASTER.md → Near term). The sequencer,
  note repeat, looper, punch-in sync, groove and Ableton Link all need it, so it
  comes before §3.4.
- **Recording + live take peaks exist** (`src/audio/recording.ts`,
  `src/audio/liveTake.ts`, native `record.rs`) and are the natural base for
  skip-back (§3.1) and ghost tape (§6.2).
- **Shared engine decision stands:** the sampler runs inside the existing
  engine (native mixer + web twin), so pads get the master bus, meters and FX.

---

Scope: this covers the *instrument/sampler* subsystem of GgMusicMaker (Steam Deck, controller-first, standalone engine, VST-hostable). Stage 1 = production/mixing, Stage 2 = live DJ mode. Each feature is tagged:

- 🟢 **Core** — table stakes; the instrument isn't credible without it
- 🔵 **Popular** — the features people actually buy these devices for
- 🟣 **Fringe** — rare, weird, or cult features that would differentiate GgMusicMaker
- 🧪 **Original** — nobody has this; software-only opportunities

Effort ratings (S/M/L/XL) are rough engineering-size guesses for a solo dev with Claude Code.

---

## 1. Reference landscape

| Device / App | Why it matters to us | Signature idea to steal |
|---|---|---|
| **Roland SP-404MKII** | The cult king of performance sampling; lo-fi hip-hop's instrument | Skip-back buffer, performance FX buses, resampling-as-workflow |
| **DOOM OS (Klangfeld Labs, 2026)** | Community custom firmware for the MK2 — proof of what users wish the SP had | Graphical pattern editor, mixer w/ metering, FX automation, custom shortcuts, piano roll on pads |
| **Teenage Engineering EP-133 K.O. II** | Fastest sample-to-beat workflow on the market | Punch-in FX, fader-as-macro, commit-fast philosophy |
| **Akai MPC One / Live II** | The "serious" standalone; closest hardware to a full DAW | Note repeat w/ pressure, 16 Levels, track mutes, clip launching |
| **Koala Sampler (iOS/Android)** | The touchscreen-native SP clone — our closest UX cousin | Touch chop, instant resample, dead-simple sequencing, "it just works" |
| **Elektron Digitakt / Digitakt II** | Deepest step sequencer in a box | Parameter locks (p-locks), conditional trigs, song mode |
| **Teenage Engineering OP-1 / OP-1 Field** | Weird-by-design; tape as metaphor | Tape mode, lift/drop clipboard, constrained 4-track |
| **SP-303 / SP-202 (Dr. Sample)** | The Madlib/Dilla lineage; "limitations as catalyst" | Vinyl Sim, deliberate low-fi encoders, tiny feature set that forces creativity |
| **1010music Blackbox** | Touchscreen sampler, grid-of-cells model | Per-cell play modes (one-shot/clip/slicer/granular) |
| **Polyend Tracker / M8 (Dirtywave)** | Tracker revival; handheld, hacker aesthetic | Vertical tracker sequencing, tiny-screen-dense UI, chiptune cred |
| **Casio SK-1 / circuit-bent gear** | The fringe of the fringe | Glitch as a feature, byte-level sample mangling |

The Steam Deck advantage over all of these: touchscreen + 2 analog sticks + 2 trackpads + gyro + 4 back buttons + a real CPU/GPU. No hardware sampler has that input surface. The design goal is **SP immediacy with DAW depth available one layer down** — exactly what DOOM OS proves people want.

---

## 2. 🟢 Core pad engine (must-have)

### 2.1 Pad grid & banks
- 4×4 touchscreen pad grid (SP standard); banks A–J (10 banks × 16 pads = 160 slots, matching MK2).
- Controller cluster: ABXY + D-pad = 8 "performance pads"; L4/R4/L5/R5 back buttons = bank up/down + shift + FX-grab. Hold-to-preview on touch.
- RGB-style pad states (playing / looping / muted / choked) — fits the cyberpunk UI; make pads glow/scanline when triggered.
- **Effort: M** (the grid is easy; good controller mapping UX is the work)

### 2.2 Sample playback modes (per pad)
- One-shot, gate (plays while held), loop, reverse, and **choke groups** (open/closed hi-hat behavior — MPC "mute groups").
- Per-pad: gain, pan, pitch (±2 oct, both repitch and time-stretch modes), ADSR envelope (the MK2 only got envelopes later — ship it day one), start/end points, velocity curve.
- Polyphony control: mono/poly per pad + global voice limit (keeps Deck CPU honest).
- **Effort: M**

### 2.3 Sampling & import
- Record from: file import (WAV/FLAC/MP3/OGG), Deck mic, USB audio interface, **and any other app via PipeWire loopback** (sample YouTube/Spotify/your own game audio — the software equivalent of the SP's line-in; this is huge and trivial on Linux).
- Drag-a-folder bulk import (you already want Virtual-DJ-style bulk add — same pipeline).
- Threshold/auto-start recording, pre-roll, count-in.
- **Effort: M** (PipeWire capture is the differentiator and it's nearly free)

### 2.4 Chop lab
- Zoomable waveform, touch-drag slice markers, pinch zoom.
- Auto-chop: by transient detection, equal divisions, or BPM grid.
- "Slices to pads" in one tap; audition slices by tapping regions.
- **Fringe add 🟣: "drunk chop"** — randomize slice points within a tolerance for happy accidents (community SP trick done manually).
- **Effort: M–L** (transient detection is a solved problem — use aubio or write a spectral-flux detector)

---

## 3. 🔵 The features people buy an SP for

### 3.1 Skip-back / always-on capture ⭐ highest ROI in the doc
The MK2 keeps an always-on buffer of the main output so you can rescue what you just played. In software:
- Ring-buffer the **master bus** (and optionally the input bus) — last 60s at 48k stereo ≈ 23 MB RAM. Trivial.
- One button ("SKIP BACK") opens the buffer in the chop lab; trim and commit to a pad.
- 🧪 **Original twist:** keep *multiple* named skip-back snapshots ("ghosts") with timestamps, browsable like a quicksave list. Hardware can't afford the RAM; you can keep an hour.
- **Effort: S–M. Build this first.**

### 3.2 Performance FX buses
The SP's identity is FX-as-instrument: big buttons, grabbed live, momentary.
- 4 FX buses (matching MK2), each holding one effect; pads/tracks route to buses.
- **FX grab:** hold L2/R2 = effect engaged only while held; release = dry. Right stick = the 2 macro knobs of the active effect; trackpad = XY pad.
- Must-clone character FX (these define "the SP sound"):
  - **Vinyl Simulator** (wow/flutter, crackle, HF rolloff, stop/start brake)
  - **Cassette Simulator** (hiss, saturation, dropouts, speed instability)
  - **Lo-fi / bit-crush / sample-rate reduce** (model the SP-303's famous encoder grit — see §6.1)
  - **DJFX Looper** (grab a slice of output, loop it, shrink the loop, pitch it — the stutter effect)
  - **Resonator** (tuned comb bank — MK2's trippy one)
  - Isolator EQ (3-band kill), filter+drive, tape echo, spring/hall reverb, sidechain-style "ducker"
- **Effort: L** overall, but each individual effect is S–M; ship 6, grow the list.

### 3.3 Resampling as a first-class verb
The lo-fi workflow *is* the resample loop: play pads through FX → bounce to a new pad → chop again → repeat until it's crusty.
- One-button "RESAMPLE": records the master (or a selected bus) to a new pad, with the FX baked in.
- Keep lineage metadata (🧪 see §6.3) so you can trace/undo generations.
- **Effort: S** (it's the skip-back machinery pointed at a pad)

### 3.4 Pattern sequencer — both ways
- **Real-time capture** (SP style): hit record, play pads, quantize 0–100% strength, swing. Overdub, undo-last-take, erase-while-holding-pad.
- **Graphical step editor** (the DOOM OS lesson): piano-roll / step grid view with per-step velocity, micro-timing nudge, length. DOOM OS exists *because* the SP lacks this; you get it natively.
- Pattern chaining → song mode; per-pattern BPM; pattern length 1–64 bars, per-track polymeter (see §6.5).
- **Note repeat / roll** (MPC staple): hold a shoulder button + pad = retrigger at 1/4…1/64T; analog trigger pressure = roll rate or velocity ramp. Trap hats with an analog trigger is a genuinely better interface than any pad.
- **16 Levels** (MPC): one sample spread across all 16 pads by velocity, pitch, start-point, or filter.
- **Effort: L** (the sequencer is the biggest single system in instrument mode)

### 3.5 Live looper
MK2's Loop Capture: record, loop, and layer in real time.
- Looper tied to master clock; capture 1/2/4/8-bar loops of anything (pads, mic, PipeWire input); instant overdub layers with per-layer undo.
- Layers land as stems you can later drag into the session view — looper jam → arranged track with zero friction. Hardware can't do that handoff; you can.
- **Effort: M**

### 3.6 Pitch/time
- Repitch (classic, cheap, crunchy) and independent time-stretch (Rubber Band library or a WSOLA/phase-vocoder you own).
- BPM detect per sample; "fit to project tempo" toggle per pad.
- VariPhrase-style **Groove** (MK2 v4.04): impose swing templates onto *audio loops*, not just MIDI — slice-shift internally. Rare in software, very doable.
- **Effort: M–L** (Groove-on-audio is the hard-but-worth-it part)

### 3.7 Mixer with metering
DOOM OS added this to the SP because performers need it: per-pad/track level, pan, bus sends, mute/solo, real meters. You need it anyway for Stage 1 — just make sure it's reachable *from* instrument mode in one button, not buried in the DAW layer.
- **Effort: S** (you're building it for the DAW anyway)

### 3.8 FX motion / automation recording
DOOM OS's other headline: record knob/FX moves into the pattern and edit them.
- Record stick/trackpad gestures as automation lanes; loop-length motion sequences (Elektron-style "control all" optional).
- Editable as curves in the step editor.
- **Effort: M**

---

## 4. 🔵 Popular features from the neighbors

### 4.1 Punch-in FX (EP-133 K.O. II)
Momentary, pattern-synced stutters/filters/tape-stops on dedicated buttons — zero setup, instant dopamine. Map 8 punch-ins to D-pad + ABXY while a shoulder "FX layer" button is held. Arguably the single most fun-per-line-of-code feature in this doc. **Effort: S–M**

### 4.2 Parameter locks (Elektron)
Hold a step, turn a knob → that value applies *only on that step*. Any per-pad parameter (pitch, filter, start point, reverse…) lockable per step. This is how one 2-bar pattern becomes a living thing. Touchscreen makes p-lock editing dramatically nicer than Elektron's workflow. **Effort: M** (if the sequencer stores per-step param deltas from day one — design it in now, retrofitting is painful)

### 4.3 Conditional trigs (Elektron)
Per-step probability (%, 1:2, 3:4, "fill only", "first loop only"). Cheap to implement, massive replay value, makes patterns breathe. **Effort: S**

### 4.4 Per-cell play behavior (1010 Blackbox)
Each pad independently set as: one-shot / gated / **clip-launcher (quantized loop, Ableton-session-style)** / slicer / granular. The clip mode is your bridge between instrument mode and the session layout you already planned. **Effort: M**

### 4.5 Tape mode (OP-1)
A 4-track virtual tape you *perform onto*: record pads/looper to tape, then scrub, reverse, half-speed, splice with the stick. It's an arrangement tool disguised as a toy and it's why people love the OP-1. Pairs beautifully with a 90s-hacker UI (draw the reels, VU meters, scanlines). **Effort: L, but very "GgMusicMaker"**

### 4.6 Koala-isms
- Tap-tempo everywhere; shake-to-undo equivalents (gyro flick = undo? silly, memorable).
- "Make a beat in 60 seconds" golden path: record → auto-chop → pads → sequence with ≤ 6 taps total. Benchmark the UX against Koala; it's the bar for touch sampling.

### 4.7 Stem separation 🟣→🔵 (rapidly going mainstream)
SP v5.x turned the hardware into a Serato stems controller; phones do on-device separation now. Ship an offline stem-split (open models: Demucs/htdemucs run fine offline; quantized versions are Deck-feasible as a non-realtime "process" step): drop a song → vocals/drums/bass/other land on 4 pads. For Stage 2 DJ mode this is table stakes by 2027. **Effort: L** (integration + model packaging; the model itself is off-the-shelf) — *already integrated for the timeline; see the note at the top.*

---

## 5. 🟣 Fringe: cult features worth cloning

### 5.1 SP-303 "Vinyl Sim + resample until it dies" lineage
Model the *actual degradation*: the 303/404 sound is partly its lossy internal encoder. Offer "SP-303 mode" / "SP-404 mode" codecs as print-on-resample options (see §6.1). Nobody in software does faithful *generational* loss. **Effort: M**

### 5.2 D-Beam, reborn as gyro
The SP-404's infrared D-Beam (wave your hand to bend FX) was goofy and beloved. The Deck's **gyro is a better D-Beam**: tilt = filter cutoff / pitch bend / FX depth while a grab button is held. Physical, performative, great on camera. **Effort: S**

### 5.3 Tracker mode (Polyend/M8/Famitracker heritage)
A vertical tracker view as an *alternative sequencer skin*: hex rows, per-row FX commands (retrig Rxx, cut Cxx, pitch slide, arp). The demoscene/chiptune crowd overlaps heavily with "cyberpunk DAW on a handheld" and the M8 proved people pay for exactly this. Mostly a *view* over your existing sequencer + a command interpreter. **Effort: M–L**

### 5.4 Mangle-class granular pad
One pad mode = granular engine (grain size/density/spray/pitch jitter), trackpad scrubs the playhead through the waveform. See: Borderlands Granular, the GR-1. Instant ambient/texture machine from any sample. **Effort: M–L**

### 5.5 Chaos/glitch pad (circuit-bending sim)
A "bend" FX bus: buffer repeat with decaying slices, bitfield corruption, DC skips, SK-1-style crash loops — with a *panic* button that always returns clean. Glitch as a safe, performable instrument. On-brand for the hacker aesthetic. **Effort: M**

### 5.6 Pad-link / mutate tricks from the SP community
- **Pad chains:** one pad triggers a round-robin or random pick from a set (variation without sequencing).
- **Sample roulette:** button randomizes which bank variant plays — lo-fi sets use this for live surprise.
- **Auto-pitch ladder:** DJ Screw button — momentary −6 semitone + slowdown on the whole mix. **Effort: S each**

### 5.7 Scatter / ghost notes generator
Roland's AIRA "Scatter" (and the MK2's pattern-mutate direction): one knob that algorithmically stutters/reverses/gates the current pattern, with 10 intensities, non-destructive. Plus a "ghost note" generator that adds low-velocity hits in the pocket (J Dilla assist mode). **Effort: M**

### 5.8 MIDI/hardware friendliness (fringe for a Deck app, core for credibility)
- Class-compliant USB MIDI in/out via dock: use a real pad controller at home, clock-sync external boxes.
- **Ableton Link** over Wi-Fi — jam in sync with phones/laptops/other Decks. (Link SDK is free; this is a killer demo: two Steam Decks, one beat.)
- MIDI mapping learn-mode for every control. **Effort: M**

### 5.9 Mutable-Instruments-style "secret menus"
Hardware culture loves easter eggs (hold X+Y on boot → hidden mode). Hide a few: a secret FX, a 1-bit "virtual boy" skin, a playable mini-game that generates a drum pattern from your score. Costs little, earns community lore. **Effort: S**

---

## 6. 🧪 Original / software-only opportunities

Things no hardware box can do, that fit your constraints (standalone, low-resource, cyberpunk).

### 6.1 Codec-as-color engine
Generalize §5.1: a rack of **print codecs** — SP-303ish, 8-bit sampler (SK-1/Amiga Paula with period-quantized pitch), ADPCM console audio (PS1/N64 vibes), GSM phone codec, MP3-at-64k smear, VHS hi-fi. Selectable on resample *and* as a realtime "monitor through" preview. Generational degradation is tracked (resample 5 times = 5 passes). This is a genuinely novel selling point and pure DSP — no licenses needed if you implement the character, not the patented codecs, or use open ones. **Effort: M–L**

### 6.2 Infinite skip-back ("ghost tape")
§3.1 extended: a session-long, disk-backed capture of the master bus (compressed), scrubbable on a timeline. "That jam 20 minutes ago" is always recoverable. Storage math: FLAC-compressed 48k stereo ≈ 0.3–0.5 GB/hour — nothing on a Deck SSD. Marketing name writes itself. **Effort: M**

### 6.3 Sample lineage graph
Every chop/resample/bounce records parentage. A node-graph view ("where did this crusty snare come from?") lets you re-open any ancestor, A/B generations, or re-print with different settings. Doubles as non-destructive editing. Fits the hacker UI perfectly (render it like a netrunner intrusion tree). **Effort: M** (it's metadata + a view, if designed in early)

### 6.4 Dual-mode handoff (your Stage 1 ↔ Stage 2 bridge)
Any instrument-mode pattern/looper take is a draggable clip in the session/album view; any album track is loadable to a pad/deck. The *album-level workflow* you want becomes: jam in instrument mode → clips accumulate → arrange in session → album view. Make the data model unified from day one so "modes" are views, not silos. **Effort: architectural decision, not a feature — decide now**

### 6.5 Polymeter / polyrhythm per track
Per-track pattern lengths (3 vs 4 vs 7 steps) and per-track clock dividers. Cheap in software, rare and adored (Elektron/modular crowd). **Effort: S**

### 6.6 Deck-native performance inputs
- **Capacitive stick touch** = vibrato/aftertouch without pressing.
- **Trackpad haptics** as a metronome you *feel* (silent click for live use — genuinely useful, no hardware sampler has it).
- **Analog triggers** = velocity/roll-rate/FX depth continuum.
- **Gyro** = D-Beam (§5.2).
- Per-feature toggles; never required. **Effort: S–M each**

### 6.7 "Beat tape" exporter
One-button render of a pattern chain to a continuous mix with tape hiss, side-markers, and a generated J-card PNG (cassette-styled cover using your UI font). Lo-fi community currency is the beat tape; make exporting one a ritual. Also: per-pad multitrack stem export (MK2 v4.04's Multipad Export). **Effort: S–M**

### 6.8 Practice/arcade layer (ties to your training-game instincts)
Optional "beat challenges": recreate-this-pattern, finger-drumming accuracy scoring with combo meters, daily sample flip (everyone gets the same sample, local score). Dangerous scope creep if deep — keep it a thin gamified skin over existing features, or cut. **Effort: M, cuttable**

---

## 7. Steam Deck control map (proposed default)

_Proposal only — differs from the shipped Instrument map in `docs/deck-dual-mode.md`._

| Input | Instrument mode |
|---|---|
| Touchscreen | Pad grid / chop lab / step editor |
| ABXY + D-pad | 8 performance pads (bank-assignable) |
| L1 / R1 | Shift layer / Note-repeat (hold) |
| L2 / R2 (analog) | FX grab bus 1 / bus 2 (depth = pull amount) |
| L4 / R4 | Bank − / Bank + |
| L5 / R5 | Skip-back capture / Resample |
| Left stick | Navigate; click = tap tempo |
| Right stick | Active FX macro 1 (X) / macro 2 (Y); capacitive touch = vibrato |
| Right trackpad | XY FX pad; haptic metronome |
| Left trackpad | Crossfader (DJ) / scrub (tape & granular) |
| Gyro (while grab held) | D-Beam: tilt = assignable CC |
| View / Menu | Mixer / Mode switch (Instrument ⇄ Session ⇄ DJ) |

Everything remappable; ship 2–3 curated presets ("SP classic", "Finger drummer", "FX performer").

---

## 8. Suggested build order (instrument mode only)

1. **Audio engine spine** — voice allocator, per-pad params, master/bus graph, PipeWire I/O. *(everything depends on it)*
2. **Pads + playback modes + chop lab** (§2) — playable toy exists.
3. **Skip-back + resample** (§3.1, 3.3) — small, defines the identity early.
4. **Character FX v1** (§3.2): vinyl, cassette, bitcrush, filter+drive, delay, DJFX looper.
5. **Sequencer** (§3.4) with per-step param storage *designed for p-locks from day one* (§4.2–4.3). *(Needs the project tempo first.)*
6. **Punch-in FX + note repeat + gyro D-Beam** — the fun layer.
7. **Looper + mixer + FX automation** (§3.5, 3.7, 3.8).
8. **One flagship fringe feature** for launch identity — recommend **codec engine (§6.1)** or **ghost tape (§6.2)**.
9. Later waves: tape mode, tracker view, granular pad, stems, Link, beat-tape export.

Cut-line guidance: everything in §2–3 is the product; §4 is competitiveness; pick *two* items from §5–6 for launch and park the rest — fringe features are marketing gold but only after the core loop (record → chop → pads → pattern → resample) is frictionless.

---

## 9. Key references

- Klangfeld Labs DOOM OS — https://klangfeldlabs.com/doom-os/ and https://github.com/klangfeld-labs/doom-os (custom SP-404MK2 firmware: graphical sequencer, mixer, FX automation, shortcuts; v0.6-alpha, Sept 2026)
- Roland SP-404MKII — Sound On Sound review: https://www.soundonsound.com/reviews/roland-sp-404-mkii ; v4.04 firmware (Loop Capture, Koala integration, Multipad Export, Groove, Sound Generator): https://www.soundonsound.com/news/roland-update-sp-404-mkii-firmware ; v5.x Serato/DJ direction: https://www.musicradar.com/reviews/roland-sp-404-mkii
- SP lineage & culture — https://reverb.com/news/a-history-of-the-sp-404 ; SP-303 / Madlib / Dilla / DOOM: https://musictech.com/features/boss-sp-303-hip-hop-connection-j-dilla-madlib-mf-doom
- Useful libraries to evaluate: aubio (onset/BPM), Rubber Band (stretch), Ableton Link SDK (sync), Demucs (stems, offline), PipeWire capture APIs
