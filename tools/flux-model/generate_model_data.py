#!/usr/bin/env python3
"""
Generate the bundled semi-empirical flux environment data for the flux dashboard.

Produces the same JSON schema that MASTER ingest produces, so the dashboard is
source-agnostic:

  flux/data/model_heatmap.json   flux >= {10um,1mm,1cm} on an altitude x inclination grid
  flux/data/model_profiles.json  diameter-resolved spectra (1um..1m) per altitude band

Method (all published, no licensed data):
  - Grun et al. 1985 interplanetary meteoroid model (natural flux), with
    gravitational focusing and Earth shielding
  - Semi-empirical orbital debris model calibrated to published MASTER-class
    flux levels (altitude baseline, source power laws, inclination bands)

Usage:
    python3 tools/flux-model/generate_model_data.py
"""
import json
import math
import os

RE = 6371.0  # km

# Grid: same shape as the MASTER ingest schema
ALTITUDES = [300, 500, 700, 900, 1100, 1400, 2000, 5000, 10000, 20200, 35786, 50000]
INCLINATIONS = [0.1, 28.5, 51.6, 72.0, 82.0, 98.0, 120.0]
DIAMETERS = [10 ** (-6 + (6 + 2) * i / 59) for i in range(60)]  # 1um .. 100m, 60 bins

EPOCH = "2025-01-01"
MODEL_NAME = "Semi-empirical model (Grun 1985 + calibrated debris)"


# ---------------------------------------------------------------- meteoroids
def grun_meteoroid_flux(diameter_m, altitude_km):
    """Grun 1985 cumulative interplanetary flux (>= diameter), /m2/yr, at 1 AU
    with gravitational focusing and Earth shielding applied."""
    rho = 2500.0  # kg/m3
    flux = []
    r = RE + altitude_km
    for d in diameter_m:
        m_kg = (math.pi / 6) * rho * d ** 3
        mg = m_kg * 1000.0  # model uses grams
        if mg <= 0:
            flux.append(0.0)
            continue
        c1 = (2.2e3 * mg ** 0.306 + 15.0) ** (-4.38)
        c2 = 1.3e-9 * (mg + 1e11 * mg ** 2 + 1e27 * mg ** 4) ** (-0.36)
        c3 = 1.3e-16 * (mg + 1e6 * mg ** 2) ** (-0.85)
        f = 2.0 * (c1 + c2 + c3) * 3.156e7  # /m2/yr
        flux.append(f)
    # gravitational focusing
    v_esc = 11.2 * math.sqrt(RE / r)
    focus = 1.0 + (v_esc / 20.0) ** 2
    # Earth shielding
    shield = (1 + math.sqrt(max(0.0, 1 - (RE / r) ** 2))) / 2
    return [f * focus * shield for f in flux]


# ------------------------------------------------------------------- debris
def _baseline_1cm(alt_km, epoch_year=2025.0):
    h = alt_km
    growth = 1.0 + (0.035 if h <= 2000 else 0.01) * (epoch_year - 2020)
    if h < 200:
        f = 1e-6
    elif h < 400:
        f = 1e-6 + (h - 200) / 200 * 4e-5
    elif h < 600:
        f = 5e-5 + (h - 400) / 200 * 1e-4
    elif h < 800:
        f = 1.5e-4 + (h - 600) / 200 * 1.5e-4
    elif h < 1000:
        f = 3e-4 + (h - 800) / 200 * 1e-4
    elif h < 1200:
        f = 4e-4 - (h - 1000) / 200 * 1e-4
    elif h < 1500:
        f = 3e-4 - (h - 1200) / 300 * 1e-4
    elif h < 2000:
        f = 2e-4 * math.exp(-(h - 1500) / 500)
    elif h < 5000:
        f = 5e-5 * math.exp(-(h - 2000) / 2000)
    elif h < 15000:
        f = 1e-5 * math.exp(-(h - 5000) / 5000)
    elif h < 25000:
        f = 3e-6 * math.exp(-(h - 15000) / 10000) + 5e-6 * math.exp(-((h - 20200) / 2000) ** 2)
    elif h < 34000:
        f = 3e-6 * math.exp(-(h - 25000) / 8000)
    elif h < 37000:
        f = 1e-6 + 2e-6 * math.exp(-((h - 35786) / 300) ** 2)
    elif h < 100000:
        f = 1e-6 * math.exp(-(h - 37000) / 30000)
    else:
        f = 1e-8 * math.exp(-(h - 100000) / 100000)
    return f * growth


