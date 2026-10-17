// Weather simulation: named states are parameter vectors; the live weather is a
// smooth blend between them, with slow organic variation inside a state so the
// sky never loops. In auto mode states follow a Kerala-season Markov chain
// (south-west monsoon Jun–Sep, north-east "Thulavarsham" afternoon storms
// Oct–Nov, dry misty winter mornings, hazy pre-monsoon heat).

export const PARAMS = ['cover', 'cirrus', 'dark', 'rain', 'storm', 'fog', 'mist', 'wind', 'gust', 'haze', 'scud', 'soft'];

export const WEATHER = {
  clear:        { label: 'Clear',          cover: 0.06, cirrus: 0.4, dark: 0.0, rain: 0, storm: 0, fog: 0.0, mist: 0.0, wind: 0.55, gust: 0.3, haze: 0.18, scud: 0, soft: 0.22 },
  scattered:    { label: 'Scattered',      cover: 0.36, cirrus: 0.3, dark: 0.04, rain: 0, storm: 0, fog: 0.0, mist: 0.0, wind: 0.85, gust: 0.45, haze: 0.22, scud: 0, soft: 0.2 },
  overcast:     { label: 'Overcast',       cover: 0.9, cirrus: 0.0, dark: 0.38, rain: 0, storm: 0, fog: 0.12, mist: 0.0, wind: 1.05, gust: 0.5, haze: 0.5, scud: 0.25, soft: 0.34 },
  lightRain:    { label: 'Light rain',     cover: 0.95, cirrus: 0.0, dark: 0.5, rain: 0.32, storm: 0, fog: 0.22, mist: 0.1, wind: 1.25, gust: 0.6, haze: 0.62, scud: 0.45, soft: 0.38 },
  monsoon:      { label: 'Monsoon rain',   cover: 1.0, cirrus: 0.0, dark: 0.74, rain: 1.0, storm: 0.15, fog: 0.42, mist: 0.15, wind: 2.2, gust: 0.95, haze: 0.85, scud: 0.85, soft: 0.42 },
  thunderstorm: { label: 'Thunderstorm',   cover: 1.0, cirrus: 0.0, dark: 0.92, rain: 0.82, storm: 1.0, fog: 0.3, mist: 0.1, wind: 2.6, gust: 1.25, haze: 0.75, scud: 1.0, soft: 0.36 },
  fog:          { label: 'Fog',            cover: 0.55, cirrus: 0.0, dark: 0.12, rain: 0, storm: 0, fog: 1.0, mist: 0.7, wind: 0.22, gust: 0.15, haze: 1.0, scud: 0, soft: 0.45 },
  mist:         { label: 'Morning mist',   cover: 0.18, cirrus: 0.15, dark: 0.0, rain: 0, storm: 0, fog: 0.25, mist: 1.0, wind: 0.3, gust: 0.2, haze: 0.5, scud: 0, soft: 0.3 },
  clearing:     { label: 'Clearing',       cover: 0.48, cirrus: 0.2, dark: 0.16, rain: 0, storm: 0, fog: 0.06, mist: 0.35, wind: 1.0, gust: 0.55, haze: 0.32, scud: 0.15, soft: 0.24 },
};

const DURATION = { // game minutes [min, max]
  clear: [180, 420], scattered: [120, 300], overcast: [80, 220], lightRain: [40, 140], monsoon: [40, 120],
  thunderstorm: [30, 90], fog: [60, 150], mist: [50, 140], clearing: [45, 100],
};

function season(month) {
  if (month >= 6 && month <= 9) return 'sw';
  if (month >= 10 && month <= 11) return 'ne';
  if (month === 12 || month <= 3) return 'dry';
  return 'pre';
}

