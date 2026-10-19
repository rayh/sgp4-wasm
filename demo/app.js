/**
 * sgp4-wasm — Orbit Propagation Demo
 * ===================================
 * 3D earth-moon visualization of SGP4 propagation running in WebAssembly.
 * Data sources: Celestrak TLE fetch, ESA DISCOSweb search, or pasted TLE.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import init, { Satellite } from '../pkg/sgp4_wasm.js';
import { DiscosClient, fetchTleFromCelestrak, WELL_KNOWN_OBJECTS } from './discos-client.js';

let localConfig = {};
try {
    const mod = await import('./config.local.js');
    localConfig = mod.CONFIG || {};
} catch (e) { /* no local config */ }

// ============================================================
// CONSTANTS
// ============================================================
const RE = 6371; // Earth radius km
const RM = 1737.4; // Moon radius km
const MOON_DIST = 384400; // km average
const MU = 398600.4; // km^3/s^2

// ============================================================
// STATE
// ============================================================
let sgp4Ready = false;
let satellite = null;
let selectedObject = null;
let results = [];        // propagation samples
let windowMin = 0;       // displayed window in minutes
let simMinutes = 0;      // current time within window
let playing = false;
let epochDate = null;

// 3D scene
let scene, camera, renderer, controls;
let orbitLine = null, satMarker = null, earthMesh = null, earthWire = null;
let moonMesh = null, moonOrbitLine = null;

// ============================================================
// LUNAR EPHEMERIS (Meeus, simplified) + GMST
// ============================================================
class AstroEngine {
    static julianDate(date) { return date.getTime() / 86400000 + 2440587.5; }
    static T(jd) { return (jd - 2451545.0) / 36525.0; }

    // Geocentric equatorial position of the Moon in km
    static moonPosition(date) {
        const jd = this.julianDate(date);
        const T = this.T(jd);
        const T2 = T * T, T3 = T2 * T;
        const toRad = Math.PI / 180;

        const Lp = 218.3164477 + 481267.88123421 * T - 0.0015786 * T2 + T3 / 538841;
        const D = 297.8501921 + 445267.1114034 * T - 0.0018819 * T2 + T3 / 545868;
        const M = 357.5291092 + 35999.0502909 * T - 0.0001536 * T2;
        const Mp = 134.9633964 + 477198.8675055 * T + 0.0087414 * T2 + T3 / 69699;
        const F = 93.2720950 + 483202.0175233 * T - 0.0036539 * T2;
        const Lr = Lp * toRad, Dr = D * toRad, Mr = M * toRad, Mpr = Mp * toRad, Fr = F * toRad;

        const sumL = 6288774 * Math.sin(Mpr)
            + 1274027 * Math.sin(2 * Dr - Mpr) + 658314 * Math.sin(2 * Dr)
            + 213618 * Math.sin(2 * Mpr) - 185116 * Math.sin(Mr)
            - 114332 * Math.sin(2 * Fr) + 58793 * Math.sin(2 * Dr - 2 * Mpr)
            + 57066 * Math.sin(2 * Dr - Mr - Mpr) + 53322 * Math.sin(2 * Dr + Mpr)
            + 45758 * Math.sin(2 * Dr - Mr) - 40923 * Math.sin(Mr - Mpr)
            - 34720 * Math.sin(Dr) - 30383 * Math.sin(Mr + Mpr)
            + 15327 * Math.sin(2 * Dr - 2 * Fr) - 12528 * Math.sin(Mpr + 2 * Fr)
            + 10980 * Math.sin(Mpr - 2 * Fr);

        const sumB = 5128122 * Math.sin(Fr)
            + 280602 * Math.sin(Mpr + Fr) + 277693 * Math.sin(Mpr - Fr)
            + 173237 * Math.sin(2 * Dr - Fr) + 55413 * Math.sin(2 * Dr - Mpr + Fr)
            + 46271 * Math.sin(2 * Dr - Mpr - Fr) + 32573 * Math.sin(2 * Dr + Fr)
            + 17198 * Math.sin(2 * Mpr + Fr) + 9266 * Math.sin(2 * Dr + Mpr - Fr)
            + 8822 * Math.sin(2 * Mpr - Fr);

        const sumR = -20905355 * Math.cos(Mpr) - 3699111 * Math.cos(2 * Dr - Mpr)
            - 2955968 * Math.cos(2 * Dr) - 569925 * Math.cos(2 * Mpr)
            + 48888 * Math.cos(Mr) - 3149 * Math.cos(2 * Fr)
            + 246158 * Math.cos(2 * Dr - 2 * Mpr) - 152138 * Math.cos(2 * Dr - Mr - Mpr)
            - 170733 * Math.cos(2 * Dr + Mpr) - 204586 * Math.cos(2 * Dr - Mr)
            - 129620 * Math.cos(Mr - Mpr) + 108743 * Math.cos(Dr)
            + 104755 * Math.cos(Mr + Mpr) + 10321 * Math.cos(2 * Dr - 2 * Fr);

        const lambda = Lp + sumL / 1000000;
        const beta = sumB / 1000000;
        const dist = 385000.56 + sumR / 1000;

        const lamRad = lambda * toRad, betRad = beta * toRad;
        const obliquity = (23.4393 - 0.013 * T) * toRad;
        const cosB = Math.cos(betRad);
        const xEcl = dist * cosB * Math.cos(lamRad);
        const yEcl = dist * cosB * Math.sin(lamRad);
        const zEcl = dist * Math.sin(betRad);
        const cosE = Math.cos(obliquity), sinE = Math.sin(obliquity);

        return {
            x: xEcl,
            y: yEcl * cosE - zEcl * sinE,
            z: yEcl * sinE + zEcl * cosE,
            dist,
        };
    }

