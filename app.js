const STORAGE_KEYS = {
  clientId: 'pulseboard_client_id',
  token: 'pulseboard_access_token',
  tokenExp: 'pulseboard_token_exp',
  user: 'pulseboard_user_info',
  takeout: 'pulseboard_takeout_data',
  design: 'pulseboard_design_prefs'
};

const GOOGLE_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly',
  'https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly',
  'https://www.googleapis.com/auth/googlehealth.sleep.readonly',
  'https://www.googleapis.com/auth/googlehealth.profile.readonly'
].join(' ');

// Optional: Eigene Google Client ID hier eintragen, damit der Login sofort ohne Eingabefeld startet
const PRECONFIGURED_CLIENT_ID = '';

const DEFAULT_DESIGN = {
  theme: 'system',
  accent: '#10b981',
  radius: 16,
  density: 'comfortable',
  glass: false,
  topNav: false,
  goalSteps: 10000,
  goalSleepHours: 8,
  widgets: { steps: true, sleep: true, heart: true, workouts: true }
};

const state = {
  days: 14,
  data: null,
  tokenClient: null,
  currentView: 'overview',
  design: loadDesign()
};

const VIEW_META = {
  overview: ['Übersicht', 'Echte Gesundheitsdaten aus Google Health'],
  activity: ['Aktivität & Schritte', 'Tägliche Bewegung, Distanz und Kalorien'],
  heart: ['Herz & Vitalwerte', 'Ruhepuls, Herzfrequenzbereich, SpO2 und Gewicht'],
  sleep: ['Schlafanalyse', 'Schlafdauer und Schlafphasen pro Nacht'],
  workouts: ['Workouts', 'Alle aufgezeichneten Trainingseinheiten'],
  design: ['Design & Theme', 'Passe Farben, Layout, Widgets und Ziele an'],
  setup: ['Google-Login', '100% lokal im Browser — keine Daten auf fremden Servern']
};

const fmtNum = (n) => (n == null ? '—' : new Intl.NumberFormat('de-DE').format(Math.round(n)));
const fmtSleep = (mins) => (!mins ? '—' : `${Math.floor(mins / 60)}h ${Math.round(mins % 60)}m`);
const shortDate = (iso) => {
  const [y, m, d] = String(iso).slice(0, 10).split('-');
  return d && m ? `${d}.${m}.` : iso;
};
const toDayKey = (iso) => String(iso || '').slice(0, 10);

function loadDesign() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEYS.design) || '{}');
    return {
      ...DEFAULT_DESIGN,
      ...saved,
      widgets: { ...DEFAULT_DESIGN.widgets, ...(saved.widgets || {}) }
    };
  } catch {
    return { ...DEFAULT_DESIGN, widgets: { ...DEFAULT_DESIGN.widgets } };
  }
}

function saveAndApplyDesign() {
  localStorage.setItem(STORAGE_KEYS.design, JSON.stringify(state.design));
  applyDesign();
}

function resolveTheme(theme) {
  if (theme === 'system') {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  return theme;
}

function applyDesign() {
  const d = state.design;
  const html = document.documentElement;
  html.dataset.theme = resolveTheme(d.theme);
  html.dataset.density = d.density;
  html.dataset.glass = String(Boolean(d.glass));
  html.style.setProperty('--accent', d.accent);
  html.style.setProperty('--radius', `${d.radius}px`);
  document.getElementById('appShell').classList.toggle('top-nav', Boolean(d.topNav));

  // Sync design UI controls
  document.querySelectorAll('#themePresets .chip').forEach((c) => c.classList.toggle('active', c.dataset.themeVal === d.theme));
  document.querySelectorAll('#accentPresets .color-dot').forEach((c) => c.classList.toggle('active', c.dataset.accent.toLowerCase() === d.accent.toLowerCase()));
  document.querySelectorAll('#densityPresets .chip').forEach((c) => c.classList.toggle('active', c.dataset.density === d.density));
  document.getElementById('customAccentInput').value = d.accent;
  document.getElementById('radiusRange').value = d.radius;
  document.getElementById('radiusLabel').textContent = `${d.radius}px`;
  document.getElementById('glassToggle').checked = Boolean(d.glass);
  document.getElementById('topNavToggle').checked = Boolean(d.topNav);
  document.getElementById('goalStepsInput').value = d.goalSteps;
  document.getElementById('goalSleepInput').value = d.goalSleepHours;
  document.getElementById('stepsGoalLabel').textContent = `Tagesziel: ${fmtNum(d.goalSteps)} Schritte`;

  document.querySelectorAll('[data-widget-toggle]').forEach((cb) => {
    const key = cb.dataset.widgetToggle;
    cb.checked = d.widgets[key] !== false;
  });
  document.querySelectorAll('[data-widget]').forEach((card) => {
    const key = card.dataset.widget;
    card.classList.toggle('hidden', d.widgets[key] === false);
  });
}

const tooltip = document.getElementById('tooltip');
function showTip(evt, html) {
  tooltip.innerHTML = html;
  tooltip.classList.remove('hidden');
  tooltip.style.left = `${evt.clientX + 12}px`;
  tooltip.style.top = `${evt.clientY - 12}px`;
}
function hideTip() {
  tooltip.classList.add('hidden');
}

function setView(viewName) {
  state.currentView = viewName;
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === viewName));
  const showGate = !state.data && viewName !== 'design' && viewName !== 'setup';
  document.getElementById('authGate').classList.toggle('hidden', !showGate);

  document.querySelectorAll('.view').forEach((v) => {
    const isTarget = v.id === `view-${viewName}`;
    v.classList.toggle('active', isTarget && !showGate);
  });

  const [title, sub] = VIEW_META[viewName] || ['Dashboard', ''];
  document.getElementById('pageTitle').textContent = title;
  document.getElementById('pageSubtitle').textContent = sub;
}

