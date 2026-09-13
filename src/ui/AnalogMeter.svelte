<script lang="ts">
  // Analogue master meter, rendered as ASCII art: a "digital" drawing of an
  // analogue VU. The dial arc, ticks and needle are rasterised onto a
  // character grid (glyph chosen by local slope), the spectrum uses block
  // glyphs, and every lit glyph is drawn twice — a dark copy offset down-right
  // first — so the face reads as slightly extruded, Doom-status-bar style.
  //
  // It reads the mix *before* the limiter (see AudioEngine.preAnalyser): the
  // red zone means "the limiter is having to work" and the lamp means "over
  // full scale before limiting" — this is where you look to see if you're
  // peaking.
  import { masterMeter, masterSpectrum } from "../state/store";
  import { toDb, ballistics } from "../audio/spectrum";
  import { HEAD_WIDTH } from "./constants";

  const W = HEAD_WIDTH - 6; // sits flush under the LAYERS column
  const H = 118;
  const CW = 5; // character cell width  (px)
  const CH = 7; // character cell height (px)
  const COLS = Math.floor(W / CW); // 42
  const ROWS = Math.floor(H / CH); // 16
  const FACE_ROWS = 11; // dial occupies rows 0..10, spectrum the rest
  const DB_MIN = -30;
  const DB_MAX = 6;
  const DB_RED = -3; // limiter threshold
  const SWEEP = 140; // degrees of needle travel — wide and flat, like a real VU
  const SCALE_GAMMA = 1.5; // real VU scales stretch the top end
  const PIVOT = { x: COLS / 2, y: FACE_ROWS + 0.5 }; // in cells; just under the face
  const RADIUS = 8.5; // in rows; x is scaled by CH/CW to stay circular
  const LABEL_R = 10.5; // labels sit outside the arc where there is room
  const HOLD_MS = 1500;
  const LAMP_MS = 800;

  const GREEN = "#37e07a";
  const GREEN_DIM = "#1c7a44";
  const GREEN_HI = "#b8ffd0";
  const RED = "#ff4a4a";
  const AMBER = "#ffb020";
  const MAGENTA = "#ff3ca0";
  const SHADOW = "#04160b";
  const FONT = "bold 8px 'Courier New', 'DejaVu Sans Mono', monospace";

  let canvas: HTMLCanvasElement;

  // Animation memory, deliberately outside the reactive system.
  let shownDb = DB_MIN;
  let holdDb = DB_MIN;
  let holdUntil = 0;
  let lampUntil = 0;
  let lampHot = false;

  // Character grid: one glyph + colour per cell, rebuilt every frame.
  const chars: string[] = new Array(COLS * ROWS).fill(" ");
  const colors: string[] = new Array(COLS * ROWS).fill(GREEN);

  function put(col: number, row: number, ch: string, color: string) {
    col = Math.round(col);
    row = Math.round(row);
    if (col < 0 || row < 0 || col >= COLS || row >= ROWS) return;
    chars[row * COLS + col] = ch;
    colors[row * COLS + col] = color;
  }

  function text(col: number, row: number, s: string, color: string) {
    for (let i = 0; i < s.length; i++) put(col + i, row, s[i], color);
  }

  function angleFor(db: number): number {
    const u = (Math.min(DB_MAX, Math.max(DB_MIN, db)) - DB_MIN) / (DB_MAX - DB_MIN);
    const t = Math.pow(u, SCALE_GAMMA);
    return ((t - 0.5) * SWEEP * Math.PI) / 180;
  }

  /** Cell coordinates of a point on the dial, `r` in rows from the pivot. */
  function polar(angle: number, r: number): [number, number] {
    return [PIVOT.x + (Math.sin(angle) * r * CH) / CW, PIVOT.y - Math.cos(angle) * r];
  }

  /** Glyph for a line segment by its direction in *pixel* space. */
  function slopeGlyph(dx: number, dy: number): string {
    const a = Math.atan2(dy * CH, dx * CW); // pixel-space angle
    const deg = ((a * 180) / Math.PI + 180) % 180;
    if (deg < 22 || deg >= 158) return "-";
    if (deg < 68) return "\\";
    if (deg < 112) return "|";
    return "/";
  }

  function line(x0: number, y0: number, x1: number, y1: number, color: string, glyph?: string) {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) * 2 + 1;
    const g = glyph ?? slopeGlyph(x1 - x0, y1 - y0);
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      put(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, g, color);
    }
  }

  function draw(peak: number, reduction: number, bands: Float32Array) {
    if (!canvas) return;
    const now = performance.now();
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== W * dpr) {
      canvas.width = W * dpr;
      canvas.height = H * dpr;
    }
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // ---- ballistics ------------------------------------------------------
    const peakDb = toDb(peak, DB_MIN);
    shownDb = ballistics(shownDb, peakDb);
    if (peakDb >= holdDb || now > holdUntil) {
      holdDb = peakDb;
      holdUntil = now + HOLD_MS;
    }
    const limiting = reduction < -0.5 || peakDb >= DB_RED;
    const clipping = peakDb >= 0;
    if (clipping || limiting) {
      lampUntil = now + LAMP_MS;
      lampHot = clipping || (lampHot && now < lampUntil);
    }
    const lampOn = now < lampUntil;

    // ---- build the character grid ---------------------------------------
    chars.fill(" ");

    // Dial arc, one glyph per cell along it, red past the limiter threshold.
    const a0 = angleFor(DB_MIN);
    const a1 = angleFor(DB_MAX);
    const arcSteps = 90;
    for (let i = 0; i <= arcSteps; i++) {
      const a = a0 + ((a1 - a0) * i) / arcSteps;
      const [x, y] = polar(a, RADIUS);
      const db = DB_MIN + ((DB_MAX - DB_MIN) * i) / arcSteps; // only for colour
      const g = slopeGlyph(Math.cos(a), Math.sin(a)); // tangent direction
      put(x, y, g, db >= DB_RED - 1.5 ? RED : GREEN_DIM);
    }
    // Ticks on the arc, labels outside it.
    for (const db of [-30, -20, -10, -3, 0, 6]) {
      const a = angleFor(db);
      const [tx, ty] = polar(a, RADIUS);
      put(tx, ty, "+", db >= DB_RED ? RED : GREEN);
      const [lx, ly] = polar(a, LABEL_R);
      const s = db > 0 ? `+${db}` : String(db);
      text(lx - s.length / 2 + 0.5, ly, s, db >= DB_RED ? RED : GREEN);
    }
    text(1, 0, "dBFS", GREEN_DIM);
    text(COLS - 3, FACE_ROWS - 1, "VU", GREEN);

    // Peak-hold marker between the arc and the labels.
    if (holdDb > DB_MIN) {
      const [hx, hy] = polar(angleFor(holdDb), RADIUS + 1);
      put(hx, hy, "*", MAGENTA);
    }

    // Needle: from the hub at the face bottom up to the arc.
    const na = angleFor(shownDb);
    const [nx, ny] = polar(na, RADIUS - 0.6);
    const [bx, by] = polar(na, 1.6);
    line(bx, by, nx, ny, GREEN_HI);
    put(bx, by, "@", GREEN_HI);

    // PEAK lamp, bottom-left of the face.
    const lampColor = lampOn ? (lampHot ? RED : AMBER) : GREEN_DIM;
    text(1, FACE_ROWS - 1, lampOn ? "(o) PEAK" : "( ) PEAK", lampColor);

    // Spectrum strip: two glyph columns per band, eighth-block glyphs.
    const blocks = " ▁▂▃▄▅▆▇█";
    const specRows = ROWS - FACE_ROWS - 1;
    const n = bands.length;
    const perBand = Math.max(1, Math.floor((COLS - 2) / n));
    for (let b = 0; b < n; b++) {
      const v = bands[b];
      const color = v > 0.85 ? RED : v > 0.65 ? AMBER : GREEN;
      const total = v * specRows; // in rows
      for (let r = 0; r < specRows; r++) {
        const fill = Math.min(1, Math.max(0, total - r));
        const g = blocks[Math.round(fill * 8)];
        if (g === " ") continue;
        const row = ROWS - 1 - r;
        for (let k = 0; k < perBand - 1; k++) put(1 + b * perBand + k, row, g, color);
      }
    }
    // Divider between dial and spectrum.
    for (let c = 0; c < COLS; c++) put(c, FACE_ROWS, "─", GREEN_DIM);

    // ---- paint ------------------------------------------------------------
    ctx.fillStyle = "#020a05";
    ctx.fillRect(0, 0, W, H);
    // faint CRT scanlines
    ctx.fillStyle = "rgba(0,0,0,0.25)";
    for (let y = 0; y < H; y += 2) ctx.fillRect(0, y, W, 1);
    ctx.font = FONT;
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    // Pass 1: shadow copy, offset down-right — the cheap 2.5D extrusion.
    ctx.fillStyle = SHADOW;
    for (let i = 0; i < chars.length; i++) {
      if (chars[i] === " ") continue;
      ctx.fillText(chars[i], (i % COLS) * CW + 1.5, Math.floor(i / COLS) * CH + 1.5);
    }
    // Pass 2: the lit glyphs.
    for (let i = 0; i < chars.length; i++) {
      if (chars[i] === " ") continue;
      ctx.fillStyle = colors[i];
      ctx.fillText(chars[i], (i % COLS) * CW, Math.floor(i / COLS) * CH);
    }
  }

  $effect(() => {
    draw($masterMeter.peak, $masterMeter.reduction, $masterSpectrum);
  });
</script>

<canvas
  bind:this={canvas}
  class="meter"
  style:width="{W}px"
  style:height="{H}px"
  title="Master level before the limiter. Red zone = limiter working, PEAK = over full scale."
  aria-label="Analogue master meter"
></canvas>

<style>
  .meter {
    flex: 0 0 auto;
    border: 2px solid var(--bevel-dark);
    background: #020a05;
    box-shadow: 0 0 12px rgba(55, 224, 122, 0.15) inset;
  }
</style>