    // Greenwich sidereal time in radians
    static gmst(date) {
        const jd = this.julianDate(date);
        const T = this.T(jd);
        let gmst = 280.46061837 + 360.98564736629 * (jd - 2451545.0) + 0.000387933 * T * T;
        return ((gmst % 360) + 360) % 360 * Math.PI / 180;
    }
}

// ============================================================
// INIT
// ============================================================
async function initialize() {
    updateStatus('Loading WASM...');
    try {
        await init();
        sgp4Ready = true;
    } catch (e) {
        updateStatus(`WASM init failed: ${e.message}`);
        console.error(e);
        return;
    }
    init3DScene();
    renderKnownObjects();
    setupEventListeners();
    updateStatus('Ready. Select an object — TLEs are fetched from Celestrak.');
}

// ============================================================
// 3D SCENE
// ============================================================
function init3DScene() {
    const container = document.getElementById('viewport-container');
    const canvas = document.getElementById('three-canvas');

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.01, 5000);
    camera.position.set(0, 25, 70);

    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.minDistance = 1.5;
    controls.maxDistance = 1000;

    scene.add(new THREE.AmbientLight(0x404060, 0.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.5);
    sun.position.set(50, 20, 30);
    scene.add(sun);

    // Starfield
    const starGeom = new THREE.BufferGeometry();
    const starPos = new Float32Array(2000 * 3);
    for (let i = 0; i < 2000; i++) {
        const theta = Math.random() * Math.PI * 2;
        const phi = Math.acos(2 * Math.random() - 1);
        const r = 800 + Math.random() * 400;
        starPos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
        starPos[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
        starPos[i * 3 + 2] = r * Math.cos(phi);
    }
    starGeom.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
    scene.add(new THREE.Points(starGeom, new THREE.PointsMaterial({ color: 0xffffff, size: 0.4 })));

    // Earth
    const earthTexture = new THREE.TextureLoader().load(
        'https://unpkg.com/three-globe@2.31.1/example/img/earth-blue-marble.jpg',
        () => {}, undefined,
        () => { earthMesh.material.map = null; earthMesh.material.color.set(0x1a3a5c); }
    );
    earthMesh = new THREE.Mesh(
        new THREE.SphereGeometry(1, 64, 64),
        new THREE.MeshPhongMaterial({ map: earthTexture, emissive: 0x050510, specular: 0x222233, shininess: 10 })
    );
    scene.add(earthMesh);

    earthWire = new THREE.LineSegments(
        new THREE.WireframeGeometry(new THREE.SphereGeometry(1.001, 16, 16)),
        new THREE.LineBasicMaterial({ color: 0x4488ff, opacity: 0.08, transparent: true })
    );
    scene.add(earthWire);

    // Earth rotation axis
    scene.add(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(0, -1.8, 0), new THREE.Vector3(0, 1.8, 0),
        ]),
        new THREE.LineBasicMaterial({ color: 0xffffff, opacity: 0.3, transparent: true })
    ));

    // Moon
    moonMesh = new THREE.Mesh(
        new THREE.SphereGeometry(RM / RE, 24, 24),
        new THREE.MeshPhongMaterial({ color: 0x9a9a9a, emissive: 0x111111, shininess: 3 })
    );
    scene.add(moonMesh);

    // Moon orbit ring (recomputed per object from its epoch)
    moonOrbitLine = new THREE.Line(
        new THREE.BufferGeometry(),
        new THREE.LineBasicMaterial({ color: 0x4fc3f7, opacity: 0.25, transparent: true })
    );
    scene.add(moonOrbitLine);

    // Reference orbit indicators
    addRing(42157, 0xff9800, 0.5);                    // GEO
    for (let plane = 0; plane < 6; plane++)           // GPS: 6 planes, 55 deg
        addRing(RE + 20200, 0x66bb6a, 0.2, plane * Math.PI / 3, 55);
    addRing(RE + 500, 0x4fc3f7, 0.15);                // LEO shell (representative)
    addRing(MOON_DIST, 0x4fc3f7, 0.1);                // mean moon distance

    // Lagrange points
    const moonDistU = MOON_DIST / RE;
    const lagrange = [
        moonDistU * 0.85, moonDistU * 1.15,
    ];
    for (const d of lagrange) {
        const marker = new THREE.Mesh(
            new THREE.OctahedronGeometry(0.3),
            new THREE.MeshBasicMaterial({ color: 0xe91e63, wireframe: true, transparent: true, opacity: 0.6 })
        );
        marker.position.set(d, 0, 0);
        scene.add(marker);
    }

    // Satellite marker (hidden until an orbit is propagated)
    satMarker = new THREE.Mesh(
        new THREE.SphereGeometry(0.06, 12, 12),
        new THREE.MeshBasicMaterial({ color: 0x4fc3f7 })
    );
    satMarker.visible = false;
    scene.add(satMarker);

    // Screen-projected labels
    const labels = [
        { text: 'LEO', pos: new THREE.Vector3((RE + 500) / RE, 0.4, 0), color: '#4fc3f7' },
        { text: 'GPS', pos: new THREE.Vector3((RE + 20200) / RE * 0.7, (RE + 20200) / RE * 0.5, 0), color: '#66bb6a' },
        { text: 'GEO', pos: new THREE.Vector3(42157 / RE, 0.3, 0), color: '#ff9800' },
        { text: 'Moon', pos: new THREE.Vector3(MOON_DIST / RE, 0.8, 0), color: '#aaaaaa' },
    ];
    const labelContainer = document.createElement('div');
    labelContainer.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;overflow:hidden';
    container.appendChild(labelContainer);
    const labelEls = labels.map(l => {
        const el = document.createElement('div');
        el.textContent = l.text;
        el.style.cssText = `position:absolute;font-size:10px;color:${l.color};font-weight:500;text-shadow:0 0 4px rgba(0,0,0,0.8);white-space:nowrap;`;
        labelContainer.appendChild(el);
        return { el, pos: l.pos };
    });

    function animate(now) {
        requestAnimationFrame(animate);
        if (playing && results.length > 1) {
            const dtMin = (now - (animate.last || now)) / 1000 * 60; // 60x realtime
            animate.last = now;
            simMinutes = (simMinutes + dtMin) % windowMin;
            document.getElementById('time-slider').value = simMinutes;
            updateSimulation();
        } else {
            animate.last = now;
        }
        controls.update();
        renderer.render(scene, camera);
        for (const label of labelEls) {
            const p = label.pos.clone().project(camera);
            if (p.z > 1) { label.el.style.display = 'none'; continue; }
            label.el.style.display = '';
            label.el.style.transform =
                `translate(${(p.x * 0.5 + 0.5) * container.clientWidth}px, ${(-p.y * 0.5 + 0.5) * container.clientHeight}px)`;
        }
    }
    requestAnimationFrame(animate);

    window.addEventListener('resize', () => {
        const w = container.clientWidth, h = container.clientHeight;
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);
    });
}

