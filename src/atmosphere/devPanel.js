import { WEATHER } from './weather.js';

// Developer controls for the sky / weather / time simulation (movable window
// behind the existing toolbar button). Overrides stay "auto" until touched.

export function initDevPanel(atmo, { view } = {}) {
  const $ = (id) => document.getElementById(id);
  const btn = $('wind-btn'), win = $('wind-debug'), hdr = $('wind-debug-hdr'), closeBtn = $('wind-debug-close');
  if (!btn || !win) return;

  // ---- open / close / drag (pointer events inside never reach the camera)
  const toggle = (force) => {
    const open = force !== undefined ? force : !win.classList.contains('open');
    win.classList.toggle('open', open); btn.classList.toggle('active', open);
  };
  btn.addEventListener('click', () => toggle());
  closeBtn.addEventListener('click', () => toggle(false));
  win.addEventListener('pointerdown', (e) => e.stopPropagation());
  win.addEventListener('wheel', (e) => e.stopPropagation());
  win.addEventListener('keydown', (e) => e.stopPropagation());
  let drag = false, ox = 0, oy = 0;
  hdr.addEventListener('pointerdown', (e) => {
    if (e.target === closeBtn) return;
    drag = true;
    const r = win.getBoundingClientRect();
    win.style.left = `${r.left}px`; win.style.top = `${r.top}px`; win.style.right = 'auto';
    ox = e.clientX - r.left; oy = e.clientY - r.top;
    hdr.setPointerCapture(e.pointerId); e.preventDefault();
  });
  hdr.addEventListener('pointermove', (e) => {
    if (!drag) return;
    win.style.left = `${Math.min(innerWidth - win.offsetWidth - 8, Math.max(8, e.clientX - ox))}px`;
    win.style.top = `${Math.min(innerHeight - 60, Math.max(8, e.clientY - oy))}px`;
  });
  hdr.addEventListener('pointerup', () => { drag = false; });
  hdr.addEventListener('pointercancel', () => { drag = false; });

  // ---- time & date
  const time = $('sw-time'), timeVal = $('sw-time-val'), date = $('sw-date'), speed = $('sw-speed');
  let scrubbing = false;
  time.addEventListener('pointerdown', () => { scrubbing = true; });
  addEventListener('pointerup', () => { scrubbing = false; });
  time.addEventListener('input', () => atmo.setHours(parseFloat(time.value)));
  date.addEventListener('change', () => {
    const [y, m, d] = date.value.split('-').map(Number);
    if (y && m && d) atmo.setDate(y, m, d);
  });
  speed.addEventListener('change', () => { atmo.timeScale = parseFloat(speed.value); });
  win.querySelectorAll('[data-hour]').forEach((b) => b.addEventListener('click', () => atmo.setHours(parseFloat(b.dataset.hour))));
  $('sw-now').addEventListener('click', () => {
    const n = new Date();
    atmo.setDate(n.getFullYear(), n.getMonth() + 1, n.getDate());
    // the island lives on Kochi time
    const utcH = n.getUTCHours() + n.getUTCMinutes() / 60;
    atmo.setHours((utcH + 5.5) % 24);
    atmo.timeScale = 1; speed.value = '1';
  });

  // ---- moon
  const moonAuto = $('sw-moon-auto'), moon = $('sw-moon'), moonVal = $('sw-moon-val');
  moon.addEventListener('input', () => { moonAuto.checked = false; atmo.setMoonAge(parseFloat(moon.value)); });
  moonAuto.addEventListener('change', () => { if (moonAuto.checked) atmo.setMoonAge(null); else atmo.setMoonAge(parseFloat(moon.value)); });

  // ---- weather
  const auto = $('sw-auto'), wx = $('sw-wx'), trans = $('sw-trans'), transVal = $('sw-trans-val');
  const order = ['clear', 'scattered', 'overcast', 'lightRain', 'monsoon', 'thunderstorm', 'fog', 'mist', 'clearing'];
  const short = { lightRain: 'Light rain', monsoon: 'Monsoon', thunderstorm: 'Storm', mist: 'Mist' };
  for (const k of order) {
    const b = document.createElement('button');
    b.type = 'button'; b.dataset.wx = k; b.textContent = short[k] || WEATHER[k].label;
    b.addEventListener('click', () => {
      auto.checked = false; atmo.weather.auto = false;
      atmo.weather.set(k, parseFloat(trans.value));
    });
    wx.appendChild(b);
  }
  auto.addEventListener('change', () => { atmo.weather.auto = auto.checked; });
  trans.addEventListener('input', () => { transVal.textContent = `${trans.value} s`; });

  // ---- extreme weather: tornado & flood
  const ex = $('sw-extreme');
  ex.innerHTML = `
    <div class="wd-sec">Tornado mode</div>
    <div class="wd-presets" id="sw-tz-lvl"></div>
    <div class="wd-presets">
      <button type="button" class="wd-btn" data-tz="start">Start</button>
      <button type="button" class="wd-btn" data-tz="pause">Pause</button>
      <button type="button" class="wd-btn" data-tz="stop">Stop</button>
      <button type="button" class="wd-btn" data-tz="reset">Reset</button>
    </div>
    <div class="wd-row"><div class="wd-lbl"><span>Storm timeline</span><span id="sw-tz-tv">idle</span></div>
      <input id="sw-tz-t" type="range" min="0" max="1" step="0.001" value="0" /></div>
    <div class="wd-two"><button type="button" class="wd-btn" id="sw-tz-watch">Watch tornado</button><button type="button" class="wd-btn" id="sw-tz-over">Back to overview</button></div>
    <div class="wd-sec">Flood mode</div>
    <div class="wd-presets">
      <button type="button" class="wd-btn" data-fl="start">Start</button>
      <button type="button" class="wd-btn" data-fl="pause">Pause</button>
      <button type="button" class="wd-btn" data-fl="recede">Recede</button>
      <button type="button" class="wd-btn" data-fl="reset">Reset</button>
    </div>
    <div id="sw-fl-sl"></div>`;
  const tz = atmo.tornado, fl = atmo.flood;
  const lvl = $('sw-tz-lvl');
  for (let i = 1; i <= 4; i++) {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = `EF${i}`; b.dataset.lvl = i;
    b.addEventListener('click', () => {
      tz.level = i;
      lvl.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
    });
    lvl.appendChild(b);
  }
  lvl.querySelector(`[data-lvl="${tz.level}"]`).classList.add('active');
  ex.querySelectorAll('[data-tz]').forEach((b) => b.addEventListener('click', () => {
    const a = b.dataset.tz;
    if (a === 'start') tz.start(tz.level); else if (a === 'pause') tz.pause(); else if (a === 'stop') tz.stop(); else tz.reset();
  }));
  // frame the storm: a low, wide view from the south-west so the whole funnel stands over the island
  $('sw-tz-watch').addEventListener('click', () => {
    if (!view) return;
    if (!tz.running) tz.start(tz.level);
    const b = tz.state.base.x === 1e5 ? tz.trackAt(tz.t) : tz.state.base;
    view([b.x - 175, 22, b.z + 235], [b.x, 98, b.z]);
  });
  $('sw-tz-over').addEventListener('click', () => view && view([-66, 112, 150], [4, 0, 0]));
  const tzT = $('sw-tz-t');
  let tzDrag = false;
  tzT.addEventListener('pointerdown', () => { tzDrag = true; });
  addEventListener('pointerup', () => { tzDrag = false; });
  tzT.addEventListener('input', () => tz.seek(parseFloat(tzT.value)));
  ex.querySelectorAll('[data-fl]').forEach((b) => b.addEventListener('click', () => {
    const a = b.dataset.fl;
    if (a === 'start') fl.start(); else if (a === 'pause') fl.pause(); else if (a === 'recede') fl.recede(); else fl.reset();
  }));
  const flSl = $('sw-fl-sl');
  for (const [k, label, min, max, step, fmt] of [
    ['depth', 'Flood depth (road)', 0.03, 0.6, 0.01, (v) => `${Math.round(v * 100)} cm`],
    ['rain', 'Rainfall intensity', 0, 1, 0.01, (v) => `${Math.round(v * 100)}%`],
    ['flow', 'Flow strength', 0.2, 2, 0.05, (v) => `${v.toFixed(2)}×`],
    ['recession', 'Recession speed', 0.2, 3, 0.05, (v) => `${v.toFixed(2)}×`],
  ]) {
    const row = document.createElement('div');
    row.className = 'wd-row';
    row.innerHTML = `<div class="wd-lbl"><span>${label}</span><span>${fmt(fl.settings[k])}</span></div><input type="range" min="${min}" max="${max}" step="${step}" value="${fl.settings[k]}" />`;
    const input = row.querySelector('input'), val = row.querySelectorAll('span')[1];
    input.addEventListener('input', () => { fl.settings[k] = parseFloat(input.value); val.textContent = fmt(fl.settings[k]); });
    flSl.appendChild(row);
  }

  // ---- overrides
  const ov = $('sw-ov');
  const defs = [
    ['cover', 'Cloud cover', 0, 1, 0.01, (v) => `${Math.round(v * 100)}%`],
    ['rain', 'Rain intensity', 0, 1, 0.01, (v) => `${Math.round(v * 100)}%`],
    ['fog', 'Fog', 0, 1, 0.01, (v) => `${Math.round(v * 100)}%`],
    ['wind', 'Wind', 0, 4, 0.05, (v) => `${v.toFixed(2)}×`],
    ['storm', 'Storm intensity', 0, 1, 0.01, (v) => `${Math.round(v * 100)}%`],
  ];
  const ovEls = {};
  for (const [k, label, min, max, step, fmt] of defs) {
    const row = document.createElement('div');
    row.className = 'wd-row';
    row.innerHTML = `<div class="wd-lbl"><span>${label}</span><span class="auto">auto</span></div><input type="range" min="${min}" max="${max}" step="${step}" />`;
    const input = row.querySelector('input'), val = row.querySelectorAll('span')[1];
    input.addEventListener('input', () => {
      atmo.weather.overrides[k] = parseFloat(input.value);
      val.classList.remove('auto'); val.textContent = fmt(parseFloat(input.value));
    });
    ov.appendChild(row);
    ovEls[k] = { input, val, fmt };
  }
  // wind direction
  {
    const row = document.createElement('div');
    row.className = 'wd-row';
    row.innerHTML = '<div class="wd-lbl"><span>Wind direction</span><span class="auto">auto</span></div><input type="range" min="0" max="360" step="1" />';
    const input = row.querySelector('input'), val = row.querySelectorAll('span')[1];
    input.addEventListener('input', () => {
      atmo.windDirOverride = (parseFloat(input.value) * Math.PI) / 180;
      val.classList.remove('auto'); val.textContent = `${input.value}°`;
    });
    ov.appendChild(row);
    ovEls.dir = { input, val };
  }
  $('sw-reset').addEventListener('click', () => {
    for (const k of Object.keys(atmo.weather.overrides)) atmo.weather.overrides[k] = null;
    atmo.windDirOverride = null;
    for (const e of Object.values(ovEls)) { e.val.classList.add('auto'); e.val.textContent = 'auto'; }
  });

  // ---- actions
  $('sw-strike').addEventListener('click', () => atmo.strike(true));
  const sound = $('sw-sound');
  sound.addEventListener('click', () => {
    atmo.audio.setEnabled(!atmo.audio.enabled);
    sound.textContent = `Sound: ${atmo.audio.enabled ? 'on' : 'off'}`;
  });
  const q = $('sw-quality');
  q.textContent = `Quality: ${atmo.quality}`;
  q.addEventListener('click', () => {
    const u = new URL(location.href);
    u.searchParams.set('quality', atmo.quality === 'high' ? 'low' : 'high');
    location.href = u.toString();
  });

  // ---- live readout (4 Hz) + keep untouched controls in sync with the simulation
  const read = $('sw-read');
  const tick = () => {
    const I = atmo.info, P = I.params || {};
    if (!scrubbing) time.value = I.hours.toFixed(2);
    timeVal.textContent = I.time;
    if (document.activeElement !== date) date.value = I.date;
    moonVal.textContent = `${I.moonAge.toFixed(1)} d`;
    if (moonAuto.checked) moon.value = I.moonAge.toFixed(1);
    wx.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.wx === I.state));
    if (auto.checked !== atmo.weather.auto) auto.checked = atmo.weather.auto;
    for (const [k, e] of Object.entries(ovEls)) {
      if (k === 'dir' || atmo.weather.overrides[k] !== null) continue;
      e.input.value = P[k] ?? 0;
    }
    read.innerHTML = `<b>${I.time}</b> · ${I.date} · Kochi<br>`
      + `Sun ${I.sunEl.toFixed(1)}° · Moon ${I.moonEl.toFixed(1)}° · ${I.phase} ${Math.round(I.illum * 100)}%<br>`
      + `<b>${I.weather}</b> · cloud ${Math.round((P.cover || 0) * 100)}% · rain ${Math.round((P.rain || 0) * 100)}%<br>`
      + `wind ${(P.wind || 0).toFixed(2)} · fog ${Math.round((P.fog || 0) * 100)}% · wet ${Math.round(I.wet * 100)}% · puddles ${Math.round(I.puddle * 100)}%`
      + (I.tornado ? `<br><b>Tornado</b> ${I.tornado}` : '')
      + (I.flood ? `<br><b>Flood</b> ${I.flood}` : '');
    if (!tzDrag) tzT.value = tz.progress.toFixed(3);
    $('sw-tz-tv').textContent = tz.running ? tz.phaseName() : 'idle';
    ex.querySelector('[data-tz="pause"]').textContent = tz.paused ? 'Resume' : 'Pause';
    ex.querySelector('[data-fl="pause"]').textContent = fl.paused ? 'Resume' : 'Pause';
  };
  tick();
  setInterval(tick, 250);
}
