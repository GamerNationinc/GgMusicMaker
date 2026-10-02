// The GG loader's frames: plain text, built fresh each tick from a frame
// counter — a scrolling waveform on a tape window, spinning cassette reels,
// bouncing EQ bars, a typed-out label and a progress bar. Pure (no DOM), so
// it's unit-tested and costs a few microseconds a frame.

export const LOADER_COLS = 52;

const LOGO = [
  " ▄█████▄  ▄█████▄ ",
  " ██       ██      ",
  " ██  ▀██▌ ██  ▀██▌",
  " ▀██████▀ ▀██████▀",
];
const WAVE_CHARS = " ▁▂▃▄▅▆▇█";
const REEL = ["◐", "◓", "◑", "◒"];

/** Little lies to read while you wait. */
export const QUIPS = [
  "tuning the 808s",
  "untangling patch cables",
  "warming up the tubes",
  "counting in: 1, 2, 3, 4",
  "aligning the tape heads",
  "feeding the subwoofer",
  "dusting off the faders",
  "asking the kick to be louder",
  "sidechaining the coffee",
  "GG, no re",
];

/** The waveform scrolling through the tape window: a "song" of kicks and
 *  a bassline, sampled per column. */
export function waveAt(x: number): number {
  const beat = ((x % 16) + 16) % 16;
  const kick = Math.exp(-beat * 0.55);
  const bass = 0.35 + 0.25 * Math.sin(x * 0.39) * Math.sin(x * 0.07);
  const hat = beat % 4 === 2 ? 0.25 : 0;
  return Math.min(1, Math.max(0, 0.9 * kick + Math.abs(bass) * 0.6 + hat));
}

function waveStrip(width: number, offset: number): string {
  let s = "";
  for (let i = 0; i < width; i++) s += WAVE_CHARS[Math.round(waveAt(i + offset) * (WAVE_CHARS.length - 1))];
  return s;
}

/** EQ bar heights 0..6 (three rows of half blocks), wobbling with `t`. */
export function eqLevels(t: number, n = 9): number[] {
  return Array.from({ length: n }, (_, k) => {
    const v = (Math.sin(t * 0.55 + k * 1.3) + Math.sin(t * 0.21 + k * 0.7) + 2) / 4;
    const kick = t % 8 < 2 && k < 3 ? 0.35 : 0;
    return Math.max(0, Math.min(6, Math.round((v + kick) * 6)));
  });
}

function eqRow(levels: number[], row: number): string {
  // row 0 = top. Each row is 2 half-steps: full █, half ▄, empty.
  const base = (2 - row) * 2;
  return levels.map((h) => (h >= base + 2 ? "█" : h === base + 1 ? "▄" : " ")).join(" ");
}

function bar(width: number, progress: number | null, t: number): string {
  if (progress !== null) {
    const full = Math.round(progress * width);
    return "█".repeat(full) + "░".repeat(width - full);
  }
  // Unknown length: a block bouncing along the bar.
  const w = 5, span = width - w;
  const p = t % (2 * span);
  const at = p < span ? p : 2 * span - p;
  return "░".repeat(at) + "▓".repeat(w) + "░".repeat(span - at);
}

const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length));

export interface FrameInput {
  /** Frame counter (~11 a second). */
  t: number;
  label: string;
  detail: string;
  progress: number | null;
  /** Frames since the label changed (the typewriter). */
  sinceLabel: number;
}

/** One frame of the loader, as lines of exactly LOADER_COLS characters. */
export function loaderFrame(f: FrameInput): string[] {
  const W = LOADER_COLS;
  const inner = W - 4;
  const reel = REEL[f.t % REEL.length];
  const reel2 = REEL[(f.t + 2) % REEL.length];
  const tapeW = inner - LOGO[0].length - 4;
  const right = [
    "┌" + "─".repeat(tapeW) + "┐",
    "│" + waveStrip(tapeW, f.t) + "│",
    "└" + "─".repeat(tapeW) + "┘",
    pad(`  (${reel})${"═".repeat(Math.max(0, tapeW - 8))}(${reel2})`, tapeW + 2),
  ];
  const typed = f.label.slice(0, Math.min(f.label.length, f.sinceLabel * 2));
  const cursor = f.t % 8 < 4 ? "█" : " ";
  const levels = eqLevels(f.t);
  const quip = QUIPS[Math.floor(f.t / 28) % QUIPS.length];
  const pct = f.progress === null ? "" : ` ${String(Math.round(f.progress * 100)).padStart(3)}%`;
  const barW = inner - 2 - pct.length;
  const eqW = levels.length * 2 - 1;
  const textW = inner - eqW - 3;

  const body = [
    "",
    ...LOGO.map((l, i) => l + "  " + right[i]),
    "   M  U  S  I  C     M  A  K  E  R",
    "",
    eqRow(levels, 0) + "   " + pad(typed + cursor, textW),
    eqRow(levels, 1) + "   " + pad(f.detail, textW),
    eqRow(levels, 2) + "   " + pad(`» ${quip}${".".repeat((f.t >> 2) % 4)}`, textW),
    "",
    "[" + bar(barW, f.progress, f.t) + "]" + pct,
    "",
  ];
  return [
    "╔" + "═".repeat(W - 2) + "╗",
    ...body.map((l) => "║ " + pad(l, inner) + " ║"),
    "╚" + "═".repeat(W - 2) + "╝",
  ];
}
