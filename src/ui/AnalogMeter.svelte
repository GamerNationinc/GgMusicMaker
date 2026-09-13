<script lang="ts">
  // Analogue-style master meter for the bottom-left corner: a VU dial with a
  // needle, a peak-hold tick, a PEAK lamp, and a spectrum strip. It reads the
  // mix *before* the limiter (see AudioEngine.preAnalyser), so the red zone
  // means "the limiter is having to work" and the lamp means "over full scale
  // before limiting" — i.e. this is where you look to see if you're peaking.
  import { masterMeter, masterSpectrum } from "../state/store";
  import { toDb, ballistics } from "../audio/spectrum";
  import { HEAD_WIDTH } from "./constants";

  const W = HEAD_WIDTH - 6; // sits flush under the LAYERS column
  const H = 118;
  const FACE_H = 84;
  const DB_MIN = -30;
  const DB_MAX = 6;
  const DB_RED = -3; // limiter threshold
  const SWEEP = 110; // degrees of needle travel
  // Real VU scales stretch the top end; without this -3/0/+3 pile up.
  const SCALE_GAMMA = 1.5;
  const PIVOT = { x: W / 2, y: FACE_H + 16 };
  const RADIUS = 78;
  const HOLD_MS = 1500;
  const LAMP_MS = 800;

  let canvas: HTMLCanvasElement;

  // Needle/lamp state lives outside the reactive system on purpose: it is
  // animation memory, not UI state, and must not retrigger the draw effect.
  let shownDb = DB_MIN;
  let holdDb = DB_MIN;
  let holdUntil = 0;
  let lampUntil = 0;
  let lampHot = false;

  function angleFor(db: number): number {
    const u = (Math.min(DB_MAX, Math.max(DB_MIN, db)) - DB_MIN) / (DB_MAX - DB_MIN);
    const t = Math.pow(u, SCALE_GAMMA);
    return ((t - 0.5) * SWEEP * Math.PI) / 180;
  }

  function polar(angle: number, r: number): [number, number] {
    return [PIVOT.x + Math.sin(angle) * r, PIVOT.y - Math.cos(angle) * r];
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

    // ---- face ------------------------------------------------------------
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#f1e3b6";
    ctx.fillRect(0, 0, W, FACE_H);
    // Bevel like the panels.
    ctx.fillStyle = "rgba(255,255,255,0.5)";
    ctx.fillRect(0, 0, W, 2);
    ctx.fillRect(0, 0, 2, FACE_H);
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.fillRect(0, FACE_H - 2, W, 2);
    ctx.fillRect(W - 2, 0, 2, FACE_H);

    // Red zone arc, then the black scale arc.
    ctx.lineWidth = 6;
    ctx.strokeStyle = "#d8322f";
    ctx.beginPath();
    ctx.arc(PIVOT.x, PIVOT.y, RADIUS, angleFor(DB_RED) - Math.PI / 2, angleFor(DB_MAX) - Math.PI / 2);
    ctx.stroke();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#1a1408";
    ctx.beginPath();
    ctx.arc(PIVOT.x, PIVOT.y, RADIUS, angleFor(DB_MIN) - Math.PI / 2, angleFor(DB_MAX) - Math.PI / 2);
    ctx.stroke();

    // Ticks + labels.
    ctx.font = "bold 9px 'Courier New', 'DejaVu Sans Mono', monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const db of [-30, -20, -10, -6, -3, 0, 3, 6]) {
      const a = angleFor(db);
      const major = db % 10 === 0 || db === -3 || db === 6;
      const [x0, y0] = polar(a, RADIUS - (major ? 8 : 5));
      const [x1, y1] = polar(a, RADIUS + 3);
      ctx.strokeStyle = db >= DB_RED ? "#d8322f" : "#1a1408";
      ctx.lineWidth = major ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
      if (major) {
        const [lx, ly] = polar(a, RADIUS - 17);
        ctx.fillStyle = db >= DB_RED ? "#b8231f" : "#1a1408";
        ctx.fillText(db > 0 ? `+${db}` : String(db), lx, ly);
      }
    }
    ctx.fillStyle = "#4a3d1e";
    ctx.font = "bold 11px 'Courier New', 'DejaVu Sans Mono', monospace";
    ctx.fillText("VU", PIVOT.x, FACE_H - 9);
    ctx.font = "8px 'Courier New', 'DejaVu Sans Mono', monospace";
    ctx.textAlign = "left";
    ctx.fillText("dBFS", 6, FACE_H - 8);
    ctx.textAlign = "center";

    // Peak-hold tick.
    if (holdDb > DB_MIN) {
      const a = angleFor(holdDb);
      const [x0, y0] = polar(a, RADIUS - 10);
      const [x1, y1] = polar(a, RADIUS + 4);
      ctx.strokeStyle = "#ff3ca0";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    }

    // Needle + hub.
    const na = angleFor(shownDb);
    const [nx, ny] = polar(na, RADIUS + 2);
    ctx.strokeStyle = "#111";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(PIVOT.x, PIVOT.y);
    ctx.lineTo(nx, ny);
    ctx.stroke();
    ctx.fillStyle = "#111";
    ctx.beginPath();
    ctx.arc(PIVOT.x, PIVOT.y, 7, 0, Math.PI * 2);
    ctx.fill();

    // PEAK lamp (top-right of the face).
    const lx = W - 16;
    const ly = 14;
    ctx.beginPath();
    ctx.arc(lx, ly, 6, 0, Math.PI * 2);
    if (lampOn) {
      ctx.fillStyle = lampHot ? "#ff2a2a" : "#ffb020";
      ctx.shadowColor = ctx.fillStyle;
      ctx.shadowBlur = 10;
      ctx.fill();
      ctx.shadowBlur = 0;
    } else {
      ctx.fillStyle = "#3a1414";
      ctx.fill();
    }
    ctx.strokeStyle = "#1a1408";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = "#4a3d1e";
    ctx.font = "bold 8px 'Courier New', 'DejaVu Sans Mono', monospace";
    ctx.fillText("PEAK", lx, ly + 13);

    // ---- spectrum strip --------------------------------------------------
    const top = FACE_H + 2;
    const sh = H - top;
    ctx.fillStyle = "#05130a";
    ctx.fillRect(0, top, W, sh);
    const n = bands.length;
    const gap = 2;
    const bw = (W - 4 - gap * (n - 1)) / n;
    for (let i = 0; i < n; i++) {
      const v = bands[i];
      const bh = Math.round(v * (sh - 6));
      const x = 2 + i * (bw + gap);
      ctx.fillStyle = v > 0.85 ? "#ff5b5b" : v > 0.65 ? "#ffcf3c" : "#5af096";
      ctx.fillRect(x, top + sh - 3 - bh, bw, bh);
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
    background: var(--panel-lo);
  }
</style>