function getValidToken() {
  const token = localStorage.getItem(STORAGE_KEYS.token);
  const exp = Number(localStorage.getItem(STORAGE_KEYS.tokenExp) || 0);
  if (!token || Date.now() >= exp) return null;
  return token;
}

// Chunked rollUp (Google Health API limits total-calories & active-energy-burned to 14 days per call)
async function rollUpMetric(token, dataType, startTime, endTime) {
  const startMs = new Date(startTime).getTime();
  const endMs = new Date(endTime).getTime();
  const maxChunkMs = 13 * 86400000;
  const allPoints = [];

  for (let cur = startMs; cur < endMs; cur += maxChunkMs) {
    const chunkEnd = Math.min(endMs, cur + maxChunkMs);
    let pageToken = null;
    do {
      const url = `https://health.googleapis.com/v4/users/me/dataTypes/${encodeURIComponent(dataType)}/dataPoints:rollUp`;
      const body = {
        range: { startTime: new Date(cur).toISOString(), endTime: new Date(chunkEnd).toISOString() },
        windowSize: '86400s'
      };
      if (pageToken) body.pageToken = pageToken;
      const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        const txt = await res.text();
        return { error: `${dataType}: HTTP ${res.status}`, details: txt, rollupDataPoints: allPoints };
      }
      const json = await res.json();
      allPoints.push(...(json.rollupDataPoints || []));
      pageToken = json.nextPageToken || null;
    } while (pageToken);
  }
  return { rollupDataPoints: allPoints };
}