// Ring in the equatorial plane, optionally inclined and rotated (GPS planes)
function addRing(altitudeKm, color, opacity, raan = 0, incDeg = 0) {
    const r = (altitudeKm === MOON_DIST ? MOON_DIST : RE + altitudeKm) / RE;
    const inc = incDeg * Math.PI / 180;
    const points = [];
    for (let i = 0; i <= 128; i++) {
        const nu = (i / 128) * Math.PI * 2;
        const xo = r * Math.cos(nu), yo = r * Math.sin(nu);
        const x = xo * Math.cos(raan) - yo * Math.cos(inc) * Math.sin(raan);
        const y = yo * Math.sin(inc);
        const z = xo * Math.sin(raan) + yo * Math.cos(inc) * Math.cos(raan);
        points.push(new THREE.Vector3(x, y, z));
    }
    scene.add(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(points),
        new THREE.LineBasicMaterial({ color, opacity, transparent: true })
    ));
}

// ECI (TEME, z = north) -> scene coords (y = north)
function eciToScene(p, scale = 1 / RE) {
    return new THREE.Vector3(p[0] * scale, p[2] * scale, -p[1] * scale);
}

// ============================================================
// PROPAGATION
// ============================================================
async function loadObjectByNorad(noradId, name) {
    updateStatus(`Fetching TLE for ${name} (NORAD ${noradId})...`);
    try {
        const tle = await fetchTleFromCelestrak(noradId);
        loadTle(tle.name || name, tle.line1, tle.line2);
    } catch (e) {
        updateStatus(`TLE fetch failed (${e.message}). Try "Paste TLE".`);
    }
}

