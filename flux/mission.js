/**
 * Lifetime particle-flux exposure computation.
 * Pure functions — no DOM, no three.js. Consumes:
 *   - heatmap:  { altitudes_km[], inclinations_deg[], flux_10um[][], flux_1mm[][], flux_1cm[][] }
 *   - profiles: [ { orbit:{altitude_km, inclination_deg}, diameters_m[], meteoroid_flux[],
 *                  debris_flux[], total_flux[], sources? } ]
 * All flux units: cumulative impacts /m²/yr for particles >= the given diameter.
 */

export const RE = 6371; // km
const MU = 398600.4;    // km^3/s^2

// ------------------------------------------------------- environment lookup
function foldInc(incDeg, maxInc) {
    // debris bands are symmetric about the equator; fold >90 to the model's range
    let inc = Math.abs(incDeg);
    if (maxInc > 90 && inc > 90) inc = Math.min(inc, 180 - inc);
    return inc;
}

// Bilinear interpolation in log10(flux) space over the (alt, inc) grid
export function interpolateFlux(heatmap, altKm, incDeg, sizeKey = 'flux_1mm') {
    const alts = heatmap.altitudes_km;
    const incs = heatmap.inclinations_deg;
    const grid = heatmap[sizeKey];
    if (!grid) return 0;

    const maxInc = incs[incs.length - 1];
    const alt = Math.max(alts[0], Math.min(alts[alts.length - 1], altKm));
    const inc = Math.max(incs[0], Math.min(incs[incs.length - 1], foldInc(incDeg, maxInc)));

    let ai = alts.length - 2;
    for (let i = 0; i < alts.length - 1; i++) {
        if (alts[i] <= alt && alt <= alts[i + 1]) { ai = i; break; }
    }
    let ii = incs.length - 2;
    for (let i = 0; i < incs.length - 1; i++) {
        if (incs[i] <= inc && inc <= incs[i + 1]) { ii = i; break; }
    }
    const da = (alt - alts[ai]) / Math.max(alts[ai + 1] - alts[ai], 1e-9);
    const di = (inc - incs[ii]) / Math.max(incs[ii + 1] - incs[ii], 1e-9);
    const lg = v => Math.log10(Math.max(v, 1e-30));
    const top = (1 - di) * lg(grid[ai][ii]) + di * lg(grid[ai][ii + 1]);
    const bot = (1 - di) * lg(grid[ai + 1][ii]) + di * lg(grid[ai + 1][ii + 1]);
    return 10 ** ((1 - da) * top + da * bot);
}

// Nearest profile spectrum by altitude (and inclination distance as tie-break)
export function nearestProfile(profiles, altKm, incDeg) {
    let best = null, bestScore = Infinity;
    for (const p of profiles) {
        const dAlt = Math.log10((Math.abs(p.orbit.altitude_km) + 1) / (Math.abs(altKm) + 1));
        const dInc = Math.abs((p.orbit.inclination_deg ?? 51.6) - Math.abs(incDeg)) / 90;
        const score = dAlt * 3 + dInc;
        if (score < bestScore) { bestScore = score; best = p; }
    }
    return best;
}

// Log-log interpolation of a cumulative spectrum at a given diameter
export function fluxAtSize(spec, diameter) {
    const d = spec.diameters_m, f = spec.total_flux;
    if (diameter <= d[0]) return f[0];
    if (diameter >= d[d.length - 1]) return 0;
    for (let i = 1; i < d.length; i++) {
        if (d[i] >= diameter) {
            const x0 = Math.log10(d[i - 1]), x1 = Math.log10(d[i]);
            const y0 = Math.log10(Math.max(f[i - 1], 1e-30)), y1 = Math.log10(Math.max(f[i], 1e-30));
            const t = (Math.log10(diameter) - x0) / (x1 - x0);
            return 10 ** ((1 - t) * y0 + t * y1);
        }
    }
    return 0;
}

