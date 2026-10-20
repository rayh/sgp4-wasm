/**
 * Lifetime Particle Flux Exposure dashboard.
 * One object at a time: SGP4 propagation (WASM) -> environment sampling ->
 * fluence integration -> risk summary. Environment defaults to the bundled
 * semi-empirical model; MASTER results can be imported (stay client-side).
 */
import init, { Satellite } from '../pkg/sgp4_wasm.js';
import { fetchTleFromCelestrak, WELL_KNOWN_OBJECTS } from '../demo/discos-client.js';
import { initScene, drawOrbit, buildShells, frameOrbitOnSelect, RE } from './scene.js';
import {
    interpolateFlux, propagateMission, computeMission,
} from './mission.js';
import {
    drawAltFluxChart, drawFluenceChart, drawRiskCurve,
    drawHeatmap, drawGroundTrack, setLandLines,
} from './charts.js';

// ------------------------------------------------------------- state
let sgp4Ready = false;
let satellite = null;
let selectedObject = null;
let env = null;            // { heatmap, profiles, name, badge }
let mission = null;        // propagation samples
let result = null;         // mission integration output
let config = {
    durationYears: 5, areaM2: 10,
    shieldMaterial: 'aluminum', shieldThicknessMm: 2,
};

const $ = id => document.getElementById(id);

// ------------------------------------------------------------- boot
async function initialize() {
    updateStatus('Loading WASM…');
    try {
        await init();
        sgp4Ready = true;
    } catch (e) {
        updateStatus(`WASM init failed: ${e.message}`);
        return;
    }
    initScene();

    fetch('../demo/land.json').then(r => r.ok ? r.json() : null)
        .then(j => { if (j) { setLandLines(j); redrawCharts(); } })
        .catch(() => {});

    await loadEnvironment('model');
    renderObjectSelect();
    setupEventListeners();

    // default: Molniya — eccentric, crosses every band
    const molniyaIdx = WELL_KNOWN_OBJECTS.findIndex(o => o.name === 'MOLNIYA 1-91');
    if (molniyaIdx >= 0) {
        $('object-select').value = molniyaIdx;
        selectKnownObject(molniyaIdx);
    }
    $('loading-overlay').classList.add('hidden');
}

// ------------------------------------------------------- environment
async function loadEnvironment(kind, imported = null) {
    try {
        let heatmap, profiles, name, badge;
        if (imported) {
            heatmap = imported.heatmap;
            profiles = imported.profiles;
            name = heatmap.model || 'MASTER (imported)';
            badge = `[${name}]`;
        } else {
            // local MASTER data first (gitignored), then bundled model
            let local = null;
            try {
                const [hm, pf] = await Promise.all([
                    fetch('data/local/master_heatmap.json').then(r => r.ok ? r.json() : null),
                    fetch('data/local/master_profiles.json').then(r => r.ok ? r.json() : null),
                ]);
                if (hm && pf) local = { heatmap: hm, profiles: pf };
            } catch (e) { /* not present */ }

            if (local) {
                heatmap = local.heatmap;
                profiles = local.profiles;
                name = heatmap.model || 'MASTER (local)';
                badge = `[${name}]`;
            } else {
                const [hm, pf] = await Promise.all([
                    fetch('data/model_heatmap.json').then(r => r.json()),
                    fetch('data/model_profiles.json').then(r => r.json()),
                ]);
                heatmap = hm;
                profiles = pf;
                name = hm.model;
                badge = '[model]';
            }
        }
        env = { heatmap, profiles, name, badge };
        $('env-badge').textContent = badge;
        $('env-info').textContent =
            `${name} — flux ≥1mm at 400km/51.6°: ${interpolateFlux(heatmap, 400, 51.6).toExponential(1)} /m²/yr. ` +
            `Grid ${heatmap.altitudes_km.length}×${heatmap.inclinations_deg.length}` +
            (heatmap.epoch ? `, epoch ${heatmap.epoch}.` : '.');
        buildShells(heatmap);
        if (selectedObject) recompute(true);
        updateStatus(`Environment: ${name}`);
    } catch (e) {
        updateStatus(`Environment load failed: ${e.message}`);
    }
}

// ------------------------------------------------------- selection
function renderObjectSelect() {
    const select = $('object-select');
    select.innerHTML = WELL_KNOWN_OBJECTS.map((o, i) =>
        `<option value="${i}">${o.name} (${o.orbitType})</option>`).join('');
    select.addEventListener('change', () => selectKnownObject(parseInt(select.value)));
}

