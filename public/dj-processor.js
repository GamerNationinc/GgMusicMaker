// DJ decks AudioWorklet — two turntable-style players (DJ mode). The web
// engine's twin of native/src/dj.rs, kept in step with it by
// src/audio/native-parity.test.ts; change both together.
//
// Each deck plays its track at a variable speed (tempo × sync, plus a jog
// nudge; a scratch sets the speed directly, backwards too) with 4-point
// Hermite interpolation — pitch follows speed, like vinyl. Then a 3-band EQ
// (low shelf 250 Hz, peak 1 kHz, high shelf 3 kHz; −60 dB = kill), the
// channel fader and the crossfader. No inputs; one stereo output → master.
//
// Port messages: { t: "load", deck, rate, channels: Float32Array[] | null }
// and the DjEvent shapes of src/audio/dj.ts. Positions go back as
// { t: "pos", pos: [a, b], playing: [a, b] } about every 20 ms.

const EQ_MIN_DB = -60;
const EQ_MAX_DB = 6;
const SPEED_TAU = 0.01;
const GAIN_TAU = 0.005;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function xfadeGains(x) {
  const a = ((clamp(x, -1, 1) + 1) * Math.PI) / 4;
  return [Math.min(1, Math.SQRT2 * Math.cos(a)), Math.min(1, Math.SQRT2 * Math.sin(a))];
}

/** Web Audio's biquad formulas (shelves S = 1), as native/src/dsp.rs. */
class Biquad {
  constructor() { this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0; this.z1 = 0; this.z2 = 0; }
  set(kind, freq, q, gainDb, sr) {
    const f = clamp(freq / (sr / 2), 0, 1);
    const w0 = Math.PI * f;
    const s = Math.sin(w0), c = Math.cos(w0);
    const a = Math.pow(10, gainDb / 40);
    let b0, b1, b2, a0, a1, a2;
    if (kind === "lowshelf" || kind === "highshelf") {
      const alpha = (s / 2) * Math.SQRT2;
      const k = 2 * Math.sqrt(a) * alpha;
      if (kind === "lowshelf") {
        b0 = a * (a + 1 - (a - 1) * c + k);
        b1 = 2 * a * (a - 1 - (a + 1) * c);
        b2 = a * (a + 1 - (a - 1) * c - k);
        a0 = a + 1 + (a - 1) * c + k;
        a1 = -2 * (a - 1 + (a + 1) * c);
        a2 = a + 1 + (a - 1) * c - k;
      } else {
        b0 = a * (a + 1 + (a - 1) * c + k);
        b1 = -2 * a * (a - 1 + (a + 1) * c);
        b2 = a * (a + 1 + (a - 1) * c - k);
        a0 = a + 1 - (a - 1) * c + k;
        a1 = 2 * (a - 1 - (a + 1) * c);
        a2 = a + 1 - (a - 1) * c - k;
      }
    } else {
      const alpha = s / (2 * q);
      b0 = 1 + alpha * a; b1 = -2 * c; b2 = 1 - alpha * a;
      a0 = 1 + alpha / a; a1 = -2 * c; a2 = 1 - alpha / a;
    }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
  }
  process(x) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}

function hermite(c, pos) {
  const fi = Math.floor(pos);
  const f = pos - fi;
  const n = c.length;
  const at = (k) => (k < 0 || k >= n ? 0 : c[k]);
  const xm1 = at(fi - 1), x0 = at(fi), x1 = at(fi + 1), x2 = at(fi + 2);
  const c1 = 0.5 * (x1 - xm1);
  const c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2;
  const c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
  return ((c3 * f + c2) * f + c1) * f + x0;
}

function newDeck() {
  return {
    buf: null, // { rate, channels }
    pos: 0, playing: false, rate: 1, nudge: 0, scratch: false, scratchSpeed: 0, speed: 0,
    loopFrom: 0, loopTo: 0,
    eqTarget: [0, 0, 0], eqNow: [NaN, NaN, NaN],
    eq: [[new Biquad(), new Biquad(), new Biquad()], [new Biquad(), new Biquad(), new Biquad()]],
    vol: 1, volNow: 1,
  };
}
const targetSpeed = (d) => (d.scratch ? d.scratchSpeed : d.playing ? d.rate + d.nudge : 0);
const deckLen = (d) => (d.buf ? d.buf.channels[0].length : 0);

function updateEq(d, sr) {
  for (let band = 0; band < 3; band++) {
    const t = d.eqTarget[band];
    const now = d.eqNow[band];
    const next = Number.isNaN(now) || Math.abs(t - now) < 0.01 ? t : now + (t - now) * 0.25;
    if (next === now) continue;
    d.eqNow[band] = next;
    for (let ch = 0; ch < 2; ch++) {
      const f = d.eq[ch][band];
      if (band === 0) f.set("lowshelf", 250, 0, next, sr);
      else if (band === 1) f.set("peaking", 1000, 0.7, next, sr);
      else f.set("highshelf", 3000, 0, next, sr);
    }
  }
}