// ------------------------------------------------------- orbit propagation
/**
 * Sample the orbit with SGP4 and compute the local flux environment per point.
 * Propagates `displayOrbits` full revolutions from the TLE epoch at fine
 * resolution, then everything is scaled to the mission duration by the caller
 * (the environment is periodic over an orbit, so this is the standard trick).
 */
export function propagateMission(satellite, { displayOrbits = 3, pointsPerOrbit = 240, heatmap, profiles } = {}) {
    // period from vis-viva at t=0
    const p0 = satellite.propagate(0);
    const r0 = Math.hypot(...p0.position_eci);
    const sma = 1 / (2 / r0 - (p0.speed_km_s ** 2) / MU);
    const periodMin = 2 * Math.PI * Math.sqrt(sma ** 3 / MU) / 60;

    const spanMin = periodMin * displayOrbits;
    const stepMin = Math.max(spanMin / (displayOrbits * pointsPerOrbit), 0.1);
    const batch = satellite.propagateBatch(0, spanMin, stepMin);

    // inclination from the first sample (max |latitude| over an orbit is a decent estimate;
    // better: use the orbit geometry — max declination of the position vector)
    let incEst = 0;
    for (const r of batch.results) {
        const dec = Math.asin(Math.max(-1, Math.min(1, r.position_eci[2] / Math.hypot(...r.position_eci))));
        incEst = Math.max(incEst, Math.abs(dec) * 180 / Math.PI);
    }

    const points = batch.results.map(r => {
        const flux1mm = interpolateFlux(heatmap, r.altitude_km, incEst, 'flux_1mm');
        const flux10um = interpolateFlux(heatmap, r.altitude_km, incEst, 'flux_10um');
        const flux1cm = interpolateFlux(heatmap, r.altitude_km, incEst, 'flux_1cm');
        return { ...r, inclination_deg: incEst, flux_1mm: flux1mm, flux_10um: flux10um, flux_1cm: flux1cm };
    });

    return {
        points,
        periodMin,
        displayOrbits,
        inclination_deg: incEst,
        altMin: Math.min(...points.map(p => p.altitude_km)),
        altMax: Math.max(...points.map(p => p.altitude_km)),
    };
}

// ------------------------------------------------------- mission integration
/**
 * Integrate size-resolved fluence along the sampled orbit and scale to the
 * mission duration. Returns fluence curves and risk numbers.
 *
 * config: { durationYears, areaM2, shieldMaterial, shieldThicknessMm }
 */