async function selectKnownObject(index) {
    const obj = WELL_KNOWN_OBJECTS[index];
    selectedObject = { name: obj.name, description: obj.description, noradId: obj.noradId };
    updateStatus(`Fetching TLE for ${obj.name} (NORAD ${obj.noradId})…`);
    try {
        const tle = await fetchTleFromCelestrak(obj.noradId);
        loadTle(tle.name || obj.name, tle.line1, tle.line2);
    } catch (e) {
        updateStatus(`TLE fetch failed (${e.message}) — paste a TLE or pick another object.`);
    }
}

function loadTle(name, line1, line2) {
    try {
        satellite = new Satellite(line1, line2);
        const inc = parseFloat(line2.substring(8, 16).trim()) || null;
        selectedObject = {
            name,
            noradId: Number(satellite.getNoradId()),
            inclination_deg: inc,
            description: selectedObject?.noradId === Number(satellite.getNoradId())
                ? (selectedObject.description || '') : 'Custom TLE',
        };
        updateSelectedInfo();
        recompute(true);
    } catch (e) {
        updateStatus(`TLE parse error: ${e.message}`);
    }
}

function updateSelectedInfo() {
    const section = $('selected-section');
    section.style.display = 'block';
    $('selected-info').innerHTML =
        `<div class="obj-line"><span class="obj-name">${selectedObject.name}</span><span class="v">${selectedObject.noradId}</span></div>` +
        (selectedObject.description ? `<div class="obj-line"><span>${selectedObject.description}</span></div>` : '') +
        (selectedObject.inclination_deg != null
            ? `<div class="obj-line">Inclination <span class="v">${selectedObject.inclination_deg.toFixed(2)}°</span></div>` : '');
    $('viewport-title').textContent = selectedObject.name;
    $('viewport-info').textContent = `NORAD ${selectedObject.noradId}`;
}

// ------------------------------------------------------- computation
function recompute(reframe = false) {
    if (!satellite || !sgp4Ready || !env) return;

    // eccentric orbits: sample enough orbits to cover the full period pattern
    mission = propagateMission(satellite, {
        displayOrbits: 3,
        pointsPerOrbit: 240,
        heatmap: env.heatmap,
        profiles: env.profiles,
    });

    result = computeMission(mission, env.profiles, config);

    drawOrbit(mission.points);
    redrawCharts();
    renderRisk();
    updateStatus(
        `<span class="hl">${mission.points.length}</span> samples over ${mission.displayOrbits} orbits ` +
        `(${mission.periodMin.toFixed(1)} min period) — env: ${env.name}`
    );
}

function redrawCharts() {
    if (!mission || !result) return;
    resizeCanvases();
    drawAltFluxChart($('alt-flux-chart'), mission, config);
    drawFluenceChart($('fluence-chart'), result);
    drawRiskCurve($('risk-chart'), result, config);
    drawHeatmap($('heatmap-canvas'), env.heatmap, mission);
    // marker at the first sample (propagation origin)
    drawGroundTrack($('groundtrack-canvas'), mission, result, mission.points[0]);
}

// Proportional sizing: the altitude chart fills its flexible grid row; the
// ground track keeps a near-equirectangular proportion of its width.
function resizeCanvases() {
    const alt = $('alt-flux-chart');
    const sec = alt.parentElement;
    const titleH = sec.querySelector('.chart-title').offsetHeight + 14;
    const avail = sec.clientHeight - titleH - 10;
    alt.style.height = Math.max(avail, 120) + 'px';

    const gt = $('groundtrack-canvas');
    const gtW = gt.parentElement.clientWidth - 24;
    gt.style.height = Math.min(Math.max(gtW * 0.32, 140), 240) + 'px';
}
window.addEventListener('resize', () => { if (mission) redrawCharts(); });

function fmt(v, digits = 2) {
    if (!isFinite(v)) return '—';
    if (v >= 0.01 && v < 1000) return v.toFixed(digits);
    return v.toExponential(1);
}