/** Weighted successors for a state given month & hour (local). */
function successors(cur, month, hour) {
  const s = season(month);
  const dawn = hour >= 2.5 && hour < 7.5 ? 1 : 0;
  const aft = hour >= 13 && hour < 21 ? 1 : 0;
  const morning = hour >= 6 && hour < 12 ? 1 : 0;
  const wet = s === 'sw' ? 2.2 : s === 'ne' ? 1.2 : s === 'pre' ? 0.8 : 0.35;
  const storms = (s === 'ne' || s === 'pre' ? 2.0 : s === 'sw' ? 0.7 : 0.15) * (aft ? 1.6 : morning ? 0.25 : 0.7);
  const W = {
    clear: { scattered: 3, mist: 2.2 * dawn, fog: s === 'dry' ? 1.2 * dawn : 0.15 * dawn, clear: 0.8 },
    scattered: { clear: 2 / wet, overcast: 1.6 * wet, thunderstorm: 0.8 * storms, scattered: 0.8, mist: 0.6 * dawn },
    overcast: { lightRain: 2.4 * wet, monsoon: s === 'sw' ? 1.6 : 0.2, scattered: 1.4 / wet, thunderstorm: 0.9 * storms, overcast: 0.5 },
    lightRain: { monsoon: s === 'sw' ? 2 : 0.5, overcast: 1.2, clearing: 2, lightRain: 0.6 },
    monsoon: { lightRain: 2, thunderstorm: 0.6 * storms + 0.3, clearing: 1.4, monsoon: 0.5 },
    thunderstorm: { monsoon: 1.1, lightRain: 1.4, clearing: 2.4 },
    fog: { mist: 1.6, scattered: 1.4, clear: 1 },
    mist: { clear: 2.2, scattered: 2.2, fog: 0.4 * dawn },
    clearing: { scattered: 2.6, clear: 1.4, mist: hour >= 20 || hour < 6 ? 1 : 0, overcast: 0.4 * wet },
  }[cur];
  return W;
}

export function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ease = (t) => t * t * (3 - 2 * t);
const vec = (type) => Object.fromEntries(PARAMS.map((k) => [k, WEATHER[type][k]]));

export class WeatherSim {
  constructor(initial = 'scattered', seed = (Date.now() & 0xffffff)) {
    this.rand = makeRng(seed);
    this.auto = true;
    this.state = initial;               // current target / settled state
    this.from = vec(initial);
    this.to = vec(initial);
    this.blend = vec(initial);
    this.k = 1;                          // transition progress
    this.transReal = 0;                  // >0: manual transition length in real seconds
    this.transGame = 60;                 // auto transition length in game minutes
    this.remaining = 140;                // game minutes left in the current state
    this.overrides = { cover: null, rain: null, fog: null, wind: null, storm: null };
    this.out = vec(initial);             // final smoothed parameters
    this.wet = 0;                        // surface wetness 0..1
    this.puddle = 0;                     // standing water 0..1
    this.clock = this.rand() * 1000;     // drives in-state variation
  }

  /** Start a smooth transition to `type` (manual: over `seconds` real seconds). */
  set(type, seconds = 12) {
    if (!WEATHER[type]) return;
    this.from = { ...this.blend };
    this.to = vec(type);
    this.state = type;
    this.k = 0;
    this.transReal = Math.max(0.5, seconds);
    const [a, b] = DURATION[type];
    this.remaining = a + this.rand() * (b - a);
  }

  pickNext(month, hour) {
    const W = successors(this.state, month, hour);
    let tot = 0;
    for (const v of Object.values(W)) tot += Math.max(0, v);
    let x = this.rand() * tot;
    for (const [k, v] of Object.entries(W)) { x -= Math.max(0, v); if (x <= 0) return k; }
    return 'scattered';
  }

  /** Progress label for the dev panel. */
  describe() {
    const lbl = WEATHER[this.state].label;
    return this.k < 1 ? `→ ${lbl} ${Math.round(this.k * 100)}%` : lbl;
  }