class DjCore {
  constructor(sr) {
    this.sr = sr;
    this.decks = [newDeck(), newDeck()];
    this.xfade = 0;
    this.xfNow = xfadeGains(0);
    this.kSpeed = Math.exp(-1 / (sr * SPEED_TAU));
    this.kGain = Math.exp(-1 / (sr * GAIN_TAU));
  }
  load(deck, buf) {
    const d = this.decks[deck];
    if (!d) return;
    d.playing = false; d.scratch = false; d.speed = 0; d.pos = 0; d.loopFrom = 0; d.loopTo = 0;
    d.buf = buf;
  }
  event(e) {
    if (e.t === "xfade") { this.xfade = clamp(e.x, -1, 1); return; }
    const d = this.decks[e.deck];
    if (!d) return;
    const rate = d.buf ? d.buf.rate : 1;
    switch (e.t) {
      case "play": d.playing = e.on && !!d.buf; break;
      case "seek": d.pos = clamp(e.time * rate, 0, deckLen(d)); break;
      case "phase": {
        if (e.to === e.deck || !this.decks[e.to] || e.beat <= 0 || e.toBeat <= 0) break;
        const st = this.status().pos;
        const frac = (x) => x - Math.floor(x);
        let diff = frac((st[e.to] - e.toFirst) / e.toBeat) - frac((st[e.deck] - e.first) / e.beat);
        diff -= Math.round(diff);
        d.pos = clamp(d.pos + diff * e.beat * rate, 0, deckLen(d));
        break;
      }
      case "rate": d.rate = clamp(e.rate, 0, 4); break;
      case "nudge": d.nudge = clamp(e.amount, -1, 1); break;
      case "scratch": d.scratch = e.on; d.scratchSpeed = clamp(e.speed, -8, 8); break;
      case "eq": d.eqTarget = [e.low, e.mid, e.high].map((g) => clamp(g, EQ_MIN_DB, EQ_MAX_DB)); break;
      case "vol": d.vol = clamp(e.v, 0, 1); break;
      case "loop": d.loopFrom = Math.max(0, e.from * rate); d.loopTo = Math.min(deckLen(d), e.to * rate); break;
    }
  }
  status() {
    return {
      pos: this.decks.map((d) => (d.buf ? d.pos / d.buf.rate : 0)),
      playing: this.decks.map((d) => d.playing),
    };
  }
  /** Add both decks into ol / or. */
  render(ol, or) {
    const n = ol.length;
    const sr = this.sr;
    const xfTarget = xfadeGains(this.xfade);
    this.decks.forEach((d, k) => {
      const buf = d.buf;
      if (!buf) return;
      const target = targetSpeed(d);
      if (Math.abs(d.speed) <= 1e-9 && target === 0) {
        d.speed = 0;
        this.xfNow[k] = xfTarget[k];
        d.volNow = d.vol;
        return;
      }
      updateEq(d, sr);
      const ratio = buf.rate / sr;
      const len = buf.channels[0].length;
      const chL = buf.channels[0];
      const chR = buf.channels[Math.min(2, buf.channels.length) - 1];
      const looping = d.loopTo > d.loopFrom;
      const [eqL, eqR] = d.eq;
      for (let i = 0; i < n; i++) {
        d.speed = target + (d.speed - target) * this.kSpeed;
        d.volNow = d.vol + (d.volNow - d.vol) * this.kGain;
        this.xfNow[k] = xfTarget[k] + (this.xfNow[k] - xfTarget[k]) * this.kGain;
        let l = hermite(chL, d.pos), r = hermite(chR, d.pos);
        for (let b = 0; b < 3; b++) {
          l = eqL[b].process(l);
          r = eqR[b].process(r);
        }
        const g = d.volNow * this.xfNow[k];
        ol[i] += l * g;
        or[i] += r * g;
        d.pos += d.speed * ratio;
        if (looping && d.speed > 0 && d.pos >= d.loopTo) d.pos -= d.loopTo - d.loopFrom;
        if (d.pos >= len) { d.pos = len; d.playing = false; }
        else if (d.pos < 0) d.pos = 0;
      }
    });
  }
}

class DjProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.core = new DjCore(sampleRate);
    this.n = 0;
    this.lastReport = "";
    // (No port when the parity test runs this outside a worklet.)
    if (this.port) this.port.onmessage = (m) => {
      const e = m.data;
      if (e.t === "load") this.core.load(e.deck, e.channels ? { rate: e.rate, channels: e.channels } : null);
      else this.core.event(e);
    };
  }
  process(_inputs, outputs) {
    const out = outputs[0];
    const ol = out[0], or = out[1] || out[0];
    if (!this.tl || this.tl.length !== ol.length) {
      this.tl = new Float64Array(ol.length);
      this.tr = new Float64Array(ol.length);
    }
    const tl = this.tl, tr = this.tr;
    tl.fill(0);
    tr.fill(0);
    this.core.render(tl, tr);
    for (let i = 0; i < ol.length; i++) { ol[i] = tl[i]; if (or !== ol) or[i] = tr[i]; }
    // Positions back to the page about every 20 ms (only when they change).
    if (++this.n % 8 === 0) {
      const s = this.core.status();
      const key = `${s.pos[0]}|${s.pos[1]}|${s.playing}`;
      if (key !== this.lastReport && this.port) {
        this.lastReport = key;
        this.port.postMessage({ t: "pos", ...s });
      }
    }
    return true;
  }
}

registerProcessor("dj-processor", DjProcessor);
