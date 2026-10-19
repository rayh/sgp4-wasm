/**
 * sgp4-wasm — Orbit Propagation Demo
 * ===================================
 * Live 3D earth-moon visualization: every dot is an SGP4 propagation running
 * in WebAssembly. Time is always live (real time); scrub back/forward with
 * the slider and return to LIVE with one click.
 * Selection: dropdown, catalog search, paste-TLE, or click a dot in the cloud.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import init, { Satellite, Catalog } from '../pkg/sgp4_wasm.js';
import { fetchTleFromCelestrak, WELL_KNOWN_OBJECTS } from './discos-client.js';

// ============================================================
// CONSTANTS
// ============================================================
const RE = 6371; // Earth radius km
const RM = 1737.4; // Moon radius km
const MOON_DIST = 384400; // km average
const MU = 398600.4; // km^3/s^2

// Radius thresholds in km (regime coloring)
const GEO_R_KM = 42157;
const MEO_LO_KM = RE + 1600;
const MEO_HI_KM = 36000;
const DECAY_KM = RE + 160;

// ============================================================
// STATE
// ============================================================
let sgp4Ready = false;
let satellite = null;       // detailed SGP4 for the selected object
let selectedObject = null;  // { name, noradId, description }
let epochDate = null;       // selected TLE epoch
let periodMin = 0;          // orbital period of the selection

// Time model: always live. simTime = Date.now() + scrubOffsetMs.
let scrubOffsetMs = 0;
const MAX_SCRUB_MIN = 1440; // ±24h

// Catalog point cloud
let catalog = null;
let catalogIds = null;
let idToIndex = null;    // NORAD id -> cloud index
let catalogNames = [];
let catalogTles = [];    // [line1, line2] per object
let cloud = null;           // THREE.Mesh: oriented darts (4 faces), 12 vertices per object
let cloudPositions = null;  // current position per object (for picking), n*3
let tipPositions = null;    // dart tip positions (for picking), n*3
let triPositions = null;    // dart vertices, n*36 (4 faces x 3 verts x 3 floats)
let triColors = null;       // dart vertex colors, n*36
let highlightIndex = -1;    // cloud index of the selected object's dart
const TRAIL_MIN = 2.0;      // minutes of arc history per object
const TRI_SIZE = 0.028;     // dart world size
// Muted dart color + selected yellow, converted to linear space once
// (three r152+ treats vertex colors as linear and converts to sRGB on output)
const _baseColor = new THREE.Color(0x4fc3f7).convertSRGBToLinear();
const _selColor = new THREE.Color(0xffff33).convertSRGBToLinear();
const BASE_DART_R = _baseColor.r, BASE_DART_G = _baseColor.g, BASE_DART_B = _baseColor.b;
const SEL_DART_R = _selColor.r, SEL_DART_G = _selColor.g, SEL_DART_B = _selColor.b;

// 3D scene
let scene, camera, renderer, controls;
let orbitLine = null, earthMesh = null, earthWire = null;
let moonMesh = null, moonOrbitLine = null;
let sunLight = null;
let selLabelEl = null;

// Detailed propagation cache
let detailResults = [];  // orbit-line samples covering the current window
let detailCenterMin = 0; // minutes-since-epoch the window was centered on
let detailSpanMin = 0;
let groundTrackCache = null;
let lastDetailRefresh = 0;
let landLines = null; // world map polylines [ [lon,lat], ... ] per outline

// ============================================================
// LUNAR EPHEMERIS (Meeus, simplified) + GMST
// ============================================================
class AstroEngine {
    static julianDate(date) { return date.getTime() / 86400000 + 2440587.5; }
    static T(jd) { return (jd - 2451545.0) / 36525.0; }

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

    // Geocentric solar position (ECI, km) - Meeus low-precision, ~0.01 deg
    static sunPosition(date) {
        const jd = this.julianDate(date);
        const T = this.T(jd);
        const toRad = Math.PI / 180;
        const L0 = (280.46646 + 36000.76983 * T + 0.0003032 * T * T) % 360;
        const M = (357.52911 + 35999.05029 * T - 0.0001537 * T * T) % 360;
        const e = 0.016708634 - 0.000042037 * T;
        const C = (1.914602 - 0.004817 * T - 0.000014 * T * T) * Math.sin(M * toRad)
            + (0.019993 - 0.000101 * T) * Math.sin(2 * M * toRad)
            + 0.000289 * Math.sin(3 * M * toRad);
        const trueLong = L0 + C;
        const omega = 125.04 - 1934.136 * T;
        const appLong = trueLong - 0.00569 - 0.00478 * Math.sin(omega * toRad);
        // Obliquity
        const eps = 23.439291 - 0.0130042 * T;
        const dist = 149598000; // km (varies +/-1.7%, fine for lighting)
        const x = dist * Math.cos(appLong * toRad);
        const y = dist * (Math.cos(eps * toRad) * Math.sin(appLong * toRad));
        const z = dist * (Math.sin(eps * toRad) * Math.sin(appLong * toRad));
        return { x, y, z };
    }

    static gmst(date) {
        const jd = this.julianDate(date);
        const T = this.T(jd);
        let gmst = 280.46061837 + 360.98564736629 * (jd - 2451545.0) + 0.000387933 * T * T;
        return ((gmst % 360) + 360) % 360 * Math.PI / 180;
    }
}

// Current simulation time (ms since Unix epoch)
function simTimeMs() {
    return Date.now() + scrubOffsetMs;
}

function isLive() {
    return scrubOffsetMs === 0;
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
    updateStatus('Ready. Loading catalog...');

    // World map outline for the ground track (non-fatal if missing)
    fetch('land.json').then(r => r.ok ? r.json() : null)
        .then(j => { landLines = j; drawGroundTrack(); })
        .catch(() => {});

    loadCatalog();
}

// ============================================================
// CATALOG POINT CLOUD
// ============================================================
async function loadCatalog() {
    try {
        const resp = await fetch('catalog.tle');
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const text = await resp.text();

        const t0 = performance.now();
        catalog = new Catalog(text);
        const parseMs = (performance.now() - t0).toFixed(0);

        catalogIds = catalog.getIds();
        idToIndex = new Map();
        for (let i = 0; i < catalogIds.length; i++) {
            idToIndex.set(Number(catalogIds[i]), i);
        }

        // Extract names + TLE lines, keyed by NORAD id (wasm parse may skip records)
        const byId = new Map();
        const lines = text.split('\n');
        for (let i = 0; i + 2 < lines.length; i++) {
            if (lines[i + 1]?.startsWith('1 ') && lines[i + 2]?.startsWith('2 ')) {
                const id = parseInt(lines[i + 1].substring(2, 7).trim());
                if (!byId.has(id)) byId.set(id, [lines[i].trim(), lines[i + 1], lines[i + 2]]);
            }
        }
        catalogNames = [];
        catalogTles = [];
        for (const id of catalogIds) {
            const rec = byId.get(Number(id));
            catalogNames.push(rec ? rec[0] : '');
            catalogTles.push(rec ? [rec[1], rec[2]] : null);
        }

        const n = catalog.count();
        cloudPositions = new Float32Array(n * 3);   // current position per object (for picking)
        tipPositions = new Float32Array(n * 3);     // dart tip (visual pointer) per object
        triPositions = new Float32Array(n * 36);    // 4 faces x 3 verts x 3 floats
        triColors = new Float32Array(n * 36);

        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.BufferAttribute(triPositions, 3));
        geom.setAttribute('color', new THREE.BufferAttribute(triColors, 3));
        geom.computeVertexNormals();
        cloud = new THREE.Mesh(geom, new THREE.MeshBasicMaterial({
            vertexColors: true, transparent: true, opacity: 0.9,
            side: THREE.DoubleSide, depthWrite: true,
        }));
        cloud.frustumCulled = false;
        scene.add(cloud);

        propagateSnapshot();
        const regimes = countRegimes();
        document.getElementById('catalog-info').textContent =
            `${n.toLocaleString()} objects — LEO ${regimes.leo.toLocaleString()} · MEO ${regimes.meo.toLocaleString()} · GEO ${regimes.geo.toLocaleString()} · other ${regimes.other.toLocaleString()}`;
        updateStatus(
            `Catalog: <span class="hl">${n.toLocaleString()}</span> objects live — parsed ${parseMs} ms, snapshot ${snapshotMs.toFixed(0)} ms. Click any dot.`
        );
        document.getElementById('loading-overlay').classList.add('hidden');
    } catch (e) {
        updateStatus(`Catalog load failed: ${e.message} — paste a TLE to propagate.`);
        document.getElementById('loading-overlay').classList.add('hidden');
    }
}

let snapshotMs = 0;

// Propagate the whole cloud to the current sim time, recolor by regime, update highlight
function propagateSnapshot() {
    if (!catalog || !cloud) return;
    const unixMs = simTimeMs();

    const t0 = performance.now();
    const pos = catalog.propagateAllWithTrail(unixMs, TRAIL_MIN);
    snapshotMs = performance.now() - t0;

    const n = catalog.count();
    for (let i = 0; i < n; i++) {
        const x = pos[i * 6], y = pos[i * 6 + 1], z = pos[i * 6 + 2];
        const r = Math.sqrt(x * x + y * y + z * z); // km, geocentric
        // ECI (z=north) -> scene (y=north)
        const sx = x / RE, sy = z / RE, sz = -y / RE;
        cloudPositions[i * 3] = sx;
        cloudPositions[i * 3 + 1] = sy;
        cloudPositions[i * 3 + 2] = sz;

        // Dart oriented along the direction of travel (trailing sample -> current)
        const tx = pos[i * 6 + 3] / RE, ty = pos[i * 6 + 5] / RE, tz = -pos[i * 6 + 4] / RE;
        let dx = sx - tx, dy = sy - ty, dz = sz - tz;
        const dl = Math.hypot(dx, dy, dz) || 1;
        dx /= dl; dy /= dl; dz /= dl;
        // Orthonormal basis around the axis: side + up from radial direction
        const rl = Math.hypot(sx, sy, sz) || 1;
        let cx = dy * (sz / rl) - dz * (sy / rl);
        let cy = dz * (sx / rl) - dx * (sz / rl);
        let cz = dx * (sy / rl) - dy * (sx / rl);
        let cl = Math.hypot(cx, cy, cz);
        if (cl > 1e-6) { cx /= cl; cy /= cl; cz /= cl; }
        else { cx = 1; cy = 0; cz = 0; }
        // up = cross(side, dir)
        const ux = cy * dz - cz * dy;
        const uy = cz * dx - cx * dz;
        const uz = cx * dy - cy * dx;
        const s = TRI_SIZE;
        // tip ahead, three base corners behind (dart / tetrahedron)
        const tipX = sx + dx * s, tipY = sy + dy * s, tipZ = sz + dz * s;
        tipPositions[i * 3] = tipX;
        tipPositions[i * 3 + 1] = tipY;
        tipPositions[i * 3 + 2] = tipZ;
        const bX = sx - dx * s * 0.6, bY = sy - dy * s * 0.6, bZ = sz - dz * s * 0.6;
        const br = s * 0.38;
        const a1X = bX + cx * br, a1Y = bY + cy * br, a1Z = bZ + cz * br;
        const a2X = bX - (cx * br * 0.5) + ux * br * 0.87, a2Y = bY - (cy * br * 0.5) + uy * br * 0.87, a2Z = bZ - (cz * br * 0.5) + uz * br * 0.87;
        const a3X = bX - (cx * br * 0.5) - ux * br * 0.87, a3Y = bY - (cy * br * 0.5) - uy * br * 0.87, a3Z = bZ - (cz * br * 0.5) - uz * br * 0.87;

        // Single muted color: unselected darts recede; the selected one pops yellow
        const cr = BASE_DART_R, cg = BASE_DART_G, cb = BASE_DART_B;
        // 4 faces: tip-a1-a2, tip-a2-a3, tip-a3-a1, base a1-a3-a2 (winding for outward normals)
        const o = i * 36;
        const V = [tipX,tipY,tipZ, a1X,a1Y,a1Z, a2X,a2Y,a2Z,
                   tipX,tipY,tipZ, a2X,a2Y,a2Z, a3X,a3Y,a3Z,
                   tipX,tipY,tipZ, a3X,a3Y,a3Z, a1X,a1Y,a1Z,
                   a1X,a1Y,a1Z, a3X,a3Y,a3Z, a2X,a2Y,a2Z];
        for (let k = 0; k < 12; k++) {
            triPositions[o + k * 3] = V[k * 3];
            triPositions[o + k * 3 + 1] = V[k * 3 + 1];
            triPositions[o + k * 3 + 2] = V[k * 3 + 2];
            triColors[o + k * 3] = cr;
            triColors[o + k * 3 + 1] = cg;
            triColors[o + k * 3 + 2] = cb;
        }
    }
    cloud.geometry.attributes.position.needsUpdate = true;
    cloud.geometry.attributes.color.needsUpdate = true;
    cloud.geometry.computeVertexNormals();
    applyHighlight();
}

function countRegimes() {
    let leo = 0, meo = 0, geo = 0, other = 0;
    for (let i = 0; i < catalog.count(); i++) {
        const x = cloudPositions[i * 3], y = cloudPositions[i * 3 + 1], z = cloudPositions[i * 3 + 2];
        const r = Math.sqrt(x * x + y * y + z * z) * RE; // km
        if (r > GEO_R_KM) geo++;
        else if (r > MEO_LO_KM && r < MEO_HI_KM) meo++;
        else if (r > 1) leo++;
        else other++;
    }
    return { leo, meo, geo, other };
}

function applyHighlight() {
    if (!cloud || !catalog || !triColors) return;
    const colAttr = cloud.geometry.attributes.color;
    // restore previously selected dart to the muted base color
    if (highlightIndex >= 0) {
        for (let k = 0; k < 12; k++) {
            colAttr.array[highlightIndex * 36 + k * 3] = BASE_DART_R;
            colAttr.array[highlightIndex * 36 + k * 3 + 1] = BASE_DART_G;
            colAttr.array[highlightIndex * 36 + k * 3 + 2] = BASE_DART_B;
        }
    }
    highlightIndex = -1;
    const sel = selectedObject?.noradId != null ? idToIndex.get(Number(selectedObject.noradId)) : -1;
    if (sel >= 0) {
        highlightIndex = sel;
        for (let k = 0; k < 12; k++) {
            colAttr.array[sel * 36 + k * 3] = SEL_DART_R;
            colAttr.array[sel * 36 + k * 3 + 1] = SEL_DART_G;
            colAttr.array[sel * 36 + k * 3 + 2] = SEL_DART_B;
        }
        colAttr.needsUpdate = true;
    }
}

// ============================================================
// 3D SCENE
// ============================================================
function init3DScene() {
    const container = document.getElementById('viewport-container');
    const canvas = document.getElementById('three-canvas');

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.01, 5000);
    camera.position.set(0.8, 1.4, 2.3); // start close on the LEO shell

    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.minDistance = 1.5;
    controls.maxDistance = 1000;

    scene.add(new THREE.AmbientLight(0x404060, 0.6));
    sunLight = new THREE.DirectionalLight(0xffffff, 1.5);
    scene.add(sunLight);

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

    // Moon orbit ring
    moonOrbitLine = new THREE.Line(
        new THREE.BufferGeometry(),
        new THREE.LineBasicMaterial({ color: 0x4fc3f7, opacity: 0.25, transparent: true })
    );
    scene.add(moonOrbitLine);

    // Reference orbit indicators. Earth's spin axis is scene +Y (ECI z -> scene y).
    addRing(42157, 0xff9800, 0.5);                    // GEO (42157 km geocentric)
    for (let plane = 0; plane < 6; plane++)           // GPS: 6 planes, 55 deg inc
        addRing(RE + 20200, 0x66bb6a, 0.2, plane * Math.PI / 3, 55);
    addRing(MOON_DIST, 0x4fc3f7, 0.1);                // mean moon distance (geocentric)

    // Lagrange points L1/L2 on the +X Earth-Moon line (moon starts on +X)
    const moonDistU = MOON_DIST / RE;
    for (const d of [moonDistU * 0.85, moonDistU * 1.15]) {
        const marker = new THREE.Mesh(
            new THREE.OctahedronGeometry(0.3),
            new THREE.MeshBasicMaterial({ color: 0xe91e63, wireframe: true, transparent: true, opacity: 0.6 })
        );
        marker.position.set(d, 0, 0);
        scene.add(marker);
    }



    // Selected-object label that follows the dart in screen space
    selLabelEl = document.createElement('div');
    selLabelEl.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;display:none';
    selLabelEl.className = ''; // styled via #selected-label
    selLabelEl.id = 'selected-label';
    // remove the static one from HTML? keep; we re-parent: move it into container
    document.getElementById('viewport-container').appendChild(selLabelEl);

    // Screen-projected labels
    const labels = [
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

    // Click-to-pick on the cloud (screen-space: pick the dot nearest to the click
    // among those under the cursor, not whatever the ray happens to pass closest to)
    let downAt = null;
    canvas.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
    canvas.addEventListener('pointerup', (e) => {
        if (!downAt || !cloud) return;
        const moved = Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]);
        downAt = null;
        if (moved > 5) return; // was a drag (orbit control), not a pick

        const rect = canvas.getBoundingClientRect();
        const px = e.clientX - rect.left;
        const py = e.clientY - rect.top;

        // Project every catalog dot to screen space, find the closest within radius
        const w = rect.width, h = rect.height;
        // Pick radius grows with on-screen dart size so big darts stay clickable
        const pxPerUnit = h / (2 * camera.position.length() * Math.tan(camera.fov * Math.PI / 360));
        const pickRadiusPx = Math.max(12, TRI_SIZE * 2.2 * pxPerUnit);
        // Candidates: both the dart centroid and its tip count as hit targets.
        // Reject Earth-occluded darts, then pick the one nearest the camera (that's
        // the dart whose depth won and is visibly on top).
        const camPos = camera.position;
        const candidates = [];
        const v = new THREE.Vector3();
        for (let i = 0; i < catalog.count(); i++) {
            const wx = cloudPositions[i * 3], wy = cloudPositions[i * 3 + 1], wz = cloudPositions[i * 3 + 2];
            const wr = Math.hypot(wx, wy, wz);
            if (wr > 1e8) continue; // parked/failed
            v.set(wx, wy, wz);
            const eyeZ = v.applyMatrix4(camera.matrixWorldInverse).z;
            if (eyeZ > -0.01) continue; // behind camera
            // Earth occlusion: is the segment camera->dart blocked by the unit sphere?
            if (wr < 1) continue; // inside Earth
            const dx = wx - camPos.x, dy = wy - camPos.y, dz = wz - camPos.z;
            const segLen2 = dx * dx + dy * dy + dz * dz;
            const t = -(camPos.x * dx + camPos.y * dy + camPos.z * dz) / segLen2;
            if (t > 0 && t < 1) {
                const cx = camPos.x + dx * t, cy = camPos.y + dy * t, cz = camPos.z + dz * t;
                if (cx * cx + cy * cy + cz * cz < 0.998) continue; // blocked by Earth
            }
            v.project(camera);
            if (v.z > 1) continue;
            const sx = (v.x * 0.5 + 0.5) * w;
            const sy = (-v.y * 0.5 + 0.5) * h;
            // hit distance: min over centroid and tip
            const tx = tipPositions[i * 3], ty = tipPositions[i * 3 + 1], tz = tipPositions[i * 3 + 2];
            v.set(tx, ty, tz).project(camera);
            const tsx = (v.x * 0.5 + 0.5) * w, tsy = (-v.y * 0.5 + 0.5) * h;
            const d = Math.min(
                Math.hypot(sx - px, sy - py),
                Math.hypot(tsx - px, tsy - py)
            );
            if (d <= pickRadiusPx) candidates.push([i, eyeZ, d]);
        }
        if (candidates.length) {
            // nearest to camera first; among near-equals, prefer smaller screen distance
            candidates.sort((a, b) => (b[1] - a[1]) || (a[2] - b[2]));
            selectCatalogObject(Number(catalogIds[candidates[0][0]]));
        }
    });

    function animate(now) {
        requestAnimationFrame(animate);
        controls.update();
        renderer.render(scene, camera);
        for (const label of labelEls) {
            const p = label.pos.clone().project(camera);
            if (p.z > 1) { label.el.style.display = 'none'; continue; }
            label.el.style.display = '';
            label.el.style.transform =
                `translate(${(p.x * 0.5 + 0.5) * container.clientWidth}px, ${(-p.y * 0.5 + 0.5) * container.clientHeight}px)`;
        }
        // Selected-object annotation follows its dart
        if (selLabelEl) {
            if (highlightIndex >= 0 && cloudPositions) {
                const v = new THREE.Vector3(
                    cloudPositions[highlightIndex * 3],
                    cloudPositions[highlightIndex * 3 + 1],
                    cloudPositions[highlightIndex * 3 + 2]).project(camera);
                if (v.z <= 1) {
                    selLabelEl.style.display = 'block';
                    selLabelEl.style.transform =
                        `translate(${(v.x * 0.5 + 0.5) * container.clientWidth + 8}px, ${(-v.y * 0.5 + 0.5) * container.clientHeight - 14}px)`;
                } else {
                    selLabelEl.style.display = 'none';
                }
            } else {
                selLabelEl.style.display = 'none';
            }
        }
        updateSimulation();
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
function addRing(radiusKm, color, opacity, raan = 0, incDeg = 0) {
    const r = radiusKm / RE;
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
// SELECTION
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
        const inc = parseFloat(line2.substring(8, 16).trim()) || null;
        selectedObject = {
            name,
            noradId: Number(satellite.getNoradId()),
            inclination_deg: inc,
            description: selectedObject?.noradId === Number(satellite.getNoradId())
                ? (selectedObject.description || '') : 'Custom TLE',
        };
        epochDate = new Date(satellite.getEpoch());
        periodMin = 0; // recompute for the new orbit
        if (selLabelEl) {
            selLabelEl.textContent = `${name} · ${Number(satellite.getNoradId())}`;
        }
        updateStatus(`Loaded ${name} — propagating with SGP4...`);
        refreshDetail(true);
        updateSimulation();
    } catch (e) {
        updateStatus(`TLE parse error: ${e.message}`);
    }
}

function selectCatalogObject(noradId, description = '') {
    const idx = idToIndex?.get(Number(noradId));
    const name = (idx != null && catalogNames[idx]) || `NORAD ${noradId}`;
    selectedObject = { name, noradId: Number(noradId), description };

    if (idx != null && catalogTles[idx]) {
        loadTle(name, catalogTles[idx][0], catalogTles[idx][1]);
    } else {
        loadObjectByNorad(noradId, name);
    }
}

// ============================================================
// DETAILED PROPAGATION (selected object)
// Window: half a period back to 1.5 periods forward from sim time.
// Refreshed ~1 Hz (cheap) so the orbit line stays anchored on live time.
// ============================================================
function refreshDetail(force = false) {
    if (!satellite || !sgp4Ready) return;
    const now = performance.now();
    if (!force && now - lastDetailRefresh < 1000) return;
    lastDetailRefresh = now;

    // Period from a vis-viva snapshot if not known yet
    if (!periodMin) {
        const p0 = satellite.propagate(0);
        const r0 = Math.hypot(...p0.position_eci);
        const v0 = p0.speed_km_s;
        const sma = 1 / (2 / r0 - (v0 * v0) / MU);
        periodMin = 2 * Math.PI * Math.sqrt(sma * sma * sma / MU) / 60;
    }

    const epochMs = epochDate.getTime();
    const centerMin = (simTimeMs() - epochMs) / 60000;
    const backMin = periodMin / 2;
    const fwdMin = periodMin * 1.5;
    const spanMin = backMin + fwdMin;
    const stepMin = Math.max(spanMin / 480, 0.1);

    const t0 = performance.now();
    const batch = satellite.propagateBatch(centerMin - backMin, centerMin + fwdMin, stepMin);
    const elapsed = (performance.now() - t0).toFixed(1);

    detailResults = batch.results;
    detailCenterMin = centerMin;
    detailSpanMin = spanMin;

    drawOrbit(force);
    drawGroundTrack();

    if (force) {
        updateSelectedInfo();
    }
}

function drawOrbit(frameCamera = false) {
    if (orbitLine) {
        scene.remove(orbitLine);
        orbitLine.geometry.dispose();
        orbitLine.material.dispose();
    }
    if (!detailResults.length) return;

    const points = detailResults.map(r => eciToScene(r.position_eci));
    orbitLine = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(points),
        new THREE.LineBasicMaterial({ color: 0x4fc3f7, linewidth: 2 })
    );
    scene.add(orbitLine);

    if (frameCamera) {
        // Frame the newly selected orbit — only if the current view can't see it
        const maxR = Math.max(...detailResults.map(r => Math.hypot(...r.position_eci))) / RE;
        const camR = camera.position.length();
        if (camR < maxR * 1.2 || camR > maxR * 8) {
            const d = Math.max(maxR * 2.5, 3);
            camera.position.set(d * 0.3, d * 0.5, d * 0.8);
            controls.target.set(0, 0, 0);
            controls.update();
        }
    }
}

// Per-frame update: marker, earth rotation, moon, cloud, time display
function updateSimulation() {
    const tMs = simTimeMs();
    const simDate = new Date(tMs);

    // Time display
    const disp = document.getElementById('time-display');
    if (isLive()) {
        disp.textContent = 'LIVE ' + simDate.toISOString().slice(11, 19) + 'Z';
        disp.classList.remove('scrubbed');
    } else {
        const offMin = scrubOffsetMs / 60000;
        const sign = offMin >= 0 ? '+' : '−';
        const abs = Math.abs(offMin);
        const h = Math.floor(abs / 60), m = Math.round(abs % 60);
        disp.textContent = `${sign}${h ? h + 'h ' : ''}${m}m · ${simDate.toISOString().slice(11, 19)}Z`;
        disp.classList.add('scrubbed');
    }

    // Selected object: update the ground-track marker (its triangle is in the cloud)
    if (satellite && epochDate) {
        const minutes = (tMs - epochDate.getTime()) / 60000;
        try {
            const r = satellite.propagate(minutes);
            updateGroundTrackMarker(r);
        } catch (e) { /* outside propagable range */ }
    }

    // Sun direction from real solar ephemeris (day/night terminator correct for sim time)
    if (sunLight) {
        const sp = AstroEngine.sunPosition(simDate);
        sunLight.position.set(sp.x / RE, sp.z / RE, -sp.y / RE);
    }

    // Earth rotation
    if (earthMesh) {
        const gmst = AstroEngine.gmst(simDate);
        earthMesh.rotation.y = gmst;
        earthWire.rotation.y = gmst;
    }

    // Moon
    const mp = AstroEngine.moonPosition(simDate);
    moonMesh.position.copy(eciToScene([mp.x, mp.y, mp.z]));

    // Catalog cloud: throttled to ~5 Hz
    const now = performance.now();
    if (catalog && cloud && now - updateSimulation.lastCloud > 200) {
        updateSimulation.lastCloud = now;
        propagateSnapshot();
    }

    // Detail refresh ~1 Hz (keeps orbit/ground track anchored on live time)
    if (satellite) refreshDetail(false);
}
updateSimulation.lastCloud = 0;