  update(dtReal, dtGameMin, { month, hour, sunUp }) {
    // ---- state machine
    if (this.auto && dtGameMin > 0 && this.k >= 1) {
      this.remaining -= dtGameMin;
      if (this.remaining <= 0) {
        const next = this.pickNext(month, hour);
        this.from = { ...this.blend };
        this.to = vec(next);
        this.state = next;
        this.k = 0;
        this.transReal = 0;
        this.transGame = 25 + this.rand() * 40;
        const [a, b] = DURATION[next];
        this.remaining = a + this.rand() * (b - a);
      }
    }
    if (this.k < 1) {
      this.k = Math.min(1, this.k + (this.transReal > 0 ? dtReal / this.transReal : dtGameMin / this.transGame));
      const e = ease(this.k);
      // rain lags cloud build-up on the way in and clears first on the way out
      for (const p of PARAMS) {
        let ep = e;
        if (p === 'rain' || p === 'storm') ep = this.to[p] > this.from[p] ? ease(Math.max(0, (this.k - 0.35) / 0.65)) : ease(Math.min(1, this.k / 0.6));
        if (p === 'cover' || p === 'dark') ep = this.to[p] > this.from[p] ? ease(Math.min(1, this.k / 0.75)) : ease(Math.max(0, (this.k - 0.2) / 0.8));
        this.blend[p] = this.from[p] + (this.to[p] - this.from[p]) * ep;
      }
    }

    // ---- organic variation inside a state (incommensurate slow waves: never quite repeats)
    this.clock += Math.max(dtGameMin, dtReal * 0.25);
    const c = this.clock;
    const n1 = Math.sin(c * 0.071) * 0.6 + Math.sin(c * 0.193 + 1.3) * 0.4;
    const n2 = Math.sin(c * 0.37 + 0.4) * 0.5 + Math.sin(c * 0.91 + 2.1) * 0.3 + Math.sin(c * 2.3) * 0.2;
    const n3 = Math.sin(c * 0.53 + 3.1) * 0.6 + Math.sin(c * 1.7 + 0.7) * 0.4;
    const target = { ...this.blend };
    target.cover = Math.min(1, Math.max(0, target.cover + 0.07 * n1 * (1 - target.cover) * (target.cover > 0.04 ? 1 : 0)));
    target.rain *= 0.78 + 0.32 * (n2 * 0.5 + 0.5);             // bursts of heavier rain
    target.wind *= 0.85 + 0.3 * (n3 * 0.5 + 0.5);

    // ---- developer overrides
    const o = this.overrides;
    if (o.cover !== null) target.cover = o.cover;
    if (o.rain !== null) { target.rain = o.rain; target.cover = Math.max(target.cover, 0.75 + 0.25 * o.rain); target.dark = Math.max(target.dark, 0.35 + 0.45 * o.rain); target.scud = Math.max(target.scud, o.rain * 0.8); }
    if (o.fog !== null) { target.fog = o.fog; target.haze = Math.max(target.haze, o.fog); target.mist = Math.max(target.mist, o.fog * 0.6); }
    if (o.wind !== null) { target.wind = o.wind; target.gust = 0.25 + o.wind * 0.35; }
    if (o.storm !== null) { target.storm = o.storm; target.dark = Math.max(target.dark, o.storm * 0.9); target.cover = Math.max(target.cover, 0.7 + 0.3 * o.storm); target.scud = Math.max(target.scud, o.storm); }

    const a = 1 - Math.exp(-dtReal * 1.6);
    for (const p of PARAMS) this.out[p] += (target[p] - this.out[p]) * a;
    this.sunUp = sunUp;
    return this.out;
  }

  /** Surfaces: wet within minutes of rain; puddles need sustained rain and dry slower. */
  soak(W, dtReal, dtGameMin) {
    const dt = Math.max(dtGameMin, dtReal * 2);
    const r = W.rain;
    if (r > 0.04) {
      this.wet = Math.min(1, this.wet + dt * (0.04 + r * 0.12));
      this.puddle = Math.min(1, this.puddle + dt * r * 0.018);
    } else {
      const dry = (0.25 + (this.sunUp ? 0.6 * (1 - W.cover) : 0) + 0.15 * W.wind) * dt;
      this.wet = Math.max(0, this.wet - dry / 55);
      this.puddle = Math.max(0, this.puddle - dry / 140);
    }
  }
}