async function listDataPoints(token, dataType, startTime, endTime) {
  const allPoints = [];
  let pageToken = null;
  let useFilter = true;

  do {
    const params = new URLSearchParams({ pageSize: '100' });
    if (useFilter) {
      params.set('filter', `interval.start_time >= "${startTime}" AND interval.end_time <= "${endTime}"`);
    }
    if (pageToken) params.set('pageToken', pageToken);

    const url = `https://health.googleapis.com/v4/users/me/dataTypes/${encodeURIComponent(dataType)}/dataPoints?${params}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });

    if (!res.ok) {
      if (res.status === 400 && useFilter) {
        useFilter = false;
        pageToken = null;
        continue;
      }
      const txt = await res.text();
      return { error: `${dataType}: HTTP ${res.status}`, details: txt, dataPoints: allPoints };
    }

    const json = await res.json();
    allPoints.push(...(json.dataPoints || []));
    pageToken = json.nextPageToken || null;
  } while (pageToken && allPoints.length < 500);

  return { dataPoints: allPoints };
}

async function fetchGoogleHealthData(token, days) {
  const end = new Date();
  const start = new Date(end.getTime() - days * 86400000);
  start.setUTCHours(0, 0, 0, 0);
  const startIso = start.toISOString();
  const endIso = end.toISOString();

  const [
    stepsRes, caloriesRes, activeCaloriesRes, distanceRes, hrRes,
    restingHrRes, spo2Res, sleepRes, exerciseRes, weightRes
  ] = await Promise.all([
    rollUpMetric(token, 'steps', startIso, endIso),
    rollUpMetric(token, 'total-calories', startIso, endIso),
    rollUpMetric(token, 'active-energy-burned', startIso, endIso),
    rollUpMetric(token, 'distance', startIso, endIso),
    rollUpMetric(token, 'heart-rate', startIso, endIso),
    listDataPoints(token, 'daily-resting-heart-rate', startIso, endIso),
    listDataPoints(token, 'daily-oxygen-saturation', startIso, endIso),
    listDataPoints(token, 'sleep', startIso, endIso),
    listDataPoints(token, 'exercise', startIso, endIso),
    listDataPoints(token, 'weight', startIso, endIso)
  ]);

  const diagLines = [
    ['steps', stepsRes.rollupDataPoints?.length, stepsRes.error],
    ['total-calories', caloriesRes.rollupDataPoints?.length, caloriesRes.error],
    ['active-energy-burned', activeCaloriesRes.rollupDataPoints?.length, activeCaloriesRes.error],
    ['distance', distanceRes.rollupDataPoints?.length, distanceRes.error],
    ['heart-rate', hrRes.rollupDataPoints?.length, hrRes.error],
    ['daily-resting-heart-rate', restingHrRes.dataPoints?.length, restingHrRes.error],
    ['daily-oxygen-saturation', spo2Res.dataPoints?.length, spo2Res.error],
    ['sleep', sleepRes.dataPoints?.length, sleepRes.error],
    ['exercise', exerciseRes.dataPoints?.length, exerciseRes.error],
    ['weight', weightRes.dataPoints?.length, weightRes.error]
  ].map(([name, count, err]) => `${name}: ${err ? err : `${count || 0} Einträge`}`);
  document.getElementById('apiDiagLog').textContent = diagLines.join('\n');

  const dayMap = new Map();
  for (let i = days - 1; i >= 0; i--) {
    const key = new Date(end.getTime() - i * 86400000).toISOString().slice(0, 10);
    dayMap.set(key, {
      date: key, steps: 0, calories: 0, activeCalories: 0, distanceKm: 0,
      hrAvg: null, hrMin: null, hrMax: null, restingHr: null, spo2: null,
      sleepMinutes: 0, sleepDeepMin: 0, sleepRemMin: 0, sleepLightMin: 0, sleepAwakeMin: 0, weightKg: null
    });
  }

  for (const pt of stepsRes.rollupDataPoints || []) {
    const e = dayMap.get(toDayKey(pt.startTime));
    if (e && pt.steps?.countSum != null) e.steps += Number(pt.steps.countSum);
  }
  for (const pt of caloriesRes.rollupDataPoints || []) {
    const e = dayMap.get(toDayKey(pt.startTime));
    const v = pt.totalCalories?.kcalSum ?? pt.totalCalories?.caloriesSum;
    if (e && v != null) e.calories += Math.round(Number(v));
  }
  for (const pt of activeCaloriesRes.rollupDataPoints || []) {
    const e = dayMap.get(toDayKey(pt.startTime));
    const v = pt.activeEnergyBurned?.kcalSum ?? pt.activeEnergyBurned?.caloriesSum;
    if (e && v != null) e.activeCalories += Math.round(Number(v));
  }
  for (const pt of distanceRes.rollupDataPoints || []) {
    const e = dayMap.get(toDayKey(pt.startTime));
    const mm = pt.distance?.millimetersSum;
    const m = pt.distance?.metersSum;
    if (e && (mm != null || m != null)) {
      e.distanceKm += Number((mm != null ? Number(mm) / 1e6 : Number(m) / 1000).toFixed(2));
    }
  }
  for (const pt of hrRes.rollupDataPoints || []) {
    const e = dayMap.get(toDayKey(pt.startTime));
    if (e && pt.heartRate) {
      e.hrAvg = pt.heartRate.beatsPerMinuteAvg ?? e.hrAvg;
      e.hrMin = pt.heartRate.beatsPerMinuteMin ?? e.hrMin;
      e.hrMax = pt.heartRate.beatsPerMinuteMax ?? e.hrMax;
    }
  }
  for (const pt of restingHrRes.dataPoints || []) {
    const e = dayMap.get(toDayKey(pt.startTime || pt.interval?.startTime || pt.sample?.time));
    const bpm = pt.dailyRestingHeartRate?.beatsPerMinute;
    if (e && bpm != null) e.restingHr = Math.round(Number(bpm));
  }
  for (const pt of spo2Res.dataPoints || []) {
    const e = dayMap.get(toDayKey(pt.startTime || pt.interval?.startTime || pt.sample?.time));
    const pct = pt.dailyOxygenSaturation?.averagePercentage ?? pt.dailyOxygenSaturation?.percentage;
    if (e && pct != null) e.spo2 = Number(Number(pct).toFixed(1));
  }
  for (const pt of weightRes.dataPoints || []) {
    const e = dayMap.get(toDayKey(pt.time || pt.sample?.time || pt.startTime || pt.interval?.startTime));
    const grams = pt.weight?.grams ?? (pt.weight?.kilograms != null ? Number(pt.weight.kilograms) * 1000 : null);
    if (e && grams != null) e.weightKg = Number((Number(grams) / 1000).toFixed(1));
  }
  for (const pt of sleepRes.dataPoints || []) {
    const sleep = pt.sleep || {};
    const startT = pt.startTime || pt.interval?.startTime || sleep.startTime;
    const endT = pt.endTime || pt.interval?.endTime || sleep.endTime;
    const e = dayMap.get(toDayKey(endT || startT));
    if (!e) continue;
    if (startT && endT) {
      e.sleepMinutes += Math.max(0, Math.round((new Date(endT) - new Date(startT)) / 60000));
    }
    for (const s of sleep.stages || sleep.sleepStages || []) {
      const sStart = s.startTime || s.interval?.startTime;
      const sEnd = s.endTime || s.interval?.endTime;
      if (!sStart || !sEnd) continue;
      const dur = Math.max(0, Math.round((new Date(sEnd) - new Date(sStart)) / 60000));
      const t = String(s.type || s.stageType || '').toUpperCase();
      if (t.includes('DEEP')) e.sleepDeepMin += dur;
      else if (t.includes('REM')) e.sleepRemMin += dur;
      else if (t.includes('LIGHT')) e.sleepLightMin += dur;
      else if (t.includes('AWAKE')) e.sleepAwakeMin += dur;
    }
  }

  const workouts = (exerciseRes.dataPoints || [])
    .map((pt) => {
      const ex = pt.exercise || {};
      const startT = pt.startTime || pt.interval?.startTime || ex.startTime;
      const endT = pt.endTime || pt.interval?.endTime || ex.endTime;
      return {
        date: startT || '',
        type: ex.exerciseType || ex.displayName || 'Workout',
        durationMin: startT && endT ? Math.max(1, Math.round((new Date(endT) - new Date(startT)) / 60000)) : 0,
        calories: Math.round(Number(ex.calories?.kcal || ex.totalCalories || 0)),
        distanceKm: ex.distance?.millimeters ? Number((Number(ex.distance.millimeters) / 1e6).toFixed(2)) : 0
      };
    })
    .filter((w) => w.date >= startIso.slice(0, 10))
    .sort((a, b) => b.date.localeCompare(a.date));

  const warnings = [
    stepsRes, caloriesRes, activeCaloriesRes, distanceRes, hrRes,
    restingHrRes, spo2Res, sleepRes, exerciseRes, weightRes
  ].filter((r) => r.error).map((r) => r.error);

  return { source: 'google-health', days: Array.from(dayMap.values()), workouts, warnings };
}

function renderKpis(containerId, items) {
  document.getElementById(containerId).innerHTML = items.map((item) => `
    <div class="kpi-card">
      <div class="kpi-label">${item.label}</div>
      <div class="kpi-value" style="color:${item.color || 'var(--text)'}">${item.value}</div>
      <div class="kpi-sub">${item.sub}</div>
    </div>
  `).join('');
}

function renderBarChart(containerId, days, getValue, color, labelFn, goalValue = null) {
  const el = document.getElementById(containerId);
  if (!days.length) { el.innerHTML = ''; return; }
  const w = 640, h = 210, padL = 38, padR = 12, padT = 14, padB = 26;
  const vals = days.map(getValue);
  const maxVal = Math.max(goalValue || 0, ...vals, 10) * 1.1;
  const chartW = w - padL - padR;
  const chartH = h - padT - padB;
  const barW = Math.max(6, (chartW / days.length) * 0.62);
  const step = chartW / days.length;

  let goalLine = '';
  if (goalValue) {
    const gy = padT + chartH - (goalValue / maxVal) * chartH;
    goalLine = `<line x1="${padL}" y1="${gy}" x2="${w - padR}" y2="${gy}" stroke="var(--muted)" stroke-opacity="0.35" stroke-dasharray="4 4" />`;
  }

  const bars = days.map((d, i) => {
    const val = vals[i];
    const bh = val > 0 ? Math.max(3, (val / maxVal) * chartH) : 1;
    const x = padL + i * step + (step - barW) / 2;
    const y = padT + chartH - bh;
    const showLabel = days.length <= 14 || i % Math.ceil(days.length / 8) === 0;
    return `
      <rect class="bar-rect" data-idx="${i}" x="${x}" y="${y}" width="${barW}" height="${bh}" rx="4" fill="${color}" opacity="${val > 0 ? '0.9' : '0.2'}" style="cursor:pointer" />
      ${showLabel ? `<text x="${x + barW / 2}" y="${h - 6}" text-anchor="middle" fill="var(--muted)" font-size="10">${shortDate(d.date)}</text>` : ''}
    `;
  }).join('');

  el.innerHTML = `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${goalLine}${bars}</svg>`;
  el.querySelectorAll('.bar-rect').forEach((rect) => {
    const idx = Number(rect.dataset.idx);
    rect.addEventListener('mousemove', (e) => showTip(e, labelFn(days[idx])));
    rect.addEventListener('mouseleave', hideTip);
  });
}

function renderLineChart(containerId, days, seriesList) {
  const el = document.getElementById(containerId);
  if (!days.length) { el.innerHTML = ''; return; }
  const w = 640, h = 210, padL = 36, padR = 16, padT = 16, padB = 26;
  const allVals = seriesList.flatMap((s) => days.map(s.get).filter((v) => v != null));
  if (!allVals.length) {
    el.innerHTML = '<div class="card-meta" style="padding-top:90px;text-align:center">Keine Herzfrequenz-Daten im Zeitraum.</div>';
    return;
  }
  const minVal = Math.floor(Math.min(...allVals) * 0.9);
  const maxVal = Math.ceil(Math.max(...allVals) * 1.08);
  const span = Math.max(1, maxVal - minVal);
  const chartW = w - padL - padR;
  const chartH = h - padT - padB;

  const paths = seriesList.map((s) => {
    const pts = days.map((d, i) => {
      const v = s.get(d);
      if (v == null) return null;
      const x = padL + (i / Math.max(1, days.length - 1)) * chartW;
      const y = padT + chartH - ((v - minVal) / span) * chartH;
      return { x, y, v, d };
    }).filter(Boolean);
    if (!pts.length) return '';
    const dAttr = pts.map((p, idx) => `${idx === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    const dots = pts.map((p) => `<circle class="line-dot" data-date="${p.d.date}" data-label="${s.name}" data-val="${Math.round(p.v)}" cx="${p.x}" cy="${p.y}" r="3.5" fill="${s.color}" style="cursor:pointer"/>`).join('');
    return `<path d="${dAttr}" fill="none" stroke="${s.color}" stroke-width="2.4" stroke-linecap="round" />${dots}`;
  }).join('');

  const xLabels = days.map((d, i) => {
    if (days.length > 10 && i % Math.ceil(days.length / 7) !== 0) return '';
    const x = padL + (i / Math.max(1, days.length - 1)) * chartW;
    return `<text x="${x}" y="${h - 6}" text-anchor="middle" fill="var(--muted)" font-size="10">${shortDate(d.date)}</text>`;
  }).join('');

  el.innerHTML = `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${paths}${xLabels}</svg>`;
  el.querySelectorAll('.line-dot').forEach((dot) => {
    dot.addEventListener('mousemove', (e) => showTip(e, `<strong>${shortDate(dot.dataset.date)}</strong><br/>${dot.dataset.label}: ${dot.dataset.val} bpm`));
    dot.addEventListener('mouseleave', hideTip);
  });
}