def _source_fractions(alt_km):
    h = alt_km
    if h < 600:
        return {"fragments": 0.6, "paint": 0.15, "srm": 0.08, "nak": 0.0, "mli": 0.07, "ejecta": 0.10}
    if h < 1100:
        nak = 0.15 * math.exp(-((h - 900) / 100) ** 2)
        return {"fragments": 0.50, "paint": 0.12, "srm": 0.10, "nak": nak, "mli": 0.08, "ejecta": 0.10 - nak / 2}
    if h < 2000:
        return {"fragments": 0.55, "paint": 0.10, "srm": 0.15, "nak": 0.0, "mli": 0.10, "ejecta": 0.10}
    if h < 30000:
        return {"fragments": 0.70, "paint": 0.08, "srm": 0.12, "nak": 0.0, "mli": 0.05, "ejecta": 0.05}
    return {"fragments": 0.60, "paint": 0.10, "srm": 0.15, "nak": 0.0, "mli": 0.08, "ejecta": 0.07}


def _inclination_factor(alt_km, inc_deg):
    bands = [
        (28.5, 4, 0.4), (51.6, 3, 0.6), (65, 4, 0.8),
        (72, 3, 0.7), (82, 3, 0.9), (97, 4, 1.5),
    ]
    factor = 0.4
    for band_inc, width, strength in bands:
        factor += strength * math.exp(-0.5 * ((inc_deg - band_inc) / width) ** 2)
    if alt_km > 2000:
        blend = min(1.0, (alt_km - 2000) / 10000)
        factor = factor * (1 - blend) + 1.0 * blend
    return factor


def debris_flux(diameter_m, alt_km, inc_deg):
    """Semi-empirical cumulative debris flux (>= diameter), /m2/yr, with source
    breakdown. Calibrated against published MASTER-class levels."""
    d_ref = 0.01
    base = _baseline_1cm(alt_km)
    fracs = _source_fractions(alt_km)
    inc_f = _inclination_factor(alt_km, inc_deg)

    def taper(v, d, hi, hi_sig, lo, lo_power):
        if d > hi:
            v *= math.exp(-((d - hi) / hi_sig) ** 2)
        if d < lo:
            v *= (d / lo) ** lo_power
        return v

    frag, paint, srm, nak, mli, ejecta = [], [], [], [], [], []
    for d in diameter_m:
        if d <= 0:
            for lst in (frag, paint, srm, nak, mli, ejecta):
                lst.append(0.0)
            continue
        ratio = d / d_ref
        f = base * fracs["fragments"] * ratio ** (-2.2)
        frag.append(taper(f, d, 0.5, 0.3, 1e-3, 0.5))
        p = base * fracs["paint"] * ratio ** (-2.5)
        paint.append(taper(p, d, 0.002, 0.0005, 5e-5, 2))
        s = base * fracs["srm"] * ratio ** (-1.8)
        srm.append(taper(s, d, 0.03, 0.01, 2e-4, 3))
        n = 0.0
        if fracs["nak"] > 0 and 5e-4 <= d <= 0.05:
            n = base * fracs["nak"] * math.exp(-0.5 * ((math.log10(d * 1000) - 0.7) / 0.3) ** 2) * 10
        nak.append(n)
        m = base * fracs["mli"] * ratio ** (-2.2)
        mli.append(taper(m, d, 0.005, 0.002, 5e-5, 2))
        e = base * fracs["ejecta"] * ratio ** (-2.5)
        ejecta.append(taper(e, d, 5e-4, 2e-4, 1e-5, 2))

    total = [sum(v) * inc_f for v in zip(frag, paint, srm, nak, mli, ejecta)]
    # cumulative -> non-increasing
    for lst in (frag, paint, srm, nak, mli, ejecta, total):
        for i in range(1, len(lst)):
            lst[i] = min(lst[i], lst[i - 1])
    return {
        "fragments": frag, "paint_flakes": paint, "srm_slag": srm,
        "nak_droplets": nak, "mli": mli, "ejecta": ejecta,
        "total": total,
    }