// ============================================================
// GROUND TRACK (cached track + per-frame marker)
// ============================================================
function drawGroundTrack() {
    const canvas = document.getElementById('groundtrack-canvas');
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width) return;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;

    const off = document.createElement('canvas');
    off.width = canvas.width;
    off.height = canvas.height;
    const octx = off.getContext('2d');
    octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawTrackInto(octx, rect.width, rect.height);
    groundTrackCache = off;

    if (detailResults.length) updateGroundTrackMarker(nearestDetail());
}

function drawTrackInto(ctx, W, H) {
    const ml = 8, mr = 8, mt = 8, mb = 16;
    const pw = W - ml - mr, ph = H - mt - mb;
    const lonToX = lon => ml + ((lon + 180) / 360) * pw;
    const latToY = lat => mt + ((90 - lat) / 180) * ph;

    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.strokeRect(ml, mt, pw, ph);
    ctx.beginPath(); ctx.moveTo(ml, latToY(0)); ctx.lineTo(ml + pw, latToY(0)); ctx.stroke();

    // World map outline (loaded once)
    if (landLines) {
        ctx.strokeStyle = 'rgba(140,160,180,0.35)';
        ctx.lineWidth = 0.7;
        for (const line of landLines) {
            ctx.beginPath();
            ctx.moveTo(lonToX(line[0][0]), latToY(line[0][1]));
            for (let i = 1; i < line.length; i++) {
                ctx.lineTo(lonToX(line[i][0]), latToY(line[i][1]));
            }
            ctx.stroke();
        }
    }

    if (!detailResults.length) return;
    ctx.strokeStyle = '#4fc3f7';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (let i = 0; i < detailResults.length; i++) {
        const r = detailResults[i];
        if (i > 0 && Math.abs(r.longitude_deg - detailResults[i - 1].longitude_deg) > 180) {
            ctx.stroke(); ctx.beginPath();
        }
        i === 0 ? ctx.moveTo(lonToX(r.longitude_deg), latToY(r.latitude_deg))
                : ctx.lineTo(lonToX(r.longitude_deg), latToY(r.latitude_deg));
    }
    ctx.stroke();
}