function renderRisk() {
    if (!result) return;
    const p1 = $('rk-p1mm');
    p1.textContent = (result.p1mm * 100).toFixed(result.p1mm > 0.01 ? 1 : 3) + '%';
    p1.className = 'rk-value' + (result.p1mm > 0.1 ? ' bad' : result.p1mm > 0.01 ? ' warn' : '');
    $('rk-exp1mm').textContent = fmt(result.expected1mm);
    const perf = $('rk-perf');
    perf.textContent = (result.pPerf * 100).toFixed(result.pPerf > 0.01 ? 1 : 3) + '%';
    perf.className = 'rk-value' + (result.pPerf > 0.1 ? ' bad' : result.pPerf > 0.01 ? ' warn' : '');
    $('rk-perf-sub').textContent =
        `${config.shieldThicknessMm}mm ${config.shieldMaterial} · v≈${result.vImp.toFixed(1)} km/s · dcrit ${(result.dCritM * 1000).toFixed(1)}mm`;
    $('rk-ratio').textContent = isFinite(result.fluxRatio) ? result.fluxRatio.toFixed(0) + '×' : '∞';

    $('band-exposure').innerHTML = result.bandExposure.map(b =>
        `<div class="band-row">
            <span class="band-name">${b.name}</span>
            <div class="band-bar"><div class="band-fill" style="width:${b.pct}%"></div></div>
            <span class="band-pct">${b.pct.toFixed(1)}%</span>
        </div>`).join('');
}

// ------------------------------------------------------- events
function setupEventListeners() {
    const debounced = (fn, ms = 250) => {
        let t;
        return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
    };
    const cfgChanged = () => {
        config.durationYears = parseFloat($('cfg-duration').value);
        config.areaM2 = parseFloat($('cfg-area').value);
        config.shieldMaterial = $('cfg-material').value;
        config.shieldThicknessMm = parseFloat($('cfg-shield').value);
        $('cfg-duration-val').textContent = config.durationYears.toFixed(1) + ' yr';
        $('cfg-area-val').textContent = config.areaM2 + ' m²';
        $('cfg-shield-val').textContent = config.shieldThicknessMm.toFixed(1) + ' mm';
        if (mission) { result = computeMission(mission, env.profiles, config); redrawCharts(); renderRisk(); }
    };
    for (const id of ['cfg-duration', 'cfg-area', 'cfg-material', 'cfg-shield']) {
        $(id).addEventListener('input', debounced(cfgChanged));
        $(id).addEventListener('change', cfgChanged);
    }

    $('tle-toggle').addEventListener('click', () => { $('tle-modal').style.display = 'flex'; });
    $('tle-cancel').addEventListener('click', () => { $('tle-modal').style.display = 'none'; });
    $('load-tle-btn').addEventListener('click', () => {
        const lines = $('custom-tle').value.trim().split('\n').map(l => l.trim()).filter(Boolean);
        if (lines.length >= 2) {
            loadTle(lines.length === 3 ? lines[0] : 'Custom Object',
                lines[lines.length - 2], lines[lines.length - 1]);
            $('tle-modal').style.display = 'none';
        }
    });

    // MASTER import: parse .dia files client-side or accept pre-built JSONs
    $('import-master').addEventListener('click', () => $('master-file').click());
    $('master-file').addEventListener('change', async (e) => {
        const files = [...e.target.files];
        if (!files.length) return;
        try {
            updateStatus('Parsing MASTER outputs…');
            const diaFiles = files.filter(f => f.name.endsWith('.dia'));
            if (files.some(f => f.name.includes('heatmap')) && files.some(f => f.name.includes('profiles'))) {
                // pre-built JSONs from tools/master-ingest
                const hm = JSON.parse(await files.find(f => f.name.includes('heatmap')).text());
                const pf = JSON.parse(await files.find(f => f.name.includes('profiles')).text());
                await loadEnvironment('imported', { heatmap: hm, profiles: pf });
            } else if (diaFiles.length) {
                const spectra = [];
                for (const f of diaFiles) {
                    try { spectra.push(parseDiaFile(await f.text(), f.name)); }
                    catch (err) { console.warn(`skipped ${f.name}: ${err.message}`); }
                }
                if (!spectra.length) throw new Error('no parseable .dia files');
                const { heatmap, profiles } = buildLocalEnv(spectra);
                await loadEnvironment('imported', { heatmap, profiles });
            } else {
                throw new Error('select .dia files or master_heatmap/master_profiles JSONs');
            }
        } catch (err) {
            updateStatus(`Import failed: ${err.message}`);
        }
    });
}