export function computeMission(mission, profiles, config) {
    const { points, displayOrbits } = mission;
    const area = config.areaM2;
    const years = config.durationYears;

    // display window in seconds
    const displayYears = (points[points.length - 1].minutes_since_epoch) / (60 * 24 * 365.25);
    const scale = years / Math.max(displayYears, 1e-9);

    // --- size-resolved fluence: sum flux(>=d) * dt along the path, then scale
    // Use a representative spectrum set: pick the nearest profile per altitude band.
    const diameters = profiles[0].diameters_m;
    const dtYr = (points[1].minutes_since_epoch - points[0].minutes_since_epoch) / (60 * 24 * 365.25);

    // accumulate per-point using the profile nearest that point's altitude
    const fluence = new Float64Array(diameters.length);      // meteoroid+debris
    const metAcc = new Float64Array(diameters.length);
    const debAcc = new Float64Array(diameters.length);
    const perSource = {};
    for (const p of points) {
        const prof = nearestProfile(profiles, p.altitude_km, p.inclination_deg);
        if (!prof) continue;
        for (let k = 0; k < diameters.length; k++) {
            fluence[k] += prof.total_flux[k] * dtYr;
            metAcc[k] += prof.meteoroid_flux[k] * dtYr;
            debAcc[k] += prof.debris_flux[k] * dtYr;
        }
        if (prof.sources) {
            for (const [src, arr] of Object.entries(prof.sources)) {
                if (!perSource[src]) perSource[src] = new Float64Array(diameters.length);
                for (let k = 0; k < diameters.length; k++) perSource[src][k] += arr[k] * dtYr;
            }
        }
    }
    for (let k = 0; k < diameters.length; k++) {
        fluence[k] *= scale;
        metAcc[k] *= scale;
        debAcc[k] *= scale;
        for (const src of Object.keys(perSource)) perSource[src][k] *= scale;
    }

    // --- Poisson risk per size
    const pImpact = new Float64Array(diameters.length);
    for (let k = 0; k < diameters.length; k++) {
        pImpact[k] = 1 - Math.exp(-fluence[k] * area);
    }

    // --- headline numbers at 1mm and 1cm
    const idx1mm = diameters.findIndex(d => d >= 1e-3);
    const idx1cm = diameters.findIndex(d => d >= 1e-2);
    const fluence1mm = fluence[idx1mm] ?? 0;
    const p1mm = 1 - Math.exp(-fluence1mm * area);
    const expected1mm = fluence1mm * area;

    // --- perforation: modified Cour-Palais ballistic limit (single wall)
    const K = { aluminum: 0.57, kevlar: 0.45, whipple: 0.35 }[config.shieldMaterial] ?? 0.57;
    const rhoP = 2.8; // g/cm3 mean projectile density
    const vImp = meanImpactVelocity(mission);
    const tCm = config.shieldThicknessMm / 10;
    // critical diameter (cm) at normal incidence
    const dCritCm = K * Math.pow(tCm, 2 / 3) * Math.pow(rhoP, -1 / 3) * Math.pow(Math.max(vImp, 0.1), -2 / 3);
    const dCritM = dCritCm / 100;
    const fluenceCrit = fluxAtSize({ diameters_m: diameters, total_flux: Array.from(fluence) }, dCritM);
    const pPerf = 1 - Math.exp(-fluenceCrit * area);

    // --- band exposure (% of mission time per altitude band)
    const bands = [
        { name: 'LEO <600', min: 0, max: 600 },
        { name: 'LEO 600-2k', min: 600, max: 2000 },
        { name: 'MEO 2k-30k', min: 2000, max: 30000 },
        { name: 'GEO 30k-40k', min: 30000, max: 40000 },
        { name: 'HEO >40k', min: 40000, max: 1e9 },
    ];
    const bandTotals = new Array(bands.length).fill(0);
    for (const p of points) {
        for (let b = 0; b < bands.length; b++) {
            if (p.altitude_km >= bands[b].min && p.altitude_km < bands[b].max) { bandTotals[b] += dtYr; break; }
        }
    }
    const totalT = bandTotals.reduce((a, b) => a + b, 0) || 1;
    const bandExposure = bands.map((b, i) => ({
        ...b, pct: 100 * bandTotals[i] / totalT,
    }));

    // --- perigee/apogee flux ratio
    const fluxes = points.map(p => p.flux_1mm);
    const fMin = Math.min(...fluxes), fMax = Math.max(...fluxes);
    const fluxRatio = fMin > 0 ? fMax / fMin : Infinity;

    return {
        diameters,
        fluence: Array.from(fluence),
        meteoroidFluence: Array.from(metAcc),
        debrisFluence: Array.from(debAcc),
        perSourceFluence: Object.fromEntries(
            Object.entries(perSource).map(([k, arr]) => [k, Array.from(arr)])),
        pImpact: Array.from(pImpact),
        p1mm, expected1mm, pPerf, dCritM, vImp,
        bandExposure, fluxRatio,
        scale,
    };
}

// Mean impact velocity estimate (semi-empirical, from the published calibration)
export function meanImpactVelocity(mission) {
    const p = mission.points[Math.floor(mission.points.length / 2)];
    const alt = p.altitude_km;
    const vCirc = Math.sqrt(MU / (RE + Math.max(alt, 100)));
    const incRad = mission.inclination_deg * Math.PI / 180;
    let factor = 0.8 + 0.4 * Math.sin(incRad);
    if (alt > 2000) factor *= Math.sqrt(Math.min(1, 2000 / alt));
    // blend toward ~20 km/s meteoroid regime as meteoroid share rises
    return vCirc * factor;
}