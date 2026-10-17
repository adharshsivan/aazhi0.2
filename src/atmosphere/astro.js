// Low-precision solar & lunar ephemeris for Kochi (good to a fraction of a
// degree, plenty for a sky): positions follow the real calendar, so sunrise
// times shift with the season and the moon rises ~50 min later each night,
// waxing and waning through its true phases.
//
// World axes: +x east, +z south, +y up.

const RAD = Math.PI / 180;
const TAU = Math.PI * 2;
export const SITE = { lat: 9.93, lon: 76.27, tz: 5.5, name: 'Kochi' };
export const SYNODIC = 29.530589;

export const julian = (ms) => ms / 86400000 + 2440587.5;
const wrap = (a) => ((a % TAU) + TAU) % TAU;

function sunEcliptic(d) {
  const g = (357.529 + 0.98560028 * d) * RAD;
  const q = 280.459 + 0.98564736 * d;
  return (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD;
}
function eclipticToEquatorial(lambda, beta, d) {
  const e = (23.439 - 0.00000036 * d) * RAD;
  const ra = Math.atan2(Math.sin(lambda) * Math.cos(e) - Math.tan(beta) * Math.sin(e), Math.cos(lambda));
  const dec = Math.asin(Math.sin(beta) * Math.cos(e) + Math.cos(beta) * Math.sin(e) * Math.sin(lambda));
  return { ra, dec };
}
function moonEcliptic(d) {
  const L = (218.316 + 13.176396 * d) * RAD;
  const M = (134.963 + 13.064993 * d) * RAD;
  const F = (93.272 + 13.22935 * d) * RAD;
  const D = (297.85 + 12.190749 * d) * RAD;
  const Ms = (357.529 + 0.98560028 * d) * RAD;
  // main periodic terms (equation of centre, evection, variation, annual equation)
  const lambda = L + RAD * (6.289 * Math.sin(M) + 1.274 * Math.sin(2 * D - M) + 0.658 * Math.sin(2 * D) - 0.186 * Math.sin(Ms));
  const beta = RAD * 5.128 * Math.sin(F);
  return { lambda, beta };
}
const lst = (d, lon) => wrap((280.16 + 360.9856235 * d) * RAD + lon * RAD);

/** Unit world vector for equatorial (ra, dec) at local sidereal angle `s`. */
function eqToWorld(ra, dec, s, lat, out = [0, 0, 0]) {
  const H = s - ra, phi = lat * RAD;
  const alt = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
  // azimuth from south towards west, then turned to "from north, clockwise"
  const azS = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi));
  const A = azS + Math.PI;
  out[0] = Math.sin(A) * Math.cos(alt); out[1] = Math.sin(alt); out[2] = -Math.cos(A) * Math.cos(alt);
  return out;
}

/**
 * Full sky state for a UTC instant. `moonShiftDays` lets developers dial a
 * different lunar age while keeping the moon's motion and terminator consistent.
 */
export function skyState(ms, moonShiftDays = 0, site = SITE) {
  const jd = julian(ms), d = jd - 2451545.0;
  const s = lst(d, site.lon);
  const ls = sunEcliptic(d);
  const se = eclipticToEquatorial(ls, 0, d);
  const sun = eqToWorld(se.ra, se.dec, s, site.lat);
  const dm = d + moonShiftDays;
  const mEc = moonEcliptic(dm);
  const me = eclipticToEquatorial(mEc.lambda, mEc.beta, dm);
  const moon = eqToWorld(me.ra, me.dec, s, site.lat);
  const elong = wrap(mEc.lambda - ls);
  const illum = (1 - Math.cos(elong) * Math.cos(mEc.beta)) / 2;
  const age = (elong / TAU) * SYNODIC;
  // equatorial basis -> world (rotates the star field with sidereal time)
  const ex = eqToWorld(0, 0, s, site.lat), ey = eqToWorld(Math.PI / 2, 0, s, site.lat), ez = eqToWorld(0, Math.PI / 2, s, site.lat);
  return { sun, moon, illum, age, waxing: elong < Math.PI, starBasis: [ex, ey, ez] };
}

export function phaseName(age) {
  const p = age / SYNODIC;
  const names = ['New moon', 'Waxing crescent', 'First quarter', 'Waxing gibbous', 'Full moon', 'Waning gibbous', 'Last quarter', 'Waning crescent'];
  return names[Math.round(p * 8) % 8];
}

/** Local (site) calendar helpers: the simulation clock is local solar-ish civil time. */
export function localToUtcMs(year, month, day, hours, site = SITE) {
  return Date.UTC(year, month - 1, day, 0, 0, 0) + (hours - site.tz) * 3600000;
}
export function utcMsToLocal(ms, site = SITE) {
  const t = new Date(ms + site.tz * 3600000);
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate(), hours: t.getUTCHours() + t.getUTCMinutes() / 60 + t.getUTCSeconds() / 3600 };
}