// Browser-side .dia parser (mirrors tools/master-ingest/parse_master.py)
function parseDiaFile(text, name) {
    let meta = {}, rows = [];
    for (const line of text.split('\n')) {
        if (line.startsWith('#')) {
            let m = line.match(/orbiting target .*?\(ECI frame\)\s+([\d.]+)\s*km,\s*([\d.]+),\s*([\d.]+)\s*deg/);
            if (m) { meta.sma_km = +m[1]; meta.eccentricity = +m[2]; meta.inclination_deg = +m[3]; }
            m = line.match(/Most recent reference Epoch:\s*([\d/]+)/);
            if (m) meta.epoch = m[1];
            m = line.match(/MASTER v([\d.]+)/);
            if (m) meta.model = `MASTER ${m[1]}`;
            m = line.match(/Spectrum:\s*(\w[\w -]*\w)/);
            if (m) meta.spectrum = m[1].trim().toLowerCase();
            continue;
        }
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 5 && /^\d/.test(parts[0])) {
            rows.push(parts.map(Number));
        }
    }
    if (!rows.length || meta.sma_km == null) throw new Error(`${name}: not a MASTER .dia spectrum`);
    if (meta.spectrum && meta.spectrum !== 'cumulative') throw new Error(`${name}: ${meta.spectrum} — need cumulative`);
    const ncols = rows[0].length;
    const col = i => rows.map(r => r[i] ?? 0);
    return {
        orbit: { ...meta, altitude_km: meta.sma_km - RE },
        diameters_m: col(0),
        meteoroid_flux: col(16),
        debris_flux: col(15),
        total_flux: col(ncols - 1),
        sources: {
            fragments: col(1).map((v, i) => v + col(2)[i]),   // expl + collision fragments
            paint_flakes: col(7),
            srm_slag: col(5),
            nak_droplets: col(4),
            mli: col(9),
            ejecta: col(8),
        },
    };
}

function buildLocalEnv(spectra) {
    // Minimal single-file import: build profiles from the spectra and interpolate
    // the heatmap onto the dashboard grid (mirrors tools/master-ingest).
    const ALTS = [300, 500, 700, 900, 1100, 1400, 2000, 5000, 10000, 20200, 35786, 50000];
    const INCS = [0.1, 28.5, 51.6, 72.0, 82.0, 98.0, 120.0];
    const profiles = spectra.map(s => ({ orbit: s.orbit, diameters_m: s.diameters_m,
        meteoroid_flux: s.meteoroid_flux, debris_flux: s.debris_flux,
        total_flux: s.total_flux, sources: s.sources }));
    const lg = v => Math.log10(Math.max(v, 1e-30));
    const fluxAt = (spec, size) => {
        const d = spec.diameters_m, f = spec.total_flux;
        if (size <= d[0]) return f[0];
        if (size >= d[d.length - 1]) return 0;
        for (let i = 1; i < d.length; i++) {
            if (d[i] >= size) {
                const t = (Math.log10(size) - Math.log10(d[i - 1])) / (Math.log10(d[i]) - Math.log10(d[i - 1]));
                return 10 ** ((1 - t) * lg(f[i - 1]) + t * lg(f[i]));
            }
        }
        return 0;
    };
    const hm = { altitudes_km: ALTS, inclinations_deg: INCS,
        model: spectra[0].orbit.model || 'MASTER (imported)', epoch: spectra[0].orbit.epoch || '',
        note: `Imported: ${spectra.length} spectra, inverse-distance binned.` };
    for (const [key, size] of [['flux_10um', 10e-6], ['flux_1mm', 1e-3], ['flux_1cm', 1e-2]]) {
        hm[key] = ALTS.map(alt => INCS.map(inc => {
            let num = 0, den = 0;
            for (const s of spectra) {
                const f = fluxAt(s, size);
                if (f <= 0) continue;
                const salt = s.orbit.altitude_km;
                const w = 1 / (1 + (Math.log10((salt + 1) / (alt + 1)) * 4) ** 2 + ((s.orbit.inclination_deg - inc) / 30) ** 2);
                num += w * lg(f); den += w;
            }
            return den > 0 ? 10 ** (num / den) : 0;
        }));
    }
    return { heatmap: hm, profiles };
}

function updateStatus(html) { $('status-text').innerHTML = html; }

initialize().catch(e => {
    updateStatus(`Init error: ${e.message}`);
    console.error(e);
});