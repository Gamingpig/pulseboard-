const STORAGE_KEYS = {
  clientId: 'pulseboard_client_id',
  token: 'pulseboard_access_token',
  tokenExp: 'pulseboard_token_exp',
  takeout: 'pulseboard_takeout_data',
  theme: 'pulseboard_theme'
};

const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly',
  'https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly',
  'https://www.googleapis.com/auth/googlehealth.sleep.readonly',
  'https://www.googleapis.com/auth/googlehealth.profile.readonly'
].join(' ');

const state = {
  days: 14,
  data: null,
  tokenClient: null
};

const VIEW_META = {
  overview: ['Übersicht', 'Deine wichtigsten Gesundheits- und Fitnesswerte'],
  activity: ['Aktivität & Schritte', 'Tägliche Bewegung, Distanz und Kalorien'],
  heart: ['Herz & Vitalwerte', 'Ruhepuls, Herzfrequenzbereich, SpO2 und Gewicht'],
  sleep: ['Schlafanalyse', 'Schlafdauer und Schlafphasen pro Nacht'],
  workouts: ['Workouts', 'Alle aufgezeichneten Trainingseinheiten'],
  setup: ['Google-Verbindung', '100% lokal im Browser — keine Daten auf fremden Servern']
};

const fmtNum = (n) => new Intl.NumberFormat('de-DE').format(Math.round(n || 0));
const fmtSleep = (mins) => `${Math.floor((mins || 0) / 60)}h ${Math.round((mins || 0) % 60)}m`;
const shortDate = (iso) => {
  const [y, m, d] = String(iso).slice(0, 10).split('-');
  return d && m ? `${d}.${m}.` : iso;
};
const toDayKey = (iso) => String(iso || '').slice(0, 10);

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
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === viewName));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${viewName}`));
  const [title, sub] = VIEW_META[viewName] || ['Dashboard', ''];
  document.getElementById('pageTitle').textContent = title;
  document.getElementById('pageSubtitle').textContent = sub;
}

function generateDemoData(numDays = 30) {
  const days = [];
  const today = new Date();
  today.setHours(12, 0, 0, 0);

  for (let i = numDays - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86400000);
    const date = d.toISOString().slice(0, 10);
    const seed = (i * 7 + d.getDay() * 13) % 100;
    const isWeekend = d.getDay() === 0 || d.getDay() === 6;

    const steps = Math.round((isWeekend ? 9800 : 7600) + Math.sin(i * 0.7) * 2600 + (seed - 50) * 35);
    const distanceKm = Number((steps * 0.00076).toFixed(2));
    const activeCalories = Math.round(steps * 0.045 + (seed % 4) * 55);
    const calories = 1650 + activeCalories;

    const sleepMinutes = Math.round((isWeekend ? 470 : 425) + Math.cos(i * 0.6) * 42);
    const sleepDeepMin = Math.round(sleepMinutes * 0.19);
    const sleepRemMin = Math.round(sleepMinutes * 0.22);
    const sleepAwakeMin = Math.round(sleepMinutes * 0.06);
    const sleepLightMin = Math.max(0, sleepMinutes - sleepDeepMin - sleepRemMin - sleepAwakeMin);

    const restingHr = Math.round(57 + Math.sin(i * 0.4) * 3);
    const hrAvg = Math.round(72 + Math.cos(i * 0.5) * 6);
    const hrMin = restingHr - 5;
    const hrMax = Math.round(138 + (seed % 32));
    const spo2 = Number((96.8 + (seed % 22) * 0.1).toFixed(1));
    const weightKg = Number((75.4 - (numDays - i) * 0.03 + Math.sin(i) * 0.2).toFixed(1));

    days.push({
      date,
      steps: Math.max(2200, steps),
      calories,
      activeCalories,
      distanceKm,
      hrAvg,
      hrMin,
      hrMax,
      restingHr,
      spo2,
      sleepMinutes,
      sleepDeepMin,
      sleepRemMin,
      sleepLightMin,
      sleepAwakeMin,
      weightKg
    });
  }

  const workoutTypes = ['Laufen', 'Krafttraining', 'Radfahren', 'Gehen', 'HIIT'];
  const workouts = [];
  for (let i = 0; i < Math.min(12, Math.floor(numDays / 2)); i++) {
    const day = days[days.length - 1 - i * 2];
    if (!day) continue;
    const type = workoutTypes[i % workoutTypes.length];
    const durationMin = 28 + ((i * 11) % 42);
    workouts.push({
      date: `${day.date}T17:30:00Z`,
      type,
      durationMin,
      calories: Math.round(durationMin * (type === 'Gehen' ? 5.2 : 9.6)),
      distanceKm: type === 'Laufen' || type === 'Radfahren' || type === 'Gehen'
        ? Number((durationMin * (type === 'Radfahren' ? 0.38 : 0.14)).toFixed(2))
        : 0
    });
  }

  return { source: 'demo', days, workouts, warnings: [] };
}

function getValidToken() {
  const token = localStorage.getItem(STORAGE_KEYS.token);
  const exp = Number(localStorage.getItem(STORAGE_KEYS.tokenExp) || 0);
  if (!token || Date.now() >= exp) return null;
  return token;
}

async function rollUpMetric(token, dataType, startTime, endTime) {
  const url = `https://health.googleapis.com/v4/users/me/dataTypes/${encodeURIComponent(dataType)}/dataPoints:rollUp`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ range: { startTime, endTime }, windowSize: '86400s' })
  });
  if (!res.ok) return { error: `${dataType}: HTTP ${res.status}`, rollupDataPoints: [] };
  return await res.json();
}