function loadTle(name, line1, line2) {
    try {
        satellite = new Satellite(line1, line2);
        const inc = parseFloat(line2.substring(8, 16).trim());
        selectedObject = { name, noradId: satellite.getNoradId(), inclination_deg: inc };
        showObjectInfo(name, satellite.getNoradId(), 'Custom TLE', inc);
        updateStatus(`Loaded ${name} — propagating with SGP4...`);
        propagate();
    } catch (e) {
        updateStatus(`TLE parse error: ${e.message}`);
    }
}

function propagate() {
    if (!satellite || !sgp4Ready) return;
    showLoading(true);

    const p0 = satellite.propagate(0);
    const r0 = Math.hypot(...p0.position_eci);
    const v0 = p0.speed_km_s;
    const sma = 1 / (2 / r0 - (v0 * v0) / MU); // vis-viva
    const periodMin = 2 * Math.PI * Math.sqrt(sma * sma * sma / MU) / 60;

    const numOrbits = parseInt(document.getElementById('orbits-slider').value) || 4;
    windowMin = periodMin * numOrbits;
    const pointsPerOrbit = 240;
    const stepMin = periodMin / pointsPerOrbit;

    const t0 = performance.now();
    const batch = satellite.propagateBatch(0, windowMin, stepMin);
    const elapsed = (performance.now() - t0).toFixed(1);
    results = batch.results;

    // Eccentricity estimate from the first orbit's altitude extremes
    const firstOrbit = results.slice(0, pointsPerOrbit);
    const altMin = Math.min(...firstOrbit.map(r => r.altitude_km));
    const altMax = Math.max(...firstOrbit.map(r => r.altitude_km));
    const ecc = (altMax - altMin) / (altMax + altMin + 2 * RE);

    epochDate = new Date(satellite.getEpoch());
    simMinutes = 0;
    document.getElementById('time-slider').max = Math.round(windowMin);
    document.getElementById('time-slider').value = 0;

    drawOrbit();
    drawGroundTrack();
    renderStats(periodMin, altMin, altMax, ecc, results.length, elapsed);
    updateSimulation();
    showLoading(false);
    updateStatus(
        `${results.length} points over ${numOrbits} orbits (Δt=${stepMin.toFixed(2)} min) — SGP4 in WASM, ${elapsed} ms`
    );
}