function renderSleepDonut(containerId, days) {
  const el = document.getElementById(containerId);
  const sleepDays = days.filter((d) => d.sleepMinutes > 0);
  if (!sleepDays.length) {
    el.innerHTML = '<div class="card-meta">Keine Schlafdaten im Zeitraum.</div>';
    return;
  }
  const count = sleepDays.length;
  const deep = sleepDays.reduce((a, b) => a + (b.sleepDeepMin || 0), 0) / count;
  const rem = sleepDays.reduce((a, b) => a + (b.sleepRemMin || 0), 0) / count;
  const light = sleepDays.reduce((a, b) => a + (b.sleepLightMin || 0), 0) / count;
  const awake = sleepDays.reduce((a, b) => a + (b.sleepAwakeMin || 0), 0) / count;
  const stageTotal = deep + rem + light + awake;
  const avgSleep = sleepDays.reduce((a, b) => a + b.sleepMinutes, 0) / count;
  const total = stageTotal > 0 ? stageTotal : avgSleep;

  const segments = stageTotal > 0
    ? [
        { label: 'Tiefschlaf', val: deep, color: '#6366f1' },
        { label: 'REM', val: rem, color: '#06b6d4' },
        { label: 'Leicht', val: light, color: '#818cf8' },
        { label: 'Wach', val: awake, color: '#f43f5e' }
      ]
    : [{ label: 'Schlafdauer', val: avgSleep, color: '#818cf8' }];

  const r = 56, c = 2 * Math.PI * r;
  let offset = 0;
  const arcs = segments.map((s) => {
    const len = (s.val / Math.max(1, total)) * c;
    const arc = `<circle cx="75" cy="75" r="${r}" fill="none" stroke="${s.color}" stroke-width="18" stroke-dasharray="${len} ${c - len}" stroke-dashoffset="${-offset}" transform="rotate(-90 75 75)"/>`;
    offset += len;
    return arc;
  }).join('');

  el.innerHTML = `
    <svg viewBox="0 0 150 150" style="width:150px;height:150px;flex-shrink:0">
      ${arcs}
      <text x="75" y="79" text-anchor="middle" fill="var(--text)" font-size="14" font-weight="700">${fmtSleep(avgSleep)}</text>
    </svg>
    <div class="donut-legend">
      ${segments.map((s) => `
        <div class="legend-row">
          <span class="legend-swatch" style="background:${s.color}"></span>
          <span>${s.label}: <strong>${Math.round(s.val)}m</strong></span>
        </div>
      `).join('')}
    </div>
  `;
}

