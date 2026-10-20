/**
 * Canvas chart painters for the flux dashboard. All take a canvas + data and
 * handle DPR scaling internally. Style matches the demo (dark, amber accents).
 */

function ctx2d(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);
    return { ctx, W: rect.width, H: rect.height };
}

export function drawAltFluxChart(canvas, mission, config) {
    const { ctx, W, H } = ctx2d(canvas);
    const pts = mission.points;
    const ml = 52, mr = 52, mt = 10, mb = 20;
    const pw = W - ml - mr, ph = H - mt - mb;
    const times = pts.map(p => p.minutes_since_epoch);
    const tMax = times[times.length - 1] || 1;
    const alts = pts.map(p => p.altitude_km);
    const altMax = Math.max(...alts) * 1.05, altMin = Math.min(...alts) * 0.95;
    const lg = f => Math.log10(Math.max(f, 1e-9));
    const fluxes = pts.map(p => lg(p.flux_1mm));
    const fMin = Math.min(...fluxes) - 0.2, fMax = Math.max(...fluxes) + 0.2;

    const tX = t => ml + (t / tMax) * pw;
    const aY = a => mt + ph - ((a - altMin) / (altMax - altMin)) * ph;
    const fY = lf => mt + ph - ((lf - fMin) / (fMax - fMin)) * ph;

    // altitude bands shading
    ctx.fillStyle = 'rgba(255,152,0,0.04)';
    for (const [lo, hi] of [[600, 2000]]) {
        ctx.fillRect(ml, aY(Math.min(hi, altMax)), pw, Math.abs(aY(Math.max(lo, altMin)) - aY(Math.min(hi, altMax))));
    }

    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    for (let i = 0; i <= 4; i++) {
        const y = mt + (i / 4) * ph;
        ctx.beginPath(); ctx.moveTo(ml, y); ctx.lineTo(ml + pw, y); ctx.stroke();
    }
    // period markers
    ctx.strokeStyle = 'rgba(255,152,0,0.1)';
    for (let i = 1; i < mission.displayOrbits; i++) {
        const x = tX(i * mission.periodMin);
        ctx.beginPath(); ctx.moveTo(x, mt); ctx.lineTo(x, mt + ph); ctx.stroke();
    }

    // altitude line
    ctx.strokeStyle = '#4fc3f7'; ctx.lineWidth = 1.5; ctx.beginPath();
    pts.forEach((p, i) => i === 0 ? ctx.moveTo(tX(times[i]), aY(p.altitude_km)) : ctx.lineTo(tX(times[i]), aY(p.altitude_km)));
    ctx.stroke();

    // flux line (log)
    ctx.strokeStyle = '#ff5722'; ctx.lineWidth = 1.5; ctx.beginPath();
    pts.forEach((p, i) => i === 0 ? ctx.moveTo(tX(times[i]), fY(lg(p.flux_1mm))) : ctx.lineTo(tX(times[i]), fY(lg(p.flux_1mm))));
    ctx.stroke();

    // axes labels
    ctx.fillStyle = '#4fc3f7'; ctx.font = '9px sans-serif'; ctx.textAlign = 'right';
    ctx.fillText(`${altMax.toFixed(0)} km`, ml - 4, mt + 8);
    ctx.fillText(`${altMin.toFixed(0)}`, ml - 4, mt + ph);
    ctx.fillStyle = '#ff5722'; ctx.textAlign = 'left';
    ctx.fillText(`1e${fMax.toFixed(0)}`, ml + pw + 4, mt + 8);
    ctx.fillText(`1e${fMin.toFixed(0)}`, ml + pw + 4, mt + ph);
    ctx.fillStyle = '#607d8b'; ctx.textAlign = 'center';
    ctx.fillText('time (min since epoch)', ml + pw / 2, H - 4);
    ctx.fillStyle = '#4fc3f7'; ctx.textAlign = 'left';
    ctx.fillText('— alt', ml + 4, mt + 9);
    ctx.fillStyle = '#ff5722';
    ctx.fillText('— flux ≥1mm /m²/yr (log)', ml + 40, mt + 9);
}