function nearestDetail() {
    if (!detailResults.length) return null;
    const epochMs = epochDate.getTime();
    const target = (simTimeMs() - epochMs) / 60000;
    let best = detailResults[0], bestD = Infinity;
    for (const r of detailResults) {
        const d = Math.abs(r.minutes_since_epoch - target);
        if (d < bestD) { bestD = d; best = r; }
    }
    return best;
}

function updateGroundTrackMarker(r) {
    const canvas = document.getElementById('groundtrack-canvas');
    if (!groundTrackCache || !canvas.width || !r) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(groundTrackCache, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
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
function updateSelectedInfo() {
    const section = document.getElementById('selected-section');
    const info = document.getElementById('selected-info');
    if (!selectedObject || !satellite) {
        section.style.display = 'none';
        return;
    }
    section.style.display = 'block';
    let altMin = null, altMax = null;
    if (detailResults.length) {
        altMin = Math.min(...detailResults.map(r => r.altitude_km));
        altMax = Math.max(...detailResults.map(r => r.altitude_km));
    }
    const ecc = (altMax != null) ? (altMax - altMin) / (altMax + altMin + 2 * RE) : null;
    info.innerHTML =
        `<div class="obj-line"><span class="obj-name">${selectedObject.name}</span><span class="v">${selectedObject.noradId}</span></div>` +
        (selectedObject.description ? `<div class="obj-line"><span>${selectedObject.description}</span></div>` : '') +
        `<div class="obj-line">TLE epoch <span class="v">${epochDate.toISOString().slice(0, 16)}Z</span></div>` +
        `<div class="obj-line">Inclination <span class="v">${selectedObject.inclination_deg?.toFixed(2) ?? '?'}°</span></div>` +
        `<div class="obj-line">Period <span class="v">${periodMin.toFixed(1)} min</span></div>` +
        (altMin != null ? `<div class="obj-line">Perigee <span class="v">${altMin.toFixed(0)} km</span></div>` +
        `<div class="obj-line">Apogee <span class="v">${altMax.toFixed(0)} km</span></div>` +
        `<div class="obj-line">Eccentricity <span class="v">${ecc.toFixed(4)}</span></div>` : '');
}

function renderKnownObjects() {
    const select = document.getElementById('object-select');
    select.innerHTML = WELL_KNOWN_OBJECTS.map((obj, i) =>
        `<option value="${i}">${obj.name} (${obj.orbitType})</option>`
    ).join('');
    select.addEventListener('change', () => {
        const obj = WELL_KNOWN_OBJECTS[parseInt(select.value)];
        selectCatalogObject(obj.noradId, obj.description);
    });
}

function setupEventListeners() {
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

    // Catalog search with live dropdown
    document.getElementById('search-input').addEventListener('input', (e) => {
        const query = e.target.value.trim().toLowerCase();
        const listEl = document.getElementById('search-results');
        if (!catalog || query.length < 2) { listEl.style.display = 'none'; return; }
        const matches = [];
        for (let idx = 0; idx < catalogNames.length; idx++) {
            const name = catalogNames[idx];
            if (name && name.toLowerCase().includes(query)) {
                matches.push({ id: Number(catalogIds[idx]), name });
                if (matches.length >= 12) break;
            }
        }
        listEl.innerHTML = matches.map(m =>
            `<div class="search-item" data-id="${m.id}">${m.name} <span>${m.id}</span></div>`
        ).join('');
        listEl.style.display = matches.length ? 'block' : 'none';
        listEl.querySelectorAll('.search-item').forEach(el => {
            el.addEventListener('click', () => {
                selectCatalogObject(parseInt(el.dataset.id));
                listEl.style.display = 'none';
            });
        });
    });
    document.addEventListener('click', (e) => {
        if (!e.target.closest('#search-input') && !e.target.closest('#search-results')) {
            document.getElementById('search-results').style.display = 'none';
        }
    });

    // Time scrubber: offset from live. Always running — no pause.
    const slider = document.getElementById('time-slider');
    slider.max = MAX_SCRUB_MIN;
    slider.min = -MAX_SCRUB_MIN;
    slider.step = 1;
    slider.value = 0;
    slider.addEventListener('input', () => {
        scrubOffsetMs = parseInt(slider.value) * 60000;
        lastDetailRefresh = 0; // force detail refresh at the new time
        updateSimulation();
    });
    document.getElementById('btn-live').addEventListener('click', () => {
        scrubOffsetMs = 0;
        slider.value = 0;
        lastDetailRefresh = 0;
        updateSimulation();
    });
}

function updateStatus(html) { document.getElementById('status-text').innerHTML = html; }

initialize().catch(e => {
    updateStatus(`Init error: ${e.message}`);
    console.error(e);
});