function renderDashboard() {
  const data = state.data;
  if (!data) return;
  const days = data.days || [];
  const workouts = data.workouts || [];
  const latest = days[days.length - 1] || {};
  const avg = (fn) => {
    const vals = days.map(fn).filter((v) => v != null && v > 0);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  };

  const avgSteps = avg((d) => d.steps);
  const avgSleep = avg((d) => d.sleepMinutes);
  const avgRhr = avg((d) => d.restingHr);
  const avgCal = avg((d) => d.calories);

  renderKpis('kpiGrid', [
    { label: 'Schritte (Heute)', value: fmtNum(latest.steps), sub: avgSteps != null ? `Ø ${fmtNum(avgSteps)} / Tag` : 'Keine Daten', color: 'var(--accent)' },
    { label: 'Schlaf (Letzte Nacht)', value: fmtSleep(latest.sleepMinutes), sub: avgSleep != null ? `Ø ${fmtSleep(avgSleep)}` : 'Keine Daten', color: 'var(--indigo)' },
    { label: 'Ruhepuls', value: latest.restingHr ? `${latest.restingHr} bpm` : '—', sub: avgRhr != null ? `Ø ${Math.round(avgRhr)} bpm` : 'Keine Daten', color: 'var(--rose)' },
    { label: 'Kalorien (Heute)', value: latest.calories ? `${fmtNum(latest.calories)} kcal` : '—', sub: avgCal != null ? `Ø ${fmtNum(avgCal)} kcal` : 'Keine Daten', color: 'var(--amber)' }
  ]);

  document.getElementById('stepsAvgBadge').textContent = avgSteps != null ? `Ø ${fmtNum(avgSteps)}` : '—';
  document.getElementById('sleepAvgBadge').textContent = avgSleep != null ? `Ø ${fmtSleep(avgSleep)}` : '—';
  document.getElementById('hrAvgBadge').textContent = avgRhr != null ? `Ø ${Math.round(avgRhr)} bpm` : '—';

  renderBarChart('overviewStepsChart', days, (d) => d.steps || 0, 'var(--accent)', (d) => `<strong>${shortDate(d.date)}</strong><br/>${fmtNum(d.steps)} Schritte<br/>${d.distanceKm || 0} km`, state.design.goalSteps);
  renderSleepDonut('sleepDonutChart', days);
  renderLineChart('overviewHrChart', days, [
    { name: 'Ø Puls', color: 'var(--amber)', get: (d) => d.hrAvg },
    { name: 'Ruhepuls', color: 'var(--rose)', get: (d) => d.restingHr }
  ]);

  document.getElementById('overviewWorkouts').innerHTML = workouts.slice(0, 4).map((w) => `
    <div class="mini-item">
      <div><strong>${w.type}</strong><div class="mini-item-sub">${shortDate(w.date)} · ${w.durationMin} Min</div></div>
      <div><strong>${fmtNum(w.calories)} kcal</strong></div>
    </div>
  `).join('') || '<p class="card-meta">Keine Workouts im Zeitraum.</p>';

  const totalSteps = days.reduce((a, b) => a + (b.steps || 0), 0);
  const totalDist = days.reduce((a, b) => a + (b.distanceKm || 0), 0);
  const avgActiveCal = avg((d) => d.activeCalories);
  renderKpis('activityKpis', [
    { label: 'Gesamt-Schritte', value: fmtNum(totalSteps), sub: `In ${days.length} Tagen`, color: 'var(--accent)' },
    { label: 'Gesamt-Distanz', value: `${totalDist.toFixed(1)} km`, sub: `Ø ${(totalDist / Math.max(1, days.length)).toFixed(1)} km/Tag`, color: 'var(--cyan)' },
    { label: 'Aktiv-Kalorien (Ø)', value: avgActiveCal != null ? `${fmtNum(avgActiveCal)} kcal` : '—', sub: 'Pro Tag', color: 'var(--amber)' }
  ]);
  renderBarChart('activityStepsChart', days, (d) => d.steps || 0, 'var(--accent)', (d) => `<strong>${shortDate(d.date)}</strong><br/>${fmtNum(d.steps)} Schritte · ${fmtNum(d.activeCalories)} kcal aktiv`, state.design.goalSteps);

  const latestSpo2 = [...days].reverse().find((d) => d.spo2 != null)?.spo2;
  const latestWeight = [...days].reverse().find((d) => d.weightKg != null)?.weightKg;
  renderKpis('heartKpis', [
    { label: 'Aktueller Ruhepuls', value: latest.restingHr ? `${latest.restingHr} bpm` : '—', sub: avgRhr != null ? `Ø ${Math.round(avgRhr)} bpm` : 'Keine Daten', color: 'var(--rose)' },
    { label: 'Blutsauerstoff (SpO2)', value: latestSpo2 ? `${latestSpo2}%` : '—', sub: 'Letzter Messwert', color: 'var(--cyan)' },
    { label: 'Gewicht', value: latestWeight ? `${latestWeight} kg` : '—', sub: 'Letzter Messwert', color: 'var(--indigo)' }
  ]);
  renderLineChart('heartDetailChart', days, [
    { name: 'Max Puls', color: '#fb7185', get: (d) => d.hrMax },
    { name: 'Ø Puls', color: 'var(--amber)', get: (d) => d.hrAvg },
    { name: 'Ruhepuls', color: 'var(--rose)', get: (d) => d.restingHr }
  ]);

  const avgDeep = avg((d) => d.sleepDeepMin);
  const avgRem = avg((d) => d.sleepRemMin);
  renderKpis('sleepKpis', [
    { label: 'Ø Schlafdauer', value: fmtSleep(avgSleep), sub: `Ziel: ${state.design.goalSleepHours}h`, color: 'var(--indigo)' },
    { label: 'Ø Tiefschlaf', value: avgDeep != null ? `${Math.round(avgDeep)} min` : '—', sub: 'Regeneration', color: '#6366f1' },
    { label: 'Ø REM-Schlaf', value: avgRem != null ? `${Math.round(avgRem)} min` : '—', sub: 'Erholung & Fokus', color: 'var(--cyan)' }
  ]);
  renderBarChart('sleepDetailChart', days, (d) => (d.sleepMinutes || 0) / 60, 'var(--indigo)', (d) => `<strong>${shortDate(d.date)}</strong><br/>${fmtSleep(d.sleepMinutes)}<br/>Tief: ${d.sleepDeepMin}m · REM: ${d.sleepRemMin}m`, state.design.goalSleepHours);

  document.getElementById('workoutsTableBody').innerHTML = workouts.map((w) => `
    <tr>
      <td>${shortDate(w.date)}</td>
      <td><strong>${w.type}</strong></td>
      <td>${w.durationMin} Min</td>
      <td>${fmtNum(w.calories)} kcal</td>
      <td>${w.distanceKm ? `${w.distanceKm} km` : '—'}</td>
    </tr>
  `).join('') || '<tr><td colspan="5">Keine Workouts gefunden.</td></tr>';

  const banner = document.getElementById('warningBanner');
  if (data.warnings?.length) {
    banner.textContent = `Hinweis zu einigen Google Health Endpunkten: ${data.warnings.join(', ')}`;
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }
}