function drawOrbit() {
    if (orbitLine) {
        scene.remove(orbitLine);
        orbitLine.geometry.dispose();
        orbitLine.material.dispose();
    }
    const points = results.map(r => eciToScene(r.position_eci));
    orbitLine = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(points),
        new THREE.LineBasicMaterial({ color: 0x4fc3f7, linewidth: 2 })
    );
    scene.add(orbitLine);

    satMarker.visible = true;

    // Frame the orbit
    const maxR = Math.max(...results.map(r => Math.hypot(...r.position_eci))) / RE;
    const d = maxR * 2.5;
    camera.position.set(d * 0.3, d * 0.5, d * 0.8);
    controls.update();

    // Moon orbit ring around the TLE epoch
    const pts = [];
    for (let i = 0; i <= 256; i++) {
        const t = epochDate.getTime() + (i / 256) * 27.32 * 86400000;
        const p = AstroEngine.moonPosition(new Date(t));
        pts.push(eciToScene([p.x, p.y, p.z]));
    }
    moonOrbitLine.geometry.dispose();
    moonOrbitLine.geometry = new THREE.BufferGeometry().setFromPoints(pts);
}

// Per-frame update: satellite marker, earth rotation, moon position, ground track marker
function updateSimulation() {
    document.getElementById('time-display').textContent =
        `T + ${simMinutes.toFixed(1)} min`;

    // Satellite position (nearest sample)
    if (results.length > 1) {
        const idx = Math.min(results.length - 1,
            Math.round((simMinutes / windowMin) * (results.length - 1)));
        const r = results[idx];
        satMarker.position.copy(eciToScene(r.position_eci));
        drawGroundTrackMarker(r);
    }

    const simDate = new Date(epochDate.getTime() + simMinutes * 60000);
    if (earthMesh) {
        const gmst = AstroEngine.gmst(simDate);
        earthMesh.rotation.y = gmst;
        earthWire.rotation.y = gmst;
    }
    if (epochDate) {
        const mp = AstroEngine.moonPosition(simDate);
        moonMesh.position.copy(eciToScene([mp.x, mp.y, mp.z]));
    }
}

// ============================================================
// KEPLERIAN FALLBACK (no network: DISCOS elements, no TLE available)
// ============================================================
function propagateFromElements({ sma_km, ecc, inc_deg }) {
    const periodMin = 2 * Math.PI * Math.sqrt(sma_km ** 3 / MU) / 60;
    const numOrbits = parseInt(document.getElementById('orbits-slider').value) || 4;
    windowMin = periodMin * numOrbits;
    const numPoints = 240 * numOrbits;
    const inc_rad = inc_deg * Math.PI / 180;
    results = [];

    for (let i = 0; i <= numPoints; i++) {
        const M = (i / numPoints) * 2 * Math.PI;
        let E = M;
        for (let k = 0; k < 10; k++) E = E - (E - ecc * Math.sin(E) - M) / (1 - ecc * Math.cos(E));
        const nu = 2 * Math.atan2(Math.sqrt(1 + ecc) * Math.sin(E / 2), Math.sqrt(1 - ecc) * Math.cos(E / 2));
        const r_km = sma_km * (1 - ecc * Math.cos(E));
        const x = r_km * Math.cos(nu);
        const yv = r_km * Math.sin(nu);
        results.push({
            position_eci: [x, yv * Math.cos(inc_rad), yv * Math.sin(inc_rad)],
            altitude_km: r_km - RE,
            latitude_deg: Math.asin(yv * Math.sin(inc_rad) / r_km) * 180 / Math.PI,
            longitude_deg: (Math.atan2(yv * Math.cos(inc_rad), x) * 180 / Math.PI + 360) % 360 - 180,
            minutes_since_epoch: (i / numPoints) * windowMin,
        });
    }

    epochDate = new Date();
    simMinutes = 0;
    document.getElementById('time-slider').max = Math.round(windowMin);
    document.getElementById('time-slider').value = 0;

    satMarker.visible = true;
    drawOrbit();
    drawGroundTrack();
    const altMin = Math.min(...results.map(r => r.altitude_km));
    const altMax = Math.max(...results.map(r => r.altitude_km));
    renderStats(periodMin, altMin, altMax, ecc, results.length, 0);
    updateSimulation();
    updateStatus(`Analytical Keplerian fallback (no TLE available) — SGP4 needs a TLE.`);
}

