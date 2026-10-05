# Steam Deck dual mode — Instrument / DJ

The Deck is either an **Instrument** or a **DJ mix table**, in two switchable
modes, alongside the normal editor (**Studio**). Controller first; no extra
hardware needed. (A dock with a real turntable/jog controller that takes over
the trackpads' role is a later extra.)

Status: **milestone 1 (controller foundation + Instrument mode) done
2026-09-30.** DJ mode, the library/bulk import and the album view are next.

## Decisions (CEOGG, 2026-09-30)

| Open question | Decision |
|---|---|
| Mode switching: button combo or menu/overlay? | **Both.** View + Menu together cycles Studio ↔ Instrument from anywhere; a STUDIO / INSTRUMENT / DJ switch sits in the header for touch and mouse. |
| One audio engine or two? | **Shared.** The live instrument (and later the DJ decks) runs inside the existing engine — native Rust mixer and its web twin — so it gets the master bus, reverb, limiter, meters and every future effect. |
| Gyro in DJ mode? | Off by default (spec default). In Instrument mode tilt bends pitch only while R5 is held. |
| Can a track be in several albums / sets? | **Yes — shared.** The library holds each track once; albums and DJ sets are ordered lists that point at library tracks (the "album = set" note below). |
| What first? | **Controller foundation**: raw Deck input incl. trackpads, back buttons and IMU; mode switch; Instrument mode making sound. |

## How the Deck is read

Chromium's Gamepad API only sees what Steam Input emits (sticks, ABXY,
bumpers, triggers). The trackpads, their pressure, L4/R4/L5/R5 and the IMU
are only in the controller's own 64-byte state report (type `0x09`, 250 Hz)
on the vendor interface (`28DE:1205`, USB interface 2). udev gives the seat
user an ACL on that hidraw node, and it can be read **while Steam is
running** — measured: 251 reports/s alongside Steam.

- `native/src/deckpad.rs` — `DeckPad`: finds the node, a reader thread keeps
  the newest report, `feature()` sends feature reports (HIDIOCSFEATURE).
- `electron/deckpad.cjs` — polls every 4 ms, forwards to the page. Studio
  mode asks for *buttons* detail (a report only when a button changes — 0
  messages/s at rest); Instrument mode takes every report (≈ 232/s measured
  in the app). Reopens after unplug/suspend. `GGMM_DECKPAD=off|fake`.
- `src/input/deckpad.ts` — parse (and build, for tests) the report; the
  Gamepad API fallback maps into the same `ControllerState`.
- `src/input/controller.ts` — the loop: mode switching, Instrument mode,
  haptics, the UI store.

Steam's desktop layout still turns the same controls into mouse and keys
(right pad = cursor, R2 = left click, A = Enter…). While the Deck performs,
the app ignores keys and mouse clicks; the touchscreen keeps working. A Steam
Input layout for the app with everything set to "none"/gamepad would remove
the emulation at the source (see "Open" below).

## Control mapping

| Control | Instrument mode (built) | DJ mix table mode (next) |
|---|---|---|
| Trackpads | **Right**: scale-locked note grid — columns = scale steps, 3 rows = 3 octaves; touch plays, slide moves step by step with a haptic tick, lift releases (keys/pluck retrigger, pad/bass glide). **Left**: X/Y macro — X filter cutoff, Y reverb send (stays where the thumb left it). | Left/right jog wheels — touch position + velocity for scratch feel |
| Sticks | **Left** Y = pitch bend ±2 st (springs back). **Right** up = mod wheel (vibrato). | Per-deck 3-band EQ (2D stick position = low/mid/high), click = kill |
| Face buttons (ABXY) | Bank A: kick / snare / hat / clap. **Hold L1 or R1**: bank B = the I, IV, V, vi chords of the key, held while pressed. | Loop in/out, sync, sampler triggers |
| Bumpers (L1/R1) | Bank shift for the pads | Cue / play per deck |
| Triggers (L2/R2) | **R2** expression (swell 0.7 → 1). **L2** velocity of the ABXY pads. | Analog crossfader blend |
| Back buttons | **L4 / R4** octave down / up. **L5** sustain (hold). **R5** hold = tilt bend (see gyro). | 4 hot cues |
| D-pad | ←/→ key down/up a semitone, ↑/↓ next/previous scale *(the spec had scale/key on a back button; R5 went to the tilt arm instead)* | — |
| L3 | Next sound: keys, pluck, pad, bass | — |
| View + Menu | Mode switch (all modes) | Mode switch |
| Gyro | Hold R5: rolling the Deck (steering-wheel tilt) bends pitch, ±2 st at 30°, relative to where it was when R5 went down (read from the accelerometer). | Off by default |
| Touchscreen | The same instrument on screen: tap/hold grid cells and pads, key/scale/octave/sound buttons. | Waveforms, deck overview, effects rack |