async function handleOAuthRedirectHash() {
  if (!window.location.hash || !window.location.hash.includes('access_token=')) return;
  const params = new URLSearchParams(window.location.hash.slice(1));
  const accessToken = params.get('access_token');
  const expiresIn = Number(params.get('expires_in') || 3600);
  if (!accessToken) return;

  localStorage.setItem(STORAGE_KEYS.token, accessToken);
  localStorage.setItem(STORAGE_KEYS.tokenExp, String(Date.now() + (expiresIn - 60) * 1000));
  history.replaceState(null, '', window.location.pathname + window.location.search);

  try {
    const uRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (uRes.ok) localStorage.setItem(STORAGE_KEYS.user, JSON.stringify(await uRes.json()));
  } catch {
    // Optional profile info
  }
}

async function refreshDashboard() {
  await handleOAuthRedirectHash();
  const clientId = localStorage.getItem(STORAGE_KEYS.clientId) || PRECONFIGURED_CLIENT_ID || '';
  if (clientId && !localStorage.getItem(STORAGE_KEYS.clientId)) {
    localStorage.setItem(STORAGE_KEYS.clientId, clientId);
  }
  document.getElementById('clientIdInput').value = clientId;
  const gateInput = document.getElementById('gateClientIdInput');
  if (gateInput) gateInput.value = clientId;
  const gateRow = document.getElementById('gateClientRow');
  if (gateRow) gateRow.classList.toggle('hidden', Boolean(clientId));
  document.getElementById('originUriCode').textContent = window.location.origin + window.location.pathname;

  const badge = document.getElementById('statusBadge');
  const accText = document.getElementById('accountText');
  const authBtn = document.getElementById('sidebarAuthBtn');
  const topbarAuthBtn = document.getElementById('topbarAuthBtn');
  const logoutBtn = document.getElementById('logoutBtn');
  const avatar = document.getElementById('userAvatar');
  const userName = document.getElementById('userName');

  const token = getValidToken();
  const savedTakeout = localStorage.getItem(STORAGE_KEYS.takeout);
  const userInfo = JSON.parse(localStorage.getItem(STORAGE_KEYS.user) || 'null');

  if (token) {
    badge.textContent = 'Google Health Live';
    badge.className = 'badge badge-live';
    if (userInfo?.picture) {
      avatar.src = userInfo.picture;
      avatar.classList.remove('hidden');
    }
    if (userInfo?.name) {
      userName.textContent = userInfo.name;
      userName.classList.remove('hidden');
    }
    accText.textContent = userInfo?.email || 'Verbunden (nur lokal im Browser).';
    authBtn.textContent = 'Daten aktualisieren';
    if (topbarAuthBtn) topbarAuthBtn.textContent = 'Aktualisieren';
    logoutBtn.classList.remove('hidden');
    state.data = await fetchGoogleHealthData(token, state.days);
  } else if (savedTakeout) {
    const parsed = JSON.parse(savedTakeout);
    state.data = { ...parsed, days: (parsed.days || []).slice(-state.days) };
    badge.textContent = 'Lokaler Import';
    badge.className = 'badge badge-demo';
    avatar.classList.add('hidden');
    userName.classList.add('hidden');
    accText.textContent = 'Importierte Takeout-Daten (nur lokal gespeichert).';
    authBtn.textContent = 'Mit Google anmelden';
    if (topbarAuthBtn) topbarAuthBtn.textContent = 'Mit Google anmelden';
    logoutBtn.classList.add('hidden');
  } else {
    state.data = null;
    badge.textContent = 'Nicht verbunden';
    badge.className = 'badge badge-offline';
    avatar.classList.add('hidden');
    userName.classList.add('hidden');
    accText.textContent = clientId
      ? 'Client ID bereit. Jetzt mit Google anmelden.'
      : 'Melde dich mit Google an, um deine echten Werte zu sehen.';
    authBtn.textContent = 'Mit Google anmelden';
    if (topbarAuthBtn) topbarAuthBtn.textContent = 'Mit Google anmelden';
    logoutBtn.classList.add('hidden');
  }

  setView(state.currentView);
  if (state.data) renderDashboard();
}

