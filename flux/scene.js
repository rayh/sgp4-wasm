/**
 * 3D scene for the flux dashboard: Earth with day/night, mean-distance Moon,
 * reference rings, the orbit line colored by local flux, and volumetric
 * density shells driven by the environment heatmap (altitude -> radius,
 * inclination -> opacity, flux -> hue).
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export const RE = 6371;
const RM = 1737.4;
const MOON_DIST = 384400;

let scene, camera, renderer, controls, container;
let earthMesh, earthWire, moonMesh;
let orbitLine = null, selMarker = null;
let shells = [];

export function initScene() {
    container = document.getElementById('viewport-container');
    const canvas = document.getElementById('three-canvas');

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.01, 5000);
    camera.position.set(0, 6, 14);

    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.minDistance = 1.3;
    controls.maxDistance = 400;

    scene.add(new THREE.AmbientLight(0x404050, 0.9));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(50, 20, 30);
    scene.add(sun);

    // starfield
    const starPos = new Float32Array(1500 * 3);
    for (let i = 0; i < 1500; i++) {
        const th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1);
        const r = 300 + Math.random() * 200;
        starPos[i * 3] = r * Math.sin(ph) * Math.cos(th);
        starPos[i * 3 + 1] = r * Math.sin(ph) * Math.sin(th);
        starPos[i * 3 + 2] = r * Math.cos(ph);
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
    scene.add(new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xffffff, size: 0.35 })));

    // Earth (unlit-ish so the night side stays readable; emissive dominates)
    const tex = new THREE.TextureLoader().load(
        'https://unpkg.com/three-globe@2.31.1/example/img/earth-blue-marble.jpg',
        () => {}, undefined,
        () => { earthMesh.material.map = null; earthMesh.material.color.set(0x16283c); }
    );
    earthMesh = new THREE.Mesh(
        new THREE.SphereGeometry(1, 64, 64),
        new THREE.MeshPhongMaterial({ map: tex, emissive: 0x0a1220, specular: 0x111820, shininess: 8 })
    );
    scene.add(earthMesh);
    earthWire = new THREE.LineSegments(
        new THREE.WireframeGeometry(new THREE.SphereGeometry(1.002, 16, 16)),
        new THREE.LineBasicMaterial({ color: 0x4488ff, opacity: 0.06, transparent: true })
    );
    scene.add(earthWire);

    // Moon at mean distance (visual reference, not ephemeris — this is an
    // environment dashboard, not a propagator showcase)
    moonMesh = new THREE.Mesh(
        new THREE.SphereGeometry(RM / RE, 24, 24),
        new THREE.MeshPhongMaterial({ color: 0x9a9a9a, emissive: 0x111111 })
    );
    moonMesh.position.set(MOON_DIST / RE, 0, 0);
    scene.add(moonMesh);
    scene.add(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(circlePoints(MOON_DIST / RE, 128)),
        new THREE.LineBasicMaterial({ color: 0x4fc3f7, opacity: 0.12, transparent: true })
    ));

    // reference rings
    addRing(RE + 20200, 0x66bb6a, 0.18); // MEO/GPS
    addRing(42157, 0xff9800, 0.35);      // GEO
    addRing(RE + 500, 0x4fc3f7, 0.1);    // LEO

    // selected-object marker
    selMarker = new THREE.Mesh(
        new THREE.SphereGeometry(0.04, 12, 12),
        new THREE.MeshBasicMaterial({ color: 0xffff33 })
    );
    selMarker.visible = false;
    scene.add(selMarker);

    window.addEventListener('resize', () => {
        const w = container.clientWidth, h = container.clientHeight;
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);
    });

    (function animate() {
        requestAnimationFrame(animate);
        controls.update();
        renderer.render(scene, camera);
    })();
}

function circlePoints(r, n) {
    const pts = [];
    for (let i = 0; i <= n; i++) {
        const a = (i / n) * Math.PI * 2;
        pts.push(new THREE.Vector3(r * Math.cos(a), 0, r * Math.sin(a)));
    }
    return pts;
}

function addRing(radiusKm, color, opacity) {
    scene.add(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(circlePoints(radiusKm / RE, 128)),
        new THREE.LineBasicMaterial({ color, opacity, transparent: true })
    ));
}

function eciToScene(p) {
    return new THREE.Vector3(p[0] / RE, p[2] / RE, -p[1] / RE);
}

/** Orbit line with per-vertex color by local flux (blue = low, red = high). */
export function drawOrbit(points) {
    if (orbitLine) {
        scene.remove(orbitLine);
        orbitLine.geometry.dispose();
        orbitLine.material.dispose();
    }
    if (!points || !points.length) return;
    const pos = new Float32Array(points.length * 3);
    const col = new Float32Array(points.length * 3);
    const lg = p => Math.log10(Math.max(p.flux_1mm, 1e-12));
    const lMin = Math.min(...points.map(lg)), lMax = Math.max(...points.map(lg));
    const c = new THREE.Color();
    points.forEach((p, i) => {
        const v = eciToScene(p.position_eci);
        pos[i * 3] = v.x; pos[i * 3 + 1] = v.y; pos[i * 3 + 2] = v.z;
        const t = lMax > lMin ? (lg(p) - lMin) / (lMax - lMin) : 0.5;
        c.setHSL(0.58 - t * 0.58, 0.9, 0.45 + t * 0.15);
        col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    orbitLine = new THREE.Line(g, new THREE.LineBasicMaterial({ vertexColors: true, linewidth: 2 }));
    scene.add(orbitLine);

    selMarker.visible = true;
    selMarker.position.copy(eciToScene(points[0].position_eci));

    // frame the orbit if it's outside the current view
    const maxR = Math.max(...points.map(p => Math.hypot(...p.position_eci))) / RE;
    const camR = camera.position.length();
    if (camR < maxR * 1.2 || camR > maxR * 8) {
        const d = Math.max(maxR * 2.6, 3.5);
        camera.position.set(d * 0.35, d * 0.45, d * 0.82);
        controls.target.set(0, 0, 0);
        controls.update();
    }
}

/** Volumetric density shells from the environment heatmap. */
export function buildShells(heatmap) {
    for (const s of shells) {
        scene.remove(s);
        s.geometry.dispose();
        s.material.dispose();
    }
    shells = [];
    if (!heatmap) return;

    const alts = heatmap.altitudes_km;
    const incs = heatmap.inclinations_deg;
    const grid = heatmap.flux_1mm;
    const nA = alts.length, nI = incs.length;

    let min = Infinity, max = -Infinity;
    for (const row of grid) for (const v of row) {
        if (v > 0) { const l = Math.log10(v); if (l < min) min = l; if (l > max) max = l; }
    }

    for (let ai = 0; ai < nA; ai++) {
        const alt = alts[ai];
        const row = grid[ai];
        const maxFlux = Math.max(...row);
        if (maxFlux <= 0) continue;
        const t = (Math.log10(maxFlux) - min) / Math.max(max - min, 1e-9);
        const rMid = (RE + alt) / RE;
        const color = new THREE.Color().setHSL(0.58 - t * 0.58, 0.85, 0.5);
        const mesh = new THREE.Mesh(
            new THREE.SphereGeometry(rMid, 48, 32),
            new THREE.MeshBasicMaterial({
                color,
                transparent: true,
                opacity: 0.02 + t * 0.07,
                side: THREE.BackSide,
                depthWrite: false,
            })
        );
        mesh.renderOrder = -1; // behind orbit line
        scene.add(mesh);
        shells.push(mesh);
    }
}

export function setSelMarker(point) {
    if (selMarker && point) selMarker.position.copy(eciToScene(point.position_eci));
}

export function frameOrbitOnSelect(maxR) {
    const d = Math.max(maxR * 2.6, 3.5);
    camera.position.set(d * 0.35, d * 0.45, d * 0.82);
    controls.target.set(0, 0, 0);
    controls.update();
}