async function listDataPoints(token, dataType, startTime, endTime) {
  const params = new URLSearchParams({
    pageSize: '100',
    filter: `interval.start_time >= "${startTime}" AND interval.end_time <= "${endTime}"`
  });
  const url = `https://health.googleapis.com/v4/users/me/dataTypes/${encodeURIComponent(dataType)}/dataPoints?${params}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return { error: `${dataType}: HTTP ${res.status}`, dataPoints: [] };
  return await res.json();
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
    const e = dayMap.get(toDayKey(pt.interval?.startTime || pt.sample?.time));
    const bpm = pt.dailyRestingHeartRate?.beatsPerMinute;
    if (e && bpm != null) e.restingHr = Math.round(Number(bpm));
  }
  for (const pt of spo2Res.dataPoints || []) {
    const e = dayMap.get(toDayKey(pt.interval?.startTime || pt.sample?.time));
    const pct = pt.dailyOxygenSaturation?.averagePercentage ?? pt.dailyOxygenSaturation?.percentage;
    if (e && pct != null) e.spo2 = Number(Number(pct).toFixed(1));
  }
  for (const pt of weightRes.dataPoints || []) {
    const e = dayMap.get(toDayKey(pt.sample?.time || pt.interval?.startTime));
    const grams = pt.weight?.grams ?? (pt.weight?.kilograms != null ? Number(pt.weight.kilograms) * 1000 : null);
    if (e && grams != null) e.weightKg = Number((Number(grams) / 1000).toFixed(1));
  }
  for (const pt of sleepRes.dataPoints || []) {
    const sleep = pt.sleep || {};
    const startT = pt.interval?.startTime || sleep.startTime;
    const endT = pt.interval?.endTime || sleep.endTime;
    const e = dayMap.get(toDayKey(endT || startT));
    if (!e) continue;
    if (startT && endT) {
      e.sleepMinutes += Math.max(0, Math.round((new Date(endT) - new Date(startT)) / 60000));
    }
    for (const s of sleep.stages || sleep.sleepStages || []) {
      const sStart = s.interval?.startTime || s.startTime;
      const sEnd = s.interval?.endTime || s.endTime;
      if (!sStart || !sEnd) continue;
      const dur = Math.max(0, Math.round((new Date(sEnd) - new Date(sStart)) / 60000));
      const t = String(s.stageType || s.type || '').toUpperCase();
      if (t.includes('DEEP')) e.sleepDeepMin += dur;
      else if (t.includes('REM')) e.sleepRemMin += dur;
      else if (t.includes('LIGHT')) e.sleepLightMin += dur;
      else if (t.includes('AWAKE')) e.sleepAwakeMin += dur;
    }
  }

  const workouts = (exerciseRes.dataPoints || []).map((pt) => {
    const ex = pt.exercise || {};
    const startT = pt.interval?.startTime || ex.startTime;
    const endT = pt.interval?.endTime || ex.endTime;
    return {
      date: startT || '',
      type: ex.exerciseType || ex.displayName || 'Workout',
      durationMin: startT && endT ? Math.max(1, Math.round((new Date(endT) - new Date(startT)) / 60000)) : 0,
      calories: Math.round(Number(ex.calories?.kcal || ex.totalCalories || 0)),
      distanceKm: ex.distance?.millimeters ? Number((Number(ex.distance.millimeters) / 1e6).toFixed(2)) : 0
    };
  });

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
    goalLine = `<line x1="${padL}" y1="${gy}" x2="${w - padR}" y2="${gy}" stroke="rgba(255,255,255,0.22)" stroke-dasharray="4 4" />`;
  }

  const bars = days.map((d, i) => {
    const val = vals[i];
    const bh = Math.max(2, (val / maxVal) * chartH);
    const x = padL + i * step + (step - barW) / 2;
    const y = padT + chartH - bh;
    const showLabel = days.length <= 14 || i % Math.ceil(days.length / 8) === 0;
    return `
      <rect class="bar-rect" data-idx="${i}" x="${x}" y="${y}" width="${barW}" height="${bh}" rx="4" fill="${color}" opacity="0.88" style="cursor:pointer" />
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
  const minVal = allVals.length ? Math.floor(Math.min(...allVals) * 0.9) : 40;
  const maxVal = allVals.length ? Math.ceil(Math.max(...allVals) * 1.08) : 140;
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
    const dots = pts.map((p) => `<circle class="line-dot" data-date="${p.d.date}" data-label="${s.name}" data-val="${p.v}" cx="${p.x}" cy="${p.y}" r="3.5" fill="${s.color}" style="cursor:pointer"/>`).join('');
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
  const count = days.filter((d) => d.sleepMinutes > 0).length || 1;
  const deep = days.reduce((a, b) => a + (b.sleepDeepMin || 0), 0) / count;
  const rem = days.reduce((a, b) => a + (b.sleepRemMin || 0), 0) / count;
  const light = days.reduce((a, b) => a + (b.sleepLightMin || 0), 0) / count;
  const awake = days.reduce((a, b) => a + (b.sleepAwakeMin || 0), 0) / count;
  const total = Math.max(1, deep + rem + light + awake);

  const segments = [
    { label: 'Tiefschlaf', val: deep, color: '#6366f1' },
    { label: 'REM', val: rem, color: '#06b6d4' },
    { label: 'Leicht', val: light, color: '#818cf8' },
    { label: 'Wach', val: awake, color: '#f43f5e' }
  ];

  const r = 56, c = 2 * Math.PI * r;
  let offset = 0;
  const arcs = segments.map((s) => {
    const len = (s.val / total) * c;
    const arc = `<circle cx="75" cy="75" r="${r}" fill="none" stroke="${s.color}" stroke-width="18" stroke-dasharray="${len} ${c - len}" stroke-dashoffset="${-offset}" transform="rotate(-90 75 75)"/>`;
    offset += len;
    return arc;
  }).join('');

  el.innerHTML = `
    <svg viewBox="0 0 150 150" style="width:150px;height:150px;flex-shrink:0">
      ${arcs}
      <text x="75" y="79" text-anchor="middle" fill="var(--text)" font-size="14" font-weight="700">${fmtSleep(total)}</text>
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
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  };

  const avgSteps = avg((d) => d.steps);
  const avgSleep = avg((d) => d.sleepMinutes);
  const avgRhr = avg((d) => d.restingHr);
  const avgCal = avg((d) => d.calories);

  renderKpis('kpiGrid', [
    { label: 'Schritte (Heute)', value: fmtNum(latest.steps), sub: `Ø ${fmtNum(avgSteps)} / Tag`, color: 'var(--emerald)' },
    { label: 'Schlaf (Letzte Nacht)', value: fmtSleep(latest.sleepMinutes), sub: `Ø ${fmtSleep(avgSleep)}`, color: 'var(--indigo)' },
    { label: 'Ruhepuls', value: latest.restingHr ? `${latest.restingHr} bpm` : '—', sub: avgRhr ? `Ø ${Math.round(avgRhr)} bpm` : 'Keine Daten', color: 'var(--rose)' },
    { label: 'Kalorien (Heute)', value: `${fmtNum(latest.calories)} kcal`, sub: `Ø ${fmtNum(avgCal)} kcal`, color: 'var(--amber)' }
  ]);

  document.getElementById('stepsAvgBadge').textContent = `Ø ${fmtNum(avgSteps)}`;
  document.getElementById('sleepAvgBadge').textContent = `Ø ${fmtSleep(avgSleep)}`;
  document.getElementById('hrAvgBadge').textContent = avgRhr ? `Ø ${Math.round(avgRhr)} bpm` : '—';

  renderBarChart('overviewStepsChart', days, (d) => d.steps || 0, 'var(--emerald)', (d) => `<strong>${shortDate(d.date)}</strong><br/>${fmtNum(d.steps)} Schritte<br/>${d.distanceKm || 0} km`, 10000);
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
  renderKpis('activityKpis', [
    { label: 'Gesamt-Schritte', value: fmtNum(totalSteps), sub: `In ${days.length} Tagen`, color: 'var(--emerald)' },
    { label: 'Gesamt-Distanz', value: `${totalDist.toFixed(1)} km`, sub: `Ø ${(totalDist / Math.max(1, days.length)).toFixed(1)} km/Tag`, color: 'var(--cyan)' },
    { label: 'Aktiv-Kalorien (Ø)', value: `${fmtNum(avg((d) => d.activeCalories))} kcal`, sub: 'Pro Tag', color: 'var(--amber)' }
  ]);
  renderBarChart('activityStepsChart', days, (d) => d.steps || 0, 'var(--emerald)', (d) => `<strong>${shortDate(d.date)}</strong><br/>${fmtNum(d.steps)} Schritte · ${fmtNum(d.activeCalories)} kcal aktiv`, 10000);

  renderKpis('heartKpis', [
    { label: 'Aktueller Ruhepuls', value: latest.restingHr ? `${latest.restingHr} bpm` : '—', sub: `Ø ${Math.round(avgRhr)} bpm`, color: 'var(--rose)' },
    { label: 'Blutsauerstoff (SpO2)', value: latest.spo2 ? `${latest.spo2}%` : '—', sub: 'Letzter Messwert', color: 'var(--cyan)' },
    { label: 'Gewicht', value: latest.weightKg ? `${latest.weightKg} kg` : '—', sub: 'Letzter Messwert', color: 'var(--indigo)' }
  ]);
  renderLineChart('heartDetailChart', days, [
    { name: 'Max Puls', color: '#fb7185', get: (d) => d.hrMax },
    { name: 'Ø Puls', color: 'var(--amber)', get: (d) => d.hrAvg },
    { name: 'Ruhepuls', color: 'var(--rose)', get: (d) => d.restingHr }
  ]);

  renderKpis('sleepKpis', [
    { label: 'Ø Schlafdauer', value: fmtSleep(avgSleep), sub: `Über ${days.length} Nächte`, color: 'var(--indigo)' },
    { label: 'Ø Tiefschlaf', value: `${Math.round(avg((d) => d.sleepDeepMin))} min`, sub: 'Regeneration', color: '#6366f1' },
    { label: 'Ø REM-Schlaf', value: `${Math.round(avg((d) => d.sleepRemMin))} min`, sub: 'Erholung & Fokus', color: 'var(--cyan)' }
  ]);
  renderBarChart('sleepDetailChart', days, (d) => (d.sleepMinutes || 0) / 60, 'var(--indigo)', (d) => `<strong>${shortDate(d.date)}</strong><br/>${fmtSleep(d.sleepMinutes)}<br/>Tief: ${d.sleepDeepMin}m · REM: ${d.sleepRemMin}m`, 8);

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

async function refreshDashboard() {
  const clientId = localStorage.getItem(STORAGE_KEYS.clientId) || '';
  document.getElementById('clientIdInput').value = clientId;
  document.getElementById('originUriCode').textContent = window.location.origin;

  const badge = document.getElementById('statusBadge');
  const accText = document.getElementById('accountText');
  const authBtn = document.getElementById('sidebarAuthBtn');
  const logoutBtn = document.getElementById('logoutBtn');

  const token = getValidToken();
  const savedTakeout = localStorage.getItem(STORAGE_KEYS.takeout);

  if (token) {
    badge.textContent = 'Google Health Live';
    badge.className = 'badge badge-live';
    accText.textContent = 'Verbunden. Daten werden nur lokal im Browser angezeigt.';
    authBtn.textContent = 'Daten aktualisieren';
    logoutBtn.classList.remove('hidden');
    state.data = await fetchGoogleHealthData(token, state.days);
  } else if (savedTakeout) {
    const parsed = JSON.parse(savedTakeout);
    state.data = { ...parsed, days: (parsed.days || []).slice(-state.days) };
    badge.textContent = 'Lokaler Import';
    badge.className = 'badge badge-demo';
    accText.textContent = 'Importierte Daten lokal im Browser gespeichert.';
    authBtn.textContent = 'Mit Google anmelden';
    logoutBtn.classList.add('hidden');
  } else {
    badge.textContent = 'Demo-Modus';
    badge.className = 'badge badge-demo';
    accText.textContent = clientId
      ? 'Client ID gespeichert. Jetzt mit Google anmelden.'
      : 'Alle Daten bleiben lokal in deinem Browser (localStorage).';
    authBtn.textContent = 'Mit Google anmelden';
    logoutBtn.classList.add('hidden');
    state.data = generateDemoData(state.days);
  }

  renderDashboard();
}

function startGoogleLogin() {
  const clientId = localStorage.getItem(STORAGE_KEYS.clientId);
  if (!clientId) {
    setView('setup');
    document.getElementById('configMsg').textContent = 'Bitte zuerst deine Google Client ID speichern.';
    return;
  }
  if (!window.google?.accounts?.oauth2) {
    document.getElementById('configMsg').textContent = 'Google Identity Script lädt noch oder ist blockiert.';
    return;
  }
  state.tokenClient = window.google.accounts.oauth2.initTokenClient({
    client_id: clientId,
    scope: GOOGLE_SCOPES,
    callback: async (resp) => {
      if (resp.error) {
        document.getElementById('configMsg').textContent = `Fehler: ${resp.error}`;
        return;
      }
      localStorage.setItem(STORAGE_KEYS.token, resp.access_token);
      localStorage.setItem(STORAGE_KEYS.tokenExp, String(Date.now() + (Number(resp.expires_in || 3600) - 60) * 1000));
      await refreshDashboard();
      setView('overview');
    }
  });
  state.tokenClient.requestAccessToken({ prompt: 'consent' });
}

// Event Listeners
document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => setView(btn.dataset.view));
});

document.querySelectorAll('#rangeSelector .seg-btn').forEach((btn) => {
  btn.addEventListener('click', async () => {
    document.querySelectorAll('#rangeSelector .seg-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.days = Number(btn.dataset.days);
    await refreshDashboard();
  });
});

const savedTheme = localStorage.getItem(STORAGE_KEYS.theme);
if (savedTheme) document.documentElement.dataset.theme = savedTheme;

document.getElementById('themeToggle').addEventListener('click', () => {
  const html = document.documentElement;
  html.dataset.theme = html.dataset.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem(STORAGE_KEYS.theme, html.dataset.theme);
});

document.getElementById('sidebarAuthBtn').addEventListener('click', () => {
  if (getValidToken()) return refreshDashboard();
  startGoogleLogin();
});

document.getElementById('setupLoginBtn').addEventListener('click', startGoogleLogin);

document.getElementById('logoutBtn').addEventListener('click', async () => {
  localStorage.removeItem(STORAGE_KEYS.token);
  localStorage.removeItem(STORAGE_KEYS.tokenExp);
  await refreshDashboard();
});

document.getElementById('clearLocalBtn').addEventListener('click', async () => {
  Object.values(STORAGE_KEYS).forEach((k) => localStorage.removeItem(k));
  document.getElementById('configMsg').textContent = 'Alle lokalen Browser-Daten wurden gelöscht.';
  await refreshDashboard();
});

document.getElementById('configForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const clientId = document.getElementById('clientIdInput').value.trim();
  localStorage.setItem(STORAGE_KEYS.clientId, clientId);
  document.getElementById('configMsg').textContent = 'Client ID lokal gespeichert! Du kannst dich jetzt anmelden.';
  await refreshDashboard();
});

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
    await refreshDashboard();
  }
});

refreshDashboard();