# --------------------------------------------------------------------- build
def build_profiles():
    profiles = []
    for alt in ALTITUDES:
        met = grun_meteoroid_flux(DIAMETERS, alt)
        deb = debris_flux(DIAMETERS, alt, 51.6)  # reference inclination for profile spectra
        total = [m + d for m, d in zip(met, deb["total"])]
        sma = RE + alt
        profiles.append({
            "orbit": {
                "sma_km": sma,
                "altitude_km": alt,
                "eccentricity": 0.001,
                "inclination_deg": 51.6,
            },
            "diameters_m": DIAMETERS,
            "meteoroid_flux": met,
            "debris_flux": deb["total"],
            "total_flux": total,
            "sources": {
                "fragments": deb["fragments"],
                "paint_flakes": deb["paint_flakes"],
                "srm_slag": deb["srm_slag"],
                "nak_droplets": deb["nak_droplets"],
                "mli": deb["mli"],
                "ejecta": deb["ejecta"],
            },
        })
    return profiles


def flux_at_size(diameters, flux, size):
    """Cumulative flux at >= size by log interpolation of the spectrum."""
    import bisect
    if size <= diameters[0]:
        return flux[0]
    if size >= diameters[-1]:
        return 0.0
    i = bisect.bisect_left(diameters, size)
    f0, f1 = flux[i - 1], flux[i]
    if f0 <= 0 or f1 <= 0:
        return min(f0, f1)
    x0, x1 = math.log10(diameters[i - 1]), math.log10(diameters[i])
    xs = math.log10(size)
    t = (xs - x0) / (x1 - x0)
    return 10 ** ((1 - t) * math.log10(f0) + t * math.log10(f1))


def build_heatmap(profiles):
    hm = {"altitudes_km": ALTITUDES, "inclinations_deg": INCLINATIONS,
          "model": MODEL_NAME, "epoch": EPOCH,
          "note": "Semi-empirical environment (published methodology). Interpolate for intermediate values."}
    for key, size in (("flux_10um", 10e-6), ("flux_1mm", 1e-3), ("flux_1cm", 1e-2)):
        grid = []
        for alt in ALTITUDES:
            met = grun_meteoroid_flux([size], alt)[0]
            row = []
            for inc in INCLINATIONS:
                deb = debris_flux([size], alt, inc)["total"][0]
                row.append(met + deb)
            grid.append(row)
        hm[key] = grid
    return hm


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    out = os.path.join(here, "..", "..", "flux", "data")
    profiles = build_profiles()
    heatmap = build_heatmap(profiles)
    with open(os.path.join(out, "model_profiles.json"), "w") as f:
        json.dump(profiles, f)
    with open(os.path.join(out, "model_heatmap.json"), "w") as f:
        json.dump(heatmap, f)
    print(f"profiles: {len(profiles)} x {len(DIAMETERS)} diameters")
    print(f"heatmap: {len(ALTITUDES)} x {len(INCLINATIONS)} x 3 sizes")
    print("sanity: flux>=1mm @ 400km,51.6deg =",
          f"{heatmap['flux_1mm'][0][2]:.2e} /m2/yr (MASTER reference: ~3e-3 @300km)")
    print("sanity: flux>=1mm @ 900km,98deg  =",
          f"{heatmap['flux_1mm'][3][5]:.2e} /m2/yr (expected ~1e-1)")


if __name__ == "__main__":
    main()