// ============================================================
// GROUND TRACK
// ============================================================
function drawGroundTrack() {
    const canvas = document.getElementById('groundtrack-canvas');
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, rect.width, rect.height);
    if (!results.length) return;

    const ml = 8, mr = 8, mt = 8, mb = 16;
    const pw = rect.width - ml - mr, ph = rect.height - mt - mb;
    const lonToX = lon => ml + ((lon + 180) / 360) * pw;
    const latToY = lat => mt + ((90 - lat) / 180) * ph;

    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.strokeRect(ml, mt, pw, ph);
    ctx.beginPath(); ctx.moveTo(ml, latToY(0)); ctx.lineTo(ml + pw, latToY(0)); ctx.stroke();

    ctx.strokeStyle = '#4fc3f7';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (i > 0 && Math.abs(r.longitude_deg - results[i - 1].longitude_deg) > 180) {
            ctx.stroke(); ctx.beginPath();
        }
        i === 0 ? ctx.moveTo(lonToX(r.longitude_deg), latToY(r.latitude_deg))
                : ctx.lineTo(lonToX(r.longitude_deg), latToY(r.latitude_deg));
    }
    ctx.stroke();
    drawGroundTrackMarker(results[0]);
}

function drawGroundTrackMarker(r) {
    const canvas = document.getElementById('groundtrack-canvas');
    if (!canvas.width) return;
    drawGroundTrack._last = r;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    // Redraw track then marker
    drawGroundTrack();
    const ml = 8, mr = 8, mt = 8, mb = 16;
    const pw = rect.width - ml - mr, ph = rect.height - mt - mb;
    ctx.fillStyle = '#ff5722';
    ctx.beginPath();
    ctx.arc(ml + ((r.longitude_deg + 180) / 360) * pw, mt + ((90 - r.latitude_deg) / 180) * ph, 3, 0, Math.PI * 2);
    ctx.fill();
}

// ============================================================
// UI
// ============================================================
function renderStats(periodMin, altMin, altMax, ecc, numPoints, elapsedMs) {
    const container = document.getElementById('stats-content');
    const pill = (l, v, u, hl) =>
        `<div class="stat-pill ${hl ? 'highlight' : ''}"><span class="sl">${l}</span><span class="sv">${v}</span><span class="su">${u || ''}</span></div>`;
    container.innerHTML =
        pill('Epoch', epochDate?.toISOString().slice(0, 16) + 'Z', '', true) +
        pill('NORAD', satellite?.getNoradId() ?? '—') +
        pill('Period', periodMin.toFixed(1), 'min') +
        pill('Peri', altMin.toFixed(0), 'km') +
        pill('Apo', altMax.toFixed(0), 'km') +
        pill('Inc', (selectedObject?.inclination_deg ?? 0).toFixed(1), '°') +
        pill('Ecc', ecc.toFixed(4)) +
        pill('Points', numPoints, `@ ${elapsedMs} ms`, true);
}

function renderKnownObjects() {
    const select = document.getElementById('object-select');
    select.innerHTML = WELL_KNOWN_OBJECTS.map((obj, i) =>
        `<option value="${i}">${obj.name} (${obj.orbitType})</option>`
    ).join('');
    select.addEventListener('change', () => selectKnownObject(parseInt(select.value)));
}

