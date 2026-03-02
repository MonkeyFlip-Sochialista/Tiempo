/**
 * WeatherNow – Core Application
 * Optimized: cached DOM, AbortController, DocumentFragment, Map/Set, requestIdleCallback
 * Feature: Custom Range Forecast (date + hour range filter)
 */

'use strict';

// ── WMO code map ───────────────────────────────────────
const WMO = new Map([
    [0, { icon: '☀️', label: 'Clear sky' }],
    [1, { icon: '🌤️', label: 'Mainly clear' }],
    [2, { icon: '⛅', label: 'Partly cloudy' }],
    [3, { icon: '☁️', label: 'Overcast' }],
    [45, { icon: '🌫️', label: 'Fog' }],
    [48, { icon: '🌫️', label: 'Icy fog' }],
    [51, { icon: '🌦️', label: 'Light drizzle' }],
    [53, { icon: '🌦️', label: 'Moderate drizzle' }],
    [55, { icon: '🌧️', label: 'Dense drizzle' }],
    [61, { icon: '🌧️', label: 'Slight rain' }],
    [63, { icon: '🌧️', label: 'Moderate rain' }],
    [65, { icon: '🌧️', label: 'Heavy rain' }],
    [71, { icon: '🌨️', label: 'Slight snow' }],
    [73, { icon: '🌨️', label: 'Moderate snow' }],
    [75, { icon: '❄️', label: 'Heavy snow' }],
    [77, { icon: '🌨️', label: 'Snow grains' }],
    [80, { icon: '🌦️', label: 'Slight showers' }],
    [81, { icon: '🌧️', label: 'Moderate showers' }],
    [82, { icon: '⛈️', label: 'Violent showers' }],
    [85, { icon: '🌨️', label: 'Snow showers' }],
    [86, { icon: '❄️', label: 'Heavy snow showers' }],
    [95, { icon: '⛈️', label: 'Thunderstorm' }],
    [96, { icon: '⛈️', label: 'Thunderstorm + hail' }],
    [99, { icon: '⛈️', label: 'Severe thunderstorm' }],
]);

const RAIN_CODES = new Set([51, 53, 55, 61, 63, 65, 80, 81, 82]);
const SNOW_CODES = new Set([71, 73, 75, 77, 85, 86]);
const STORM_CODES = new Set([95, 96, 99]);
const wmo = code => WMO.get(code) ?? { icon: '🌡️', label: 'Unknown' };

// ── State ──────────────────────────────────────────────
const state = { loc: null, weather: null, unit: 'C' };

// ── Pure helpers ───────────────────────────────────────
const toF = c => Math.round(c * 9 / 5 + 32);
const dispT = c => state.unit === 'F' ? toF(c) : Math.round(c);
const unitSym = () => `°${state.unit}`;

/**
 * Returns a local-time prefix string "YYYY-MM-DDTHH" that matches
 * the format Open-Meteo returns (already in the location's local timezone).
 * We build it manually from local Date parts to avoid UTC conversion bugs.
 */
function localHourPrefix(date) {
    const Y = date.getFullYear();
    const M = String(date.getMonth() + 1).padStart(2, '0');
    const D = String(date.getDate()).padStart(2, '0');
    const H = String(date.getHours()).padStart(2, '0');
    return `${Y}-${M}-${D}T${H}`;
}

function fmtTime(iso) {
    if (!iso) return '–';
    return new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
}
function fmtHour(h) { return `${h % 12 || 12}${h >= 12 ? 'PM' : 'AM'}`; }
function fmtDateShort(d) { return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); }

function uvLabel(uv) {
    if (uv <= 2) return `${uv} Low`;
    if (uv <= 5) return `${uv} Moderate`;
    if (uv <= 7) return `${uv} High`;
    if (uv <= 10) return `${uv} Very High`;
    return `${uv} Extreme`;
}
function uvDesc(uv) {
    if (uv <= 2) return 'No protection needed';
    if (uv <= 5) return 'Some protection';
    if (uv <= 7) return 'Wear SPF 30+';
    if (uv <= 10) return 'Extra protection';
    return 'Avoid outdoors';
}
function humLabel(h) { return h < 30 ? 'Dry' : h < 60 ? 'Comfortable' : h < 80 ? 'Humid' : 'Very humid'; }
function visLabel(v) {
    const km = v / 1000;
    return km >= 10 ? 'Excellent' : km >= 5 ? 'Good' : km >= 2 ? 'Moderate' : 'Poor';
}
function windDir(deg) {
    return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(deg / 45) % 8] + ' wind';
}