export function drawFluenceChart(canvas, result) {
    const { ctx, W, H } = ctx2d(canvas);
    const d = result.diameters;
    const ml = 46, mr = 8, mt = 10, mb = 22;
    const pw = W - ml - mr, ph = H - mt - mb;
    const xMin = Math.log10(d[0]), xMax = Math.log10(d[d.length - 1]);
    const series = [
        [result.fluence, '#ffffff', 'total'],
        [result.meteoroidFluence, '#2196f3', 'meteoroid'],
        [result.debrisFluence, '#ff5722', 'debris'],
    ];
    const vals = series.flatMap(s => s[0].map((v, i) => Math.log10(Math.max(v, 1e-30))));
    const yMin = Math.min(...vals) - 0.3, yMax = Math.max(...vals) + 0.3;
    const xS = x => ml + ((x - xMin) / (xMax - xMin)) * pw;
    const yS = y => mt + ph - ((y - yMin) / (yMax - yMin)) * ph;

    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    for (let i = 0; i <= 4; i++) { const y = mt + (i / 4) * ph; ctx.beginPath(); ctx.moveTo(ml, y); ctx.lineTo(ml + pw, y); ctx.stroke(); }

    for (const [data, color] of series) {
        ctx.strokeStyle = color; ctx.lineWidth = data === result.fluence ? 2 : 1.2;
        ctx.beginPath();
        let started = false;
        d.forEach((dia, i) => {
            const v = Math.log10(Math.max(data[i], 1e-30));
            const y = yS(v);
            if (y < mt - 40) return;
            if (!started) { ctx.moveTo(xS(Math.log10(dia)), y); started = true; }
            else ctx.lineTo(xS(Math.log10(dia)), y);
        });
        ctx.stroke();
    }

    // size labels
    ctx.fillStyle = '#607d8b'; ctx.font = '9px sans-serif'; ctx.textAlign = 'center';
    for (const [dia, label] of [[1e-5, '10μm'], [1e-4, '100μm'], [1e-3, '1mm'], [1e-2, '1cm'], [1e-1, '10cm'], [1, '1m']]) {
        if (Math.log10(dia) >= xMin && Math.log10(dia) <= xMax) ctx.fillText(label, xS(Math.log10(dia)), mt + ph + 14);
    }
    ctx.textAlign = 'left';
    ctx.fillText(`per ${yMax >= -4 ? 'm²/mission' : ''}`, ml, mt - 1);
}

export function drawRiskCurve(canvas, result, config) {
    const { ctx, W, H } = ctx2d(canvas);
    const d = result.diameters;
    const ml = 46, mr = 8, mt = 10, mb = 22;
    const pw = W - ml - mr, ph = H - mt - mb;
    const xMin = Math.log10(d[0]), xMax = Math.log10(d[d.length - 1]);
    const xS = x => ml + ((x - xMin) / (xMax - xMin)) * pw;
    const yS = p => mt + ph - p * ph;

    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    for (const p of [0.001, 0.01, 0.1, 0.5, 0.9]) {
        ctx.beginPath(); ctx.moveTo(ml, yS(p)); ctx.lineTo(ml + pw, yS(p)); ctx.stroke();
        ctx.fillStyle = '#607d8b'; ctx.font = '8px sans-serif'; ctx.textAlign = 'right';
        ctx.fillText(`${p * 100}%`, ml - 3, yS(p) + 3);
    }

    ctx.strokeStyle = '#ff9800'; ctx.lineWidth = 2; ctx.beginPath();
    d.forEach((dia, i) => {
        const p = result.pImpact[i];
        if (i === 0) ctx.moveTo(xS(Math.log10(dia)), yS(p));
        else ctx.lineTo(xS(Math.log10(dia)), yS(p));
    });
    ctx.stroke();

    // perforation marker
    const dCrit = result.dCritM;
    if (dCrit > d[0] && dCrit < d[d.length - 1]) {
        const x = xS(Math.log10(dCrit));
        ctx.strokeStyle = '#f44336'; ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.moveTo(x, mt); ctx.lineTo(x, mt + ph); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#f44336'; ctx.textAlign = 'left'; ctx.font = '9px sans-serif';
        ctx.fillText(`perforation (${(dCrit * 1000).toFixed(1)}mm)`, x + 4, mt + 10);
    }
    ctx.fillStyle = '#607d8b'; ctx.font = '9px sans-serif'; ctx.textAlign = 'center';
    for (const [dia, label] of [[1e-5, '10μm'], [1e-4, '100μm'], [1e-3, '1mm'], [1e-2, '1cm'], [1e-1, '10cm'], [1, '1m']]) {
        ctx.fillText(label, xS(Math.log10(dia)), mt + ph + 14);
    }
    ctx.textAlign = 'left';
    ctx.fillText('≥1 impact, ' + config.areaM2 + ' m², ' + config.durationYears + ' yr', ml + 2, mt + 9);
}