function selectKnownObject(index) {
    const obj = WELL_KNOWN_OBJECTS[index];
    selectedObject = { ...obj };
    showObjectInfo(obj.name, obj.noradId, obj.description, obj.inclination_deg);
    loadObjectByNorad(obj.noradId, obj.name);
}

function showObjectInfo(name, noradId, description, inclination) {
    document.getElementById('viewport-title').textContent = name || 'Object';
    document.getElementById('viewport-info').innerHTML =
        `${description || ''}<br>NORAD: ${noradId} | Inc: ${inclination?.toFixed(1) ?? '?'}°`;
}

function setupEventListeners() {
    document.getElementById('fetch-tle-btn').addEventListener('click', () => {
        if (selectedObject?.noradId) loadObjectByNorad(selectedObject.noradId, selectedObject.name);
        else updateStatus('Select an object first (or paste a TLE).');
    });

    document.getElementById('tle-toggle').addEventListener('click', () => {
        document.getElementById('tle-modal').style.display = 'flex';
    });
    document.getElementById('tle-cancel').addEventListener('click', () => {
        document.getElementById('tle-modal').style.display = 'none';
    });
    document.getElementById('load-tle-btn').addEventListener('click', () => {
        const lines = document.getElementById('custom-tle').value.trim().split('\n').map(l => l.trim()).filter(Boolean);
        if (lines.length >= 2) {
            const name = lines.length === 3 ? lines[0] : 'Custom Object';
            loadTle(name, lines[lines.length - 2], lines[lines.length - 1]);
            document.getElementById('tle-modal').style.display = 'none';
        }
    });

    document.getElementById('search-input').addEventListener('keydown', async (e) => {
        if (e.key !== 'Enter') return;
        const query = e.target.value.trim();
        if (!query) return;
        const token = localConfig.DISCOS_API_KEY;
        if (!token) {
            updateStatus('Add DISCOS_API_KEY to demo/config.local.js for search — or paste a TLE.');
            return;
        }
        try {
            updateStatus(`Searching DISCOSweb for "${query}"...`);
            const client = new DiscosClient(token);
            const { objects } = await client.searchObjects(query, { pageSize: 10 });
            const obj = objects.find(o => o.noradId);
            if (!obj) { updateStatus(`No results with NORAD ID for "${query}"`); return; }
            selectedObject = { name: obj.name, noradId: obj.noradId, inclination_deg: obj.inclination_deg };
            showObjectInfo(obj.name, obj.noradId, obj.objectClass || '', obj.inclination_deg);
            try {
                await loadObjectByNorad(obj.noradId, obj.name);
            } catch (err) {
                if (obj.perigee_km && obj.apogee_km && obj.inclination_deg) {
                    const sma = RE + (obj.perigee_km + obj.apogee_km) / 2;
                    const ecc = (obj.apogee_km - obj.perigee_km) / (obj.apogee_km + obj.perigee_km + 2 * RE);
                    propagateFromElements({ sma_km: sma, ecc, inc_deg: obj.inclination_deg });
                }
            }
        } catch (err) {
            updateStatus(`DISCOS search error: ${err.message}`);
        }
    });

    document.getElementById('orbits-slider').addEventListener('input', () => {
        document.getElementById('orbits-display').textContent =
            `${document.getElementById('orbits-slider').value} orbits`;
    });
    document.getElementById('orbits-slider').addEventListener('change', () => {
        if (satellite) propagate();
        else if (results.length) updateStatus('Analytical fallback: select an object to re-propagate.');
    });

    document.getElementById('time-slider').addEventListener('input', () => {
        playing = false;
        document.getElementById('btn-play').textContent = '▶';
        simMinutes = parseFloat(document.getElementById('time-slider').value);
        updateSimulation();
    });
    document.getElementById('btn-play').addEventListener('click', () => {
        playing = !playing;
        document.getElementById('btn-play').textContent = playing ? '⏸' : '▶';
    });
}

function updateStatus(html) { document.getElementById('status-text').innerHTML = html; }
function showLoading(show) { document.getElementById('loading-overlay').classList.toggle('hidden', !show); }

initialize().catch(e => {
    updateStatus(`Init error: ${e.message}`);
    console.error(e);
});