// ── Cached DOM refs ─────────────────────────────────────
let dom = {};

// ── Fetch controller & search timer ───────────────────
let fetchCtrl = null;
let searchTimer = null;

// ── Toast ──────────────────────────────────────────────
let toastTimer = null;
function toast(msg, type = '') {
    clearTimeout(toastTimer);
    dom.toast.textContent = msg;
    dom.toast.className = `toast show ${type}`;
    toastTimer = setTimeout(() => { dom.toast.className = 'toast'; }, 3200);
}

// ── State visibility ───────────────────────────────────
function showState(id) {
    dom.stateWelcome.hidden = id !== 'welcome';
    dom.stateLoading.hidden = id !== 'loading';
    dom.stateWeather.hidden = id !== 'weather';
}

// ── Animated background ────────────────────────────────
function spawnParticles() {
    const frag = document.createDocumentFragment();
    for (let i = 0; i < 28; i++) {
        const p = document.createElement('div');
        p.className = 'particle';
        const sz = Math.random() * 3 + 1;
        p.style.cssText = `left:${Math.random() * 100}%;width:${sz}px;height:${sz}px;`
            + `animation-duration:${Math.random() * 20 + 13}s;animation-delay:${Math.random() * 20}s;`
            + `opacity:${Math.random() * .5 + .1}`;
        frag.appendChild(p);
    }
    dom.particles.appendChild(frag);
}

function setBg(code) {
    dom.bgOverlay.innerHTML = '';
    let bgStyle = '';

    if (RAIN_CODES.has(code)) {
        bgStyle = 'radial-gradient(ellipse 80% 60% at 30% 0%,rgba(30,60,100,.7) 0%,transparent 70%),'
            + 'linear-gradient(160deg,#040810 0%,#070b18 100%)';
        const frag = document.createDocumentFragment();
        for (let i = 0; i < 80; i++) {
            const d = document.createElement('div');
            d.className = 'rain';
            d.style.cssText = `left:${Math.random() * 100}%;height:${Math.random() * 70 + 40}px;`
                + `animation-duration:${(Math.random() * .6 + .4).toFixed(2)}s;`
                + `animation-delay:${(Math.random() * 2).toFixed(2)}s;`
                + `opacity:${(Math.random() * .4 + .2).toFixed(2)}`;
            frag.appendChild(d);
        }
        dom.bgOverlay.appendChild(frag);

    } else if (SNOW_CODES.has(code)) {
        bgStyle = 'radial-gradient(ellipse 80% 60% at 20% 10%,rgba(100,120,180,.4) 0%,transparent 60%),'
            + 'linear-gradient(160deg,#0d1020 0%,#10141e 100%)';
        const flakes = ['❄', '❅', '❆', '✼'];
        const frag = document.createDocumentFragment();
        for (let i = 0; i < 38; i++) {
            const f = document.createElement('div');
            f.className = 'snow';
            f.textContent = flakes[i % flakes.length];
            const sz = Math.random() * 10 + 8;
            f.style.cssText = `left:${Math.random() * 100}%;font-size:${sz}px;`
                + `animation-duration:${(Math.random() * 8 + 5).toFixed(1)}s;`
                + `animation-delay:${(Math.random() * 8).toFixed(1)}s`;
            frag.appendChild(f);
        }
        dom.bgOverlay.appendChild(frag);

    } else if (STORM_CODES.has(code)) {
        bgStyle = 'radial-gradient(ellipse 80% 60% at 30% 0%,rgba(50,30,80,.8) 0%,transparent 70%),'
            + 'linear-gradient(160deg,#050306 0%,#0a0614 100%)';
    } else if (code === 0) {
        bgStyle = 'radial-gradient(ellipse 70% 50% at 68% 10%,rgba(255,190,50,.14) 0%,transparent 60%),'
            + 'radial-gradient(ellipse 60% 50% at 20% 80%,rgba(99,79,210,.45) 0%,transparent 60%),'
            + 'linear-gradient(160deg,#0d0d1a 0%,#0a0d20 50%,#060810 100%)';
    } else {
        bgStyle = 'radial-gradient(ellipse 80% 60% at 20% 10%,rgba(99,79,210,.45) 0%,transparent 60%),'
            + 'radial-gradient(ellipse 60% 50% at 80% 80%,rgba(14,110,187,.35) 0%,transparent 60%),'
            + 'linear-gradient(160deg,#0d0d1a 0%,#0a0d20 50%,#060810 100%)';
    }

    dom.bgGrad.style.background = bgStyle;
}