Scales: major, minor, dorian, major pentatonic, minor pentatonic, blues.
Chords come from the 7-note parent scale (major for major pentatonic, natural
minor for the other two).

## The live instrument

`native/src/live.rs` (native) and `public/live-processor.js` (web), kept in
step by `src/audio/native-parity.test.ts` (a scripted performance: notes,
chords, all four drums, bend, mod, sustain, glide — < 0.1 % apart). 16
voices (oldest stolen): two PolyBLEP oscillators (saw/square blend, detuned)
→ TPT state-variable lowpass (cutoff macro, opened by the envelope) → ADSR;
drums synthesised. Events (`src/audio/live.ts`) apply at the next 128-frame
quantum. Output joins the bus before the reverb return, with its own send,
so it goes through the master level, limiter and meters and plays whether or
not the transport runs. Nothing sounding costs nothing.

## Verified

- Rust: 6 unit tests (`live.rs`: silent until played, release to silence,
  sustain holds until lifted, voice stealing, drums end, send follows macro).
- Parity: the performance above, JS vs Rust.
- `src/input/deckpad.test.ts` (6): report values read off this Deck; every
  button in both 32-bit words; pads/sticks/triggers/pressure; Gamepad API
  mapping; haptic report encoding.
- `src/input/instrument.test.ts` (10): grid ↔ notes for every scale, chords,
  touch/slide/lift, glide for sustained sounds, drums + held chords,
  settings, ctl only on change, tilt only while armed, release-all.
- `npm run test:instrument` (18 checks): the real Electron app with injected
  Deck reports — View + Menu enters and leaves, a thumb on the right pad
  sounds on the native engine's meters and lights the right cell, sliding
  moves a step, lifting releases (−39 dB after 1.5 s, reverb tail), A = kick,
  L1 + Y = Am chord and release, R4 / d-pad settings, a mouse click (Steam's
  R2 emulation) plays nothing while a touch does, Studio ignores the pads.
- Real hardware smoke test: the app opened `/dev/hidraw3`, 0 reports/s idle
  in Studio, ≈ 232/s in Instrument, a haptic feature report was accepted.

## Open

- **Not yet played by a person on the Deck.** Button bits come from the
  kernel's hid-steam / SDL layouts and round-trip in tests; only the idle
  report was checked against hardware. First thing to do: press everything.
- **Haptics are unconfirmed by feel.** The pulse report (`0x8f`, as hid-steam
  sends it) is accepted by the controller; whether the tick is felt, and how
  strong, needs a thumb.
- Pad pressure is read but unused (could be velocity / aftertouch).
- Gaming Mode not tried: there the app gets Steam's virtual gamepad as well
  (ignored while the raw Deck is active) and the right pad still moves a
  cursor by default. Shipping a Steam Input layout (all "none") for the app
  would make both modes clean.
- Only the native engine's live path is exercised in the app test; the web
  engine's (AudioWorkletNode → master + reverb) is covered by parity only.
- Playing is recorded as **audio** (2026-10-05: Menu = record, View = play,
  see MASTER.md §2). Recording it as editable notes (a piano roll) is the
  natural next step.

## Next milestones

### DJ mix table mode
Two decks as special tracks on the shared engine: jog on the trackpads, EQ
on the sticks, crossfader on the triggers, cue/play on the bumpers, loops,
sync, sampler, hot cues on the back buttons; waveforms on the screen.

### Bulk track addition (Virtual DJ–style)
- Drag-and-drop a whole folder or multi-select files onto the library pane.
- Background analysis queue: BPM, key (Camelot wheel), waveform pre-render,
  gain normalisation — async, so 500 tracks don't freeze the UI.
- Auto-tag from ID3/Vorbis; prompt only for files missing artist/title.
- Duplicate detection (hash or fuzzy artist/title), so re-dragging a folder
  doesn't double the library.
- Visible import progress / queue view.

### Album-level workflow
One two-level zoom model, not two screens:
- **Album view**: ordered tracklist (drag to reorder), shared metadata (art,
  artist, release info), album-wide master bus (one loudness target).
- **Song view**: click a track for the normal multitrack editor; breadcrumb
  ("Album > Track 3") and next/prev track without leaving the album.
- Album operations: crossfade between track endings, key/BPM consistency
  check, batch export. Song operations: everything in the editor.

An album and a DJ set are the same object — an ordered list of library
tracks plus transition points — so the album model gives DJ playlists for
free. Tracks can belong to many albums/sets (decided above).