export function drawHeatmap(canvas, heatmap, mission) {
    const { ctx, W, H } = ctx2d(canvas);
    const ml = 42, mr = 6, mt = 8, mb = 16;
    const pw = W - ml - mr, ph = H - mt - mb;
    const alts = heatmap.altitudes_km, incs = heatmap.inclinations_deg;
    const grid = heatmap.flux_1mm;
    const nA = alts.length, nI = incs.length;
    const cw = pw / nI, ch = ph / nA;

    let min = Infinity, max = -Infinity;
    for (const row of grid) for (const v of row) {
        if (v > 0) { const l = Math.log10(v); if (l < min) min = l; if (l > max) max = l; }
    }
    const color = t => {
        const r = Math.round(255 * Math.min(1, Math.max(0, 1.5 * t - 0.5)));
        const g = Math.round(255 * Math.min(1, t < 0.5 ? 2 * t : 1));
        const b = Math.round(255 * Math.min(1, t < 0.3 ? 0.5 + t : 1 - t));
        return `rgb(${r},${g},${b})`;
    };
    for (let a = 0; a < nA; a++) {
        for (let i = 0; i < nI; i++) {
            const v = grid[a][i];
            ctx.fillStyle = v <= 0 ? '#0a0e1a' : color((Math.log10(v) - min) / Math.max(max - min, 1e-9));
            ctx.fillRect(ml + i * cw, mt + (nA - 1 - a) * ch, cw + 0.5, ch + 0.5);
        }
    }
    // orbit overlay: vertical line at inclination, from altMin..altMax
    const incX = i => ml + ((Math.min(Math.abs(i), incs[nI - 1]) - incs[0]) / (incs[nI - 1] - incs[0])) * pw;
    const altY = a => {
        let idx = 0;
        for (let k = 0; k < nA - 1; k++) { if (alts[k] <= a && a <= alts[k + 1]) { idx = k + (a - alts[k]) / (alts[k + 1] - alts[k]); break; } }
        return mt + (nA - 1 - idx) * ch;
    };
    if (mission) {
        const x = incX(mission.inclination_deg);
        const y1 = altY(Math.min(mission.altMax, alts[nA - 1]));
        const y2 = altY(Math.max(mission.altMin, alts[0]));
        ctx.strokeStyle = '#4fc3f7'; ctx.lineWidth = 2;
        ctx.shadowColor = '#4fc3f7'; ctx.shadowBlur = 5;
        ctx.beginPath(); ctx.moveTo(x, y1); ctx.lineTo(x, y2); ctx.stroke();
        ctx.shadowBlur = 0;
    }
    ctx.fillStyle = '#607d8b'; ctx.font = '8px sans-serif'; ctx.textAlign = 'right';
    for (const alt of [400, 1000, 20200, 35786]) {
        if (alt >= alts[0] && alt <= alts[nA - 1]) ctx.fillText(`${alt >= 1000 ? alt / 1000 + 'k' : alt}`, ml - 3, altY(alt) + 3);
    }
    ctx.textAlign = 'center';
    for (const inc of [0, 51.6, 98]) ctx.fillText(`${inc}°`, incX(inc), mt + ph + 12);
}

let landLines = null;
export function setLandLines(lines) { landLines = lines; }

export function drawGroundTrack(canvas, mission, result, markerPoint) {
    const { ctx, W, H } = ctx2d(canvas);
    const ml = 8, mr = 8, mt = 8, mb = 10;
    const pw = W - ml - mr, ph = H - mt - mb;
    const lonX = lon => ml + ((lon + 180) / 360) * pw;
    const latY = lat => mt + ((90 - lat) / 180) * ph;

    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.strokeRect(ml, mt, pw, ph);
    ctx.beginPath(); ctx.moveTo(ml, latY(0)); ctx.lineTo(ml + pw, latY(0)); ctx.stroke();

    if (landLines) {
        ctx.strokeStyle = 'rgba(140,160,180,0.35)'; ctx.lineWidth = 0.7;
        for (const line of landLines) {
            ctx.beginPath();
            ctx.moveTo(lonX(line[0][0]), latY(line[0][1]));
            for (let i = 1; i < line.length; i++) ctx.lineTo(lonX(line[i][0]), latY(line[i][1]));
            ctx.stroke();
        }
    }
    // track colored by flux
    const pts = mission.points;
    const lg = p => Math.log10(Math.max(p.flux_1mm, 1e-9));
    const lMin = Math.min(...pts.map(lg)), lMax = Math.max(...pts.map(lg));
    const fluxColor = t => {
        const h = 0.55 - t * 0.55;
        return `hsl(${h * 360}, 90%, ${45 + t * 15}%)`;
    };
    for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i];
        if (Math.abs(b.longitude_deg - a.longitude_deg) > 180) continue;
        const t = lMax > lMin ? (lg(b) - lMin) / (lMax - lMin) : 0.5;
        ctx.strokeStyle = fluxColor(t); ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(lonX(a.longitude_deg), latY(a.latitude_deg));
        ctx.lineTo(lonX(b.longitude_deg), latY(b.latitude_deg));
        ctx.stroke();
    }
    // marker
    if (markerPoint) {
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(lonX(markerPoint.longitude_deg), latY(markerPoint.latitude_deg), 3, 0, Math.PI * 2);
        ctx.fill();
    }
}