// ── Geocoding ──────────────────────────────────────────
async function searchCities(q) {
    if (!q || q.length < 2) { hideSugg(); return; }
    if (fetchCtrl) fetchCtrl.abort();
    fetchCtrl = new AbortController();
    try {
        const res = await fetch(
            `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=6&language=en&format=json`,
            { signal: fetchCtrl.signal }
        );
        const data = await res.json();
        data.results?.length ? showSugg(data.results) : hideSugg();
    } catch (e) {
        if (e.name !== 'AbortError') hideSugg();
    }
}

function showSugg(results) {
    const frag = document.createDocumentFragment();
    dom.suggestions.innerHTML = '';
    results.forEach(r => {
        const li = document.createElement('li');
        li.className = 'sugg-item';
        li.setAttribute('role', 'option');
        li.innerHTML =
            `<span aria-hidden="true">📍</span>`
            + `<span><span class="sugg-name">${r.name}</span>`
            + `<span class="sugg-sub">${[r.admin1, r.country].filter(Boolean).join(', ')}</span></span>`
            + `<span class="sugg-flag" aria-hidden="true">${countryFlag(r.country_code)}</span>`;
        li.addEventListener('click', () => pickCity(r));
        frag.appendChild(li);
    });
    dom.suggestions.appendChild(frag);
    dom.suggestions.removeAttribute('hidden');
    dom.searchBox.setAttribute('aria-expanded', 'true');
}

function hideSugg() {
    dom.suggestions.hidden = true;
    dom.searchBox.setAttribute('aria-expanded', 'false');
}

function countryFlag(code) {
    if (!code) return '🌍';
    try { return [...code.toUpperCase()].map(c => String.fromCodePoint(127397 + c.charCodeAt(0))).join(''); }
    catch { return '🌍'; }
}

function pickCity(r) {
    state.loc = {
        name: r.name, admin1: r.admin1 || '', country: r.country || '',
        lat: r.latitude, lon: r.longitude, timezone: r.timezone || 'auto',
    };
    dom.cityInput.value = r.name;
    dom.btnClear.hidden = false;
    hideSugg();
    fetchWeather();
}