function showAuthFeedback(msg) {
  const banner = document.getElementById('warningBanner');
  banner.textContent = msg;
  banner.classList.remove('hidden');
  const gateMsg = document.getElementById('gateMsg');
  if (gateMsg) gateMsg.textContent = msg;
  const configMsg = document.getElementById('configMsg');
  if (configMsg) configMsg.textContent = msg;
}

function startGoogleLogin() {
  const gateVal = document.getElementById('gateClientIdInput')?.value?.trim();
  const setupVal = document.getElementById('clientIdInput')?.value?.trim();
  if (gateVal) localStorage.setItem(STORAGE_KEYS.clientId, gateVal);
  else if (setupVal) localStorage.setItem(STORAGE_KEYS.clientId, setupVal);

  const clientId = localStorage.getItem(STORAGE_KEYS.clientId) || PRECONFIGURED_CLIENT_ID;
  if (!clientId) {
    showAuthFeedback('Bitte füge einmalig deine Google Client ID ein (siehe „Anleitung öffnen“). Danach öffnet der Button direkt die Google-Anmeldeseite.');
    const gateInput = document.getElementById('gateClientIdInput');
    if (gateInput && !document.getElementById('authGate').classList.contains('hidden')) {
      gateInput.focus();
    } else {
      setView('setup');
      document.getElementById('clientIdInput')?.focus();
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }

  // Direkt zur echten Google-Anmeldeseite (wie accounts.google.com) weiterleiten
  const redirectUri = window.location.origin + window.location.pathname;
  const authParams = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'token',
    scope: GOOGLE_SCOPES,
    include_granted_scopes: 'true',
    prompt: 'consent'
  });
  window.location.href = `https://accounts.google.com/o/oauth2/v2/auth?${authParams.toString()}`;
}