// ── Fetch weather ──────────────────────────────────────
async function fetchWeather() {
    if (!state.loc) return;
    if (fetchCtrl) fetchCtrl.abort();
    fetchCtrl = new AbortController();

    showState('loading');
    dom.loadingText.textContent = `Fetching weather for ${state.loc.name}…`;

    const { lat, lon, timezone } = state.loc;
    const url =
        `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&timezone=${timezone}`
        + `&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,`
        + `weather_code,surface_pressure,wind_speed_10m,wind_direction_10m,uv_index,visibility`
        + `&hourly=temperature_2m,weather_code,precipitation_probability,relative_humidity_2m`
        + `&daily=weather_code,temperature_2m_max,temperature_2m_min,`
        + `precipitation_sum,precipitation_probability_max,sunrise,sunset,uv_index_max,wind_speed_10m_max`
        + `&forecast_days=7`;

    try {
        const res = await fetch(url, { signal: fetchCtrl.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        state.weather = await res.json();
        render(state.weather);
        initRangePicker(state.weather);
        showState('weather');
        setBg(state.weather.current.weather_code);
    } catch (e) {
        if (e.name === 'AbortError') return;
        showState('welcome');
        toast('❌ Could not load weather. Check your connection.', 'err');
    }
}

// ── Main render ────────────────────────────────────────
function render(data) {
    const c = data.current, d = data.daily, h = data.hourly;
    const w = wmo(c.weather_code);

    dom.curCity.textContent = state.loc.name;
    dom.curCountry.textContent = [state.loc.admin1, state.loc.country].filter(Boolean).join(', ');
    dom.curUpdated.textContent = `Updated ${new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`;
    dom.curIcon.textContent = w.icon;
    dom.curTemp.textContent = dispT(c.temperature_2m);
    dom.curUnit.textContent = unitSym();
    dom.curDesc.textContent = w.label;
    dom.curFeels.textContent = `Feels like ${dispT(c.apparent_temperature)}${unitSym()}`;
    dom.sHumidity.textContent = `${c.relative_humidity_2m}%`;
    dom.sWind.textContent = `${Math.round(c.wind_speed_10m)} km/h`;
    dom.sVisibility.textContent = `${(c.visibility / 1000).toFixed(1)} km`;
    dom.sUV.textContent = uvLabel(c.uv_index);
    dom.sSunrise.textContent = fmtTime(d.sunrise[0]);
    dom.sSunset.textContent = fmtTime(d.sunset[0]);

    renderHourly(h);
    renderDaily(d);
    renderDetails(c, d);
}

// ── Hourly forecast ────────────────────────────────────
/**
 * Finds the current hour by comparing the "YYYY-MM-DDTHH" prefix of the
 * API's local-time strings against the device's local time parts.
 * This avoids all UTC/timezone conversion bugs.
 */
function renderHourly(h) {
    const now = new Date();
    const prefix = localHourPrefix(now);   // e.g. "2026-03-02T10"

    // Find the index whose time string starts with the current local hour prefix
    let startIdx = 0;
    for (let i = 0; i < h.time.length; i++) {
        if (h.time[i] >= prefix) {
            startIdx = i;
            break;
        }
    }

    const frag = document.createDocumentFragment();
    const endIdx = Math.min(startIdx + 24, h.time.length);

    for (let i = startIdx; i < endIdx; i++) {
        const timeStr = h.time[i];                    // "2026-03-02T10:00"
        const hour = parseInt(timeStr.slice(11, 13), 10);
        const isNow = i === startIdx;
        const w = wmo(h.weather_code[i]);
        const prec = h.precipitation_probability[i];

        const el = document.createElement('div');
        el.className = `hour${isNow ? ' now' : ''}`;
        el.setAttribute('role', 'listitem');
        el.innerHTML =
            `<span class="hour-time">${isNow ? 'Now' : fmtHour(hour)}</span>`
            + `<span class="hour-icon" aria-hidden="true">${w.icon}</span>`
            + `<span class="hour-temp">${dispT(h.temperature_2m[i])}°</span>`
            + (prec > 10 ? `<span class="hour-rain">💧${prec}%</span>` : '');
        frag.appendChild(el);
    }

    dom.hourlyStrip.innerHTML = '';
    dom.hourlyStrip.appendChild(frag);
    dom.hourlyStrip.querySelector('.now')?.scrollIntoView({
        behavior: 'smooth', block: 'nearest', inline: 'center',
    });
}

// ── Daily forecast ─────────────────────────────────────
function renderDaily(d) {
    const today = new Date().toDateString();
    const frag = document.createDocumentFragment();
    for (let i = 0; i < 7; i++) {
        const date = new Date(d.time[i] + 'T12:00'); // force local noon to avoid DST shift
        const isToday = date.toDateString() === today;
        const w = wmo(d.weather_code[i]);
        const prec = d.precipitation_probability_max[i];
        const li = document.createElement('li');
        li.className = `day${isToday ? ' today' : ''}`;
        li.innerHTML =
            `<span class="day-name">${isToday ? 'Today' : date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}</span>`
            + `<span class="day-icon" aria-hidden="true">${w.icon}</span>`
            + `<span class="day-desc">${w.label}${prec > 0 ? ` · 💧${prec}%` : ''}</span>`
            + `<span class="day-temps"><span class="day-max">${dispT(d.temperature_2m_max[i])}°</span>`
            + `<span class="day-min">${dispT(d.temperature_2m_min[i])}°</span></span>`;
        frag.appendChild(li);
    }
    dom.dailyList.innerHTML = '';
    dom.dailyList.appendChild(frag);
}

// ── Atmospheric details ────────────────────────────────
function renderDetails(c, d) {
    const items = [
        { icon: '🌡️', label: 'Temperature', val: `${dispT(c.temperature_2m)}${unitSym()}`, sub: `Feels ${dispT(c.apparent_temperature)}°` },
        { icon: '💧', label: 'Humidity', val: `${c.relative_humidity_2m}%`, sub: humLabel(c.relative_humidity_2m) },
        { icon: '☁️', label: 'Pressure', val: `${Math.round(c.surface_pressure)} hPa`, sub: 'Atmospheric' },
        { icon: '💨', label: 'Wind', val: `${Math.round(c.wind_speed_10m)} km/h`, sub: windDir(c.wind_direction_10m) },
        { icon: '☀️', label: 'UV Index', val: `${c.uv_index}`, sub: uvDesc(c.uv_index) },
        { icon: '🌧️', label: 'Precipitation', val: `${c.precipitation} mm`, sub: 'Current hour' },
        { icon: '👁️', label: 'Visibility', val: `${(c.visibility / 1000).toFixed(1)} km`, sub: visLabel(c.visibility) },
        { icon: '📈', label: 'Today High', val: `${dispT(d.temperature_2m_max[0])}${unitSym()}`, sub: 'Daily maximum' },
        { icon: '📉', label: 'Today Low', val: `${dispT(d.temperature_2m_min[0])}${unitSym()}`, sub: 'Daily minimum' },
        { icon: '🌅', label: 'Sunrise', val: fmtTime(d.sunrise[0]), sub: 'Local time' },
        { icon: '🌇', label: 'Sunset', val: fmtTime(d.sunset[0]), sub: 'Local time' },
        { icon: '🌬️', label: 'Max Wind', val: `${Math.round(d.wind_speed_10m_max[0])} km/h`, sub: "Today's peak" },
    ];
    const frag = document.createDocumentFragment();
    items.forEach(({ icon, label, val, sub }) => {
        const div = document.createElement('div');
        div.className = 'det';
        div.innerHTML =
            `<div class="det-icon" aria-hidden="true">${icon}</div>`
            + `<dt>${label}</dt>`
            + `<dd class="det-val">${val}</dd>`
            + `<dd class="det-sub">${sub}</dd>`;
        frag.appendChild(div);
    });
    dom.detailsGrid.innerHTML = '';
    dom.detailsGrid.appendChild(frag);
}

// ════════════════════════════════════════════════════════
// CUSTOM RANGE FORECAST
// ════════════════════════════════════════════════════════

function initRangePicker(data) {
    const times = data.hourly.time;
    const firstDate = times[0].slice(0, 10);
    const lastDate = times[times.length - 1].slice(0, 10);

    dom.fromDate.min = dom.toDate.min = firstDate;
    dom.fromDate.max = dom.toDate.max = lastDate;
    dom.fromDate.value = firstDate;
    dom.toDate.value = lastDate;

    const hourOpts = Array.from({ length: 24 }, (_, h) =>
        `<option value="${h}">${fmtHour(h)}</option>`
    ).join('');

    dom.fromHour.innerHTML = hourOpts;
    dom.toHour.innerHTML = hourOpts;
    dom.fromHour.value = '6';
    dom.toHour.value = '21';

    dom.rangeResults.hidden = true;
    dom.rangeEmpty.hidden = true;
}

function applyRange() {
    if (!state.weather) return;

    const h = state.weather.hourly;
    const fromDate = dom.fromDate.value;
    const toDate = dom.toDate.value;
    const fromH = parseInt(dom.fromHour.value, 10);
    const toH = parseInt(dom.toHour.value, 10);

    if (!fromDate || !toDate) { toast('Please select both dates.', 'err'); return; }

    // Build local-time prefix strings to compare directly against API strings
    const fromPrefix = `${fromDate}T${String(fromH).padStart(2, '0')}`;
    const toPrefix = `${toDate}T${String(toH).padStart(2, '0')}`;

    if (fromPrefix > toPrefix) { toast('Start must be before end.', 'err'); return; }

    const entries = [];
    for (let i = 0; i < h.time.length; i++) {
        const t = h.time[i]; // "YYYY-MM-DDTHH:00"
        if (t >= fromPrefix && t <= toPrefix + ':59') {
            entries.push({
                time: h.time[i],
                temp: h.temperature_2m[i],
                code: h.weather_code[i],
                prec: h.precipitation_probability[i],
                hum: h.relative_humidity_2m[i],
            });
        }
    }

    dom.rangeResults.hidden = true;
    dom.rangeEmpty.hidden = true;

    if (entries.length === 0) {
        dom.rangeEmpty.hidden = false;
        dom.rangeEmpty.textContent = '⚠️ No data in this range. Forecast covers 7 days from today.';
        return;
    }

    // Summary stats
    const temps = entries.map(e => e.temp);
    const avgT = temps.reduce((a, b) => a + b, 0) / temps.length;
    const maxT = Math.max(...temps);
    const minT = Math.min(...temps);
    const avgPr = Math.round(entries.map(e => e.prec).reduce((a, b) => a + b, 0) / entries.length);
    const avgHu = Math.round(entries.map(e => e.hum).reduce((a, b) => a + b, 0) / entries.length);
    const codeFreq = new Map();
    entries.forEach(e => codeFreq.set(e.code, (codeFreq.get(e.code) || 0) + 1));
    const domCode = [...codeFreq.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const domW = wmo(domCode);

    const chips = [
        { icon: domW.icon, label: 'Dominant', val: domW.label },
        { icon: '🌡️', label: 'Avg Temp', val: `${dispT(avgT)}${unitSym()}` },
        { icon: '📈', label: 'Max', val: `${dispT(maxT)}${unitSym()}` },
        { icon: '📉', label: 'Min', val: `${dispT(minT)}${unitSym()}` },
        { icon: '💧', label: 'Rain', val: `${avgPr}%` },
        { icon: '🌢️', label: 'Humidity', val: `${avgHu}%` },
        { icon: '🕐', label: 'Hours', val: `${entries.length}h` },
    ];

    const sumFrag = document.createDocumentFragment();
    chips.forEach(({ icon, label, val }) => {
        const span = document.createElement('div');
        span.className = 'range-summary-chip';
        span.innerHTML =
            `<span class="chip-icon" aria-hidden="true">${icon}</span>`
            + `<span>${label}</span>`
            + `<span class="chip-val">${val}</span>`;
        sumFrag.appendChild(span);
    });
    dom.rangeSummary.innerHTML = '';
    dom.rangeSummary.appendChild(sumFrag);

    // Hour cards
    const hourFrag = document.createDocumentFragment();
    let lastDay = '';
    entries.forEach(entry => {
        const hour = parseInt(entry.time.slice(11, 13), 10);
        const dateD = new Date(entry.time + ':00');
        const dayStr = fmtDateShort(dateD);
        const w = wmo(entry.code);
        const card = document.createElement('div');
        card.className = 'range-hour-card';
        card.setAttribute('role', 'listitem');
        card.innerHTML =
            (dayStr !== lastDay ? `<span class="rh-date">${dayStr}</span>` : `<span class="rh-date"></span>`)
            + `<span class="rh-time">${fmtHour(hour)}</span>`
            + `<span class="rh-icon" aria-hidden="true">${w.icon}</span>`
            + `<span class="rh-temp">${dispT(entry.temp)}°</span>`
            + (entry.prec > 10 ? `<span class="rh-rain">💧${entry.prec}%</span>` : '')
            + `<span class="rh-hum">💧${entry.hum}%</span>`;
        lastDay = dayStr;
        hourFrag.appendChild(card);
    });
    dom.rangeHours.innerHTML = '';
    dom.rangeHours.appendChild(hourFrag);

    dom.rangeResults.hidden = false;
    dom.rangeResults.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ── Init ────────────────────────────────────────────────
function init() {
    dom = {
        bgGrad: document.getElementById('bgGrad'),
        particles: document.getElementById('particles'),
        bgOverlay: document.getElementById('bgOverlay'),
        btnUnit: document.getElementById('btnUnit'),
        cityInput: document.getElementById('cityInput'),
        searchBox: document.querySelector('.search-box'),
        suggestions: document.getElementById('suggestions'),
        btnClear: document.getElementById('btnClear'),
        btnGo: document.getElementById('btnGo'),
        btnLocate: document.getElementById('btnLocate'),
        stateWelcome: document.getElementById('stateWelcome'),
        stateLoading: document.getElementById('stateLoading'),
        stateWeather: document.getElementById('stateWeather'),
        loadingText: document.getElementById('loadingText'),
        toast: document.getElementById('toast'),
        curCity: document.getElementById('curCity'),
        curCountry: document.getElementById('curCountry'),
        curUpdated: document.getElementById('curUpdated'),
        curIcon: document.getElementById('curIcon'),
        curTemp: document.getElementById('curTemp'),
        curUnit: document.getElementById('curUnit'),
        curDesc: document.getElementById('curDesc'),
        curFeels: document.getElementById('curFeels'),
        sHumidity: document.getElementById('sHumidity'),
        sWind: document.getElementById('sWind'),
        sVisibility: document.getElementById('sVisibility'),
        sUV: document.getElementById('sUV'),
        sSunrise: document.getElementById('sSunrise'),
        sSunset: document.getElementById('sSunset'),
        hourlyStrip: document.getElementById('hourlyStrip'),
        dailyList: document.getElementById('dailyList'),
        detailsGrid: document.getElementById('detailsGrid'),
        fromDate: document.getElementById('fromDate'),
        toDate: document.getElementById('toDate'),
        fromHour: document.getElementById('fromHour'),
        toHour: document.getElementById('toHour'),
        btnRange: document.getElementById('btnRange'),
        rangeResults: document.getElementById('rangeResults'),
        rangeSummary: document.getElementById('rangeSummary'),
        rangeHours: document.getElementById('rangeHours'),
        rangeEmpty: document.getElementById('rangeEmpty'),
    };

    spawnParticles();
    hideSugg();

    // Unit toggle
    dom.btnUnit.addEventListener('click', () => {
        state.unit = state.unit === 'C' ? 'F' : 'C';
        dom.btnUnit.textContent = `°${state.unit}`;
        if (state.weather) render(state.weather);
        toast(`Switched to °${state.unit}`);
    });

    // Search input
    dom.cityInput.addEventListener('input', () => {
        const v = dom.cityInput.value.trim();
        dom.btnClear.hidden = !v;
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => searchCities(v), 300);
    });
    dom.cityInput.addEventListener('keydown', e => {
        if (e.key === 'Escape') { hideSugg(); return; }
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const first = dom.suggestions.querySelector('.sugg-item');
        if (first) first.click();
        else {
            const v = dom.cityInput.value.trim();
            if (v) searchCities(v).then(() => setTimeout(() => dom.suggestions.querySelector('.sugg-item')?.click(), 380));
        }
    });
    dom.btnGo.addEventListener('click', () => {
        const v = dom.cityInput.value.trim();
        if (!v) return;
        searchCities(v).then(() => setTimeout(() => dom.suggestions.querySelector('.sugg-item')?.click(), 380));
    });
    dom.btnClear.addEventListener('click', () => {
        dom.cityInput.value = '';
        dom.btnClear.hidden = true;
        hideSugg();
        dom.cityInput.focus();
    });

    document.addEventListener('click', e => {
        if (!e.target.closest('.search-wrap')) hideSugg();
    }, { passive: true });

    // Quick chips
    document.querySelectorAll('.chip').forEach(chip => {
        chip.addEventListener('click', () => {
            dom.cityInput.value = chip.dataset.city;
            dom.btnClear.hidden = false;
            searchCities(chip.dataset.city).then(() =>
                setTimeout(() => dom.suggestions.querySelector('.sugg-item')?.click(), 400)
            );
        });
    });

    // Geolocation
    dom.btnLocate.addEventListener('click', () => {
        if (!navigator.geolocation) { toast('Geolocation not supported', 'err'); return; }
        dom.btnLocate.style.opacity = '.45';
        showState('loading');
        dom.loadingText.textContent = 'Getting your location…';
        navigator.geolocation.getCurrentPosition(async pos => {
            dom.btnLocate.style.opacity = '1';
            const { latitude: lat, longitude: lon } = pos.coords;
            try {
                const res = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json`);
                const data = await res.json();
                const addr = data.address ?? {};
                state.loc = {
                    name: addr.city || addr.town || addr.village || 'My Location',
                    admin1: addr.state || '', country: addr.country || '',
                    lat, lon, timezone: 'auto',
                };
            } catch {
                state.loc = { name: 'My Location', admin1: '', country: '', lat, lon, timezone: 'auto' };
            }
            dom.cityInput.value = state.loc.name;
            dom.btnClear.hidden = false;
            fetchWeather();
        }, () => {
            dom.btnLocate.style.opacity = '1';
            showState('welcome');
            toast('Location access denied.', 'err');
        }, { timeout: 10_000 });
    });

    // Range picker
    dom.btnRange.addEventListener('click', applyRange);

    // Auto-refresh every 10 min
    const refresh = () => { if (state.loc) fetchWeather(); };
    setInterval(() => {
        if ('requestIdleCallback' in window) requestIdleCallback(refresh, { timeout: 5000 });
        else refresh();
    }, 10 * 60 * 1000);
}

document.addEventListener('DOMContentLoaded', init, { once: true });