// Navigation & Auth Events
document.querySelectorAll('.nav-item').forEach((btn) => btn.addEventListener('click', () => setView(btn.dataset.view)));
document.querySelectorAll('#rangeSelector .seg-btn').forEach((btn) => {
  btn.addEventListener('click', async () => {
    document.querySelectorAll('#rangeSelector .seg-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.days = Number(btn.dataset.days);
    await refreshDashboard();
  });
});

document.getElementById('quickThemeBtn').addEventListener('click', () => {
  state.design.theme = state.design.theme === 'light' ? 'dark' : 'light';
  saveAndApplyDesign();
});

document.getElementById('sidebarAuthBtn').addEventListener('click', () => {
  if (getValidToken()) return refreshDashboard();
  startGoogleLogin();
});
document.getElementById('topbarAuthBtn').addEventListener('click', () => {
  if (getValidToken()) return refreshDashboard();
  startGoogleLogin();
});
document.getElementById('gateLoginBtn').addEventListener('click', startGoogleLogin);
document.getElementById('gateSetupBtn').addEventListener('click', () => setView('setup'));
document.getElementById('setupLoginBtn').addEventListener('click', startGoogleLogin);

document.getElementById('logoutBtn').addEventListener('click', async () => {
  localStorage.removeItem(STORAGE_KEYS.token);
  localStorage.removeItem(STORAGE_KEYS.tokenExp);
  localStorage.removeItem(STORAGE_KEYS.user);
  await refreshDashboard();
});

document.getElementById('clearLocalBtn').addEventListener('click', async () => {
  Object.values(STORAGE_KEYS).forEach((k) => localStorage.removeItem(k));
  state.design = { ...DEFAULT_DESIGN, widgets: { ...DEFAULT_DESIGN.widgets } };
  applyDesign();
  document.getElementById('configMsg').textContent = 'Alle lokalen Browser-Daten wurden gelöscht.';
  await refreshDashboard();
});

document.getElementById('configForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  localStorage.setItem(STORAGE_KEYS.clientId, document.getElementById('clientIdInput').value.trim());
  document.getElementById('configMsg').textContent = 'Client ID lokal gespeichert! Du kannst dich jetzt anmelden.';
  await refreshDashboard();
});

// Design Customizer Events
document.querySelectorAll('#themePresets .chip').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.design.theme = btn.dataset.themeVal;
    saveAndApplyDesign();
  });
});
document.querySelectorAll('#accentPresets .color-dot').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.design.accent = btn.dataset.accent;
    saveAndApplyDesign();
  });
});
document.getElementById('customAccentInput').addEventListener('input', (e) => {
  state.design.accent = e.target.value;
  saveAndApplyDesign();
});
document.getElementById('radiusRange').addEventListener('input', (e) => {
  state.design.radius = Number(e.target.value);
  saveAndApplyDesign();
});
document.querySelectorAll('#densityPresets .chip').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.design.density = btn.dataset.density;
    saveAndApplyDesign();
  });
});
document.getElementById('glassToggle').addEventListener('change', (e) => {
  state.design.glass = e.target.checked;
  saveAndApplyDesign();
});
document.getElementById('topNavToggle').addEventListener('change', (e) => {
  state.design.topNav = e.target.checked;
  saveAndApplyDesign();
});
document.querySelectorAll('[data-widget-toggle]').forEach((cb) => {
  cb.addEventListener('change', () => {
    state.design.widgets[cb.dataset.widgetToggle] = cb.checked;
    saveAndApplyDesign();
  });
});
document.getElementById('goalStepsInput').addEventListener('change', (e) => {
  state.design.goalSteps = Math.max(1000, Number(e.target.value || 10000));
  saveAndApplyDesign();
  if (state.data) renderDashboard();
});
document.getElementById('goalSleepInput').addEventListener('change', (e) => {
  state.design.goalSleepHours = Math.max(4, Number(e.target.value || 8));
  saveAndApplyDesign();
  if (state.data) renderDashboard();
});
document.getElementById('resetDesignBtn').addEventListener('click', () => {
  state.design = { ...DEFAULT_DESIGN, widgets: { ...DEFAULT_DESIGN.widgets } };
  saveAndApplyDesign();
  if (state.data) renderDashboard();
});

// Takeout JSON Import
document.getElementById('takeoutInput').addEventListener('change', async (e) => {
  const files = Array.from(e.target.files || []);
  if (!files.length) return;
  const dayMap = new Map();
  const ensureDay = (date) => {
    if (!dayMap.has(date)) {
      dayMap.set(date, {
        date, steps: 0, calories: 0, activeCalories: 0, distanceKm: 0,
        hrAvg: null, hrMin: null, hrMax: null, restingHr: null, spo2: null,
        sleepMinutes: 0, sleepDeepMin: 0, sleepRemMin: 0, sleepLightMin: 0, sleepAwakeMin: 0, weightKg: null
      });
    }
    return dayMap.get(date);
  };

  for (const file of files) {
    try {
      const json = JSON.parse(await file.text());
      if (!Array.isArray(json)) continue;
      const name = file.name.toLowerCase();
      for (const item of json) {
        const dt = String(item.dateTime || item.startTime || item.dateOfSleep || '').slice(0, 10);
        if (!dt) continue;
        const d = ensureDay(dt);
        if (name.includes('steps') && item.value != null) d.steps += Number(item.value);
        if (name.includes('calories') && item.value != null) d.calories += Math.round(Number(item.value));
        if (name.includes('sleep') && item.minutesAsleep != null) d.sleepMinutes += Number(item.minutesAsleep);
        if (name.includes('resting_heart_rate') && item.value?.value != null) d.restingHr = Math.round(Number(item.value.value));
      }
    } catch {
      // Ignore unsupported JSON files
    }
  }

  const importedDays = Array.from(dayMap.values()).sort((a, b) => a.date.localeCompare(b.date));
  if (importedDays.length) {
    localStorage.setItem(STORAGE_KEYS.takeout, JSON.stringify({ source: 'takeout', days: importedDays, workouts: [], warnings: [] }));
    state.currentView = 'overview';
    await refreshDashboard();
  }
});

window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
  if (state.design.theme === 'system') applyDesign();
});

applyDesign();
refreshDashboard();
