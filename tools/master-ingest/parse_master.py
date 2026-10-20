#!/usr/bin/env python3
"""
MASTER 8.x `.dia` output ingest for the sgp4-wasm flux dashboard.

Converts a directory of MASTER .dia spectrum files into the JSON schema the
dashboard consumes (same schema as tools/flux-model/generate_model_data.py):

  model_heatmap.json / master_heatmap.json:
      flux >= {10um, 1mm, 1cm} on an altitude x inclination grid
  model_profiles.json / master_profiles.json:
      diameter-resolved spectra (per orbit point) with source breakdown

LICENSE NOTE
    MASTER and its underlying datafiles are ESA-licensed (object code, restricted
    territory, no third-party access, GEN-SW-TOR-00347-OPS-SD). This tool and its
    JSON output must NOT be committed to a public repository. Keep MASTER and its
    outputs on your machine; the dashboard loads them via the "Import MASTER
    results" file picker (or from flux/data/local/ during local development).

Usage:
    python3 tools/master-ingest/parse_master.py <dir-with-dia-files> [outdir]

    Each .dia file must contain the MASTER header line:
        # orbiting target (sphere) with parameters (ECI frame)  <sma> km, <ecc>, <inc> deg, ...
    Output: <outdir>/master_heatmap.json and <outdir>/master_profiles.json
"""
import json
import math
import os
import re
import sys

RE = 6371.0
SOURCE_COLUMNS = [
    "explosion_fragments", "collision_fragments", "launch_mission", "nak_droplets",
    "srm_slag", "srm_dust", "paint_flakes", "ejecta", "mli",
    "cloud_1", "cloud_2", "cloud_3", "cloud_4", "sim",
]
# sources mapped to the dashboard's breakdown
PROFILE_SOURCES = ["fragments", "paint_flakes", "srm_slag", "nak_droplets", "mli", "ejecta"]
COLUMN_TO_SOURCE = {
    "explosion_fragments": "fragments",
    "paint_flakes": "paint_flakes",
    "srm_slag": "srm_slag",
    "nak_droplets": "nak_droplets",
    "mli": "mli",
    "ejecta": "ejecta",
}


def parse_dia(path):
    """Parse one MASTER .dia spectrum file."""
    header_meta = {}
    rows = []
    col_names = []
    spectrum_kind = None
    with open(path, "r", errors="replace") as f:
        for line in f:
            if line.startswith("#"):
                m = re.search(r"Spectrum:\s*(\w[\w -]*\w)", line)
                if m:
                    spectrum_kind = m.group(1).strip().lower()
                m = re.search(
                    r"orbiting target .*?\(ECI frame\)\s+([\d.]+)\s*km,\s*([\d.]+),\s*([\d.]+)\s*deg", line)
                if m:
                    header_meta["sma_km"] = float(m.group(1))
                    header_meta["eccentricity"] = float(m.group(2))
                    header_meta["inclination_deg"] = float(m.group(3))
                m = re.search(r"Most recent reference Epoch:\s*([\d/]+)", line)
                if m:
                    header_meta["epoch"] = m.group(1)
                m = re.search(r"MASTER v([\d.]+)", line)
                if m:
                    header_meta["model"] = f"MASTER {m.group(1)}"
                if "x Data:" in line and "Diameter" in line:
                    header_meta["x_data"] = "diameter_m"
                continue
            parts = line.split()
            if len(parts) < 5 or not re.match(r"^\d", parts[0]):
                continue
            if not col_names:
                # first data row: infer column count from row length
                ncols = len(parts)
                col_names = ["diameter_m"] + [f"c{i}" for i in range(ncols - 1)]
            rows.append([float(x.replace("E+00", "e0")) if "E" in x.upper() else float(x) for x in parts])

    if not rows:
        raise ValueError(f"{path}: no data rows")
    if "sma_km" not in header_meta:
        raise ValueError(f"{path}: no 'orbiting target' header found")

    diameters = [r[0] for r in rows]
    ncols = len(rows[0])  # diameter + N flux columns
    if ncols != 19:
        print(f"  warn: {os.path.basename(path)} has {ncols} columns (expected 19: 1 diam + 14 sources + SIM + human + meteoroids + streams + total)")
    # columns per MASTER .dia: diam, 14 sources, SIM, Human-made, Meteoroids, Streams, Total
    def col(i):
        return [r[i] for r in rows] if i < ncols else [0.0] * len(rows)
    total = col(ncols - 1)
    human = col(15)
    meteoroids = col(16)
    sources_raw = {SOURCE_COLUMNS[i]: col(1 + i) for i in range(14)}

    return {
        "orbit": header_meta,
        "spectrum": spectrum_kind,
        "diameters_m": diameters,
        "meteoroid_flux": meteoroids,
        "debris_flux": human,
        "total_flux": total,
        "sources_raw": sources_raw,
    }


def remap_sources(sources_raw):
    """Map the 14 MASTER source columns onto the dashboard's 6-source breakdown."""
    out = {}
    for src in PROFILE_SOURCES:
        out[src] = sources_raw.get(src, [0.0] * len(next(iter(sources_raw.values()))))
    # collision fragments folded into fragments
    if "collision_fragments" in sources_raw:
        for i, v in enumerate(sources_raw["collision_fragments"]):
            out["fragments"][i] += v
    return out


def alt_from_sma(sma_km, ecc):
    # for eccentric orbits MASTER's "altitude" of the target sphere is geocentric radius;
    # we place the profile at sma - RE (mean) and record ecc for the dashboard
    return sma_km - RE


def interp_log_grid(alt, inc, altitudes, inclinations, grid):
    """Bilinear interpolation over log10 values with edge clamping."""
    a = min(max(alt, altitudes[0]), altitudes[-1])
    i = min(max(abs(inc) if inc <= 90 else min(abs(inc), 180 - abs(inc)), 0), 90)
    inc = min(max(i, inclinations[0]), inclinations[-1])
    ai = 0
    for k in range(len(altitudes) - 1):
        if altitudes[k] <= a <= altitudes[k + 1]:
            ai = k
            break
    else:
        ai = len(altitudes) - 2
    ii = 0
    for k in range(len(inclinations) - 1):
        if inclinations[k] <= inc <= inclinations[k + 1]:
            ii = k
            break
    else:
        ii = len(inclinations) - 2
    da = (a - altitudes[ai]) / max(altitudes[ai + 1] - altitudes[ai], 1e-9)
    di = (inc - inclinations[ii]) / max(inclinations[ii + 1] - inclinations[ii], 1e-9)
    v00, v01 = grid[ai][ii], grid[ai][ii + 1]
    v10, v11 = grid[ai + 1][ii], grid[ai + 1][ii + 1]
    lg = lambda v: math.log10(max(v, 1e-30))
    top = (1 - di) * lg(v00) + di * lg(v01)
    bot = (1 - di) * lg(v10) + di * lg(v11)
    return 10 ** ((1 - da) * top + da * bot)


def build_heatmap(spectra, altitudes, inclinations):
    """Bin the spectra onto the dashboard's alt x inc grid."""
    hm = {
        "altitudes_km": altitudes,
        "inclinations_deg": inclinations,
        "model": spectra[0]["orbit"].get("model", "MASTER"),
        "epoch": spectra[0]["orbit"].get("epoch", ""),
        "note": f"Derived from {len(spectra)} MASTER .dia spectra. Interpolate for intermediate values.",
    }
    # assemble a scattered table of (alt, inc, flux>=size) from the spectra
    for key, size in (("flux_10um", 10e-6), ("flux_1mm", 1e-3), ("flux_1cm", 1e-2)):
        grid = [[0.0] * len(inclinations) for _ in altitudes]
        for ia, alt in enumerate(altitudes):
            for ii, inc in enumerate(inclinations):
                # inverse-distance weighting in (log alt, inc) over nearby spectra
                num = 0.0
                den = 0.0
                for s in spectra:
                    salt = alt_from_sma(s["orbit"]["sma_km"], s["orbit"].get("eccentricity", 0))
                    sinc = s["orbit"]["inclination_deg"]
                    f = interp_at_size(s, size)
                    if f <= 0:
                        continue
                    w = 1.0 / (1.0 + (math.log10((salt + 1) / (alt + 1)) * 4) ** 2
                               + ((sinc - inc) / 30) ** 2)
                    num += w * math.log10(f)
                    den += w
                grid[ia][ii] = 10 ** (num / den) if den > 0 else 0.0
        hm[key] = grid
    return hm


def interp_at_size(spec, size):
    """Cumulative flux at >= size from a spectrum (log-log interpolation)."""
    d = spec["diameters_m"]
    f = spec["total_flux"]
    if size <= d[0]:
        return f[0]
    if size >= d[-1]:
        return 0.0
    for i in range(1, len(d)):
        if d[i] >= size:
            x0, x1 = math.log10(d[i - 1]), math.log10(d[i])
            y0, y1 = math.log10(max(f[i - 1], 1e-30)), math.log10(max(f[i], 1e-30))
            t = (math.log10(size) - x0) / (x1 - x0)
            return 10 ** ((1 - t) * y0 + t * y1)
    return 0.0


DASH_ALTITUDES = [300, 500, 700, 900, 1100, 1400, 2000, 5000, 10000, 20200, 35786, 50000]
DASH_INCLINATIONS = [0.1, 28.5, 51.6, 72.0, 82.0, 98.0, 120.0]


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    src_dir = sys.argv[1]
    out_dir = sys.argv[2] if len(sys.argv) > 2 else "flux/data/local"
    os.makedirs(out_dir, exist_ok=True)

    spectra = []
    skipped = []
    for name in sorted(os.listdir(src_dir)):
        if name.endswith(".dia"):
            print(f"parsing {name}")
            spec = parse_dia(os.path.join(src_dir, name))
            # only cumulative spectra are valid for the dashboard's flux model;
            # differential and reverse-cumulative files describe the same orbit
            if spec.get("spectrum") and "cumulative" not in spec["spectrum"] or spec.get("spectrum") == "reverse cumulative":
                skipped.append((name, spec.get("spectrum")))
                continue
            spec["sources"] = remap_sources(spec.pop("sources_raw"))
            spectra.append(spec)
    for name, kind in skipped:
        print(f"  skipped {name} (spectrum={kind!r} — need cumulative)")
    if not spectra:
        print("no .dia files found")
        sys.exit(1)

    # sort by altitude for readable profiles
    spectra.sort(key=lambda s: s["orbit"]["sma_km"])
    profiles = []
    for s in spectra:
        p = dict(s)
        p["orbit"]["altitude_km"] = alt_from_sma(s["orbit"]["sma_km"], s["orbit"].get("eccentricity", 0))
        profiles.append(p)

    hm = build_heatmap(spectra, DASH_ALTITUDES, DASH_INCLINATIONS)

    with open(os.path.join(out_dir, "master_heatmap.json"), "w") as f:
        json.dump(hm, f)
    with open(os.path.join(out_dir, "master_profiles.json"), "w") as f:
        json.dump(profiles, f)
    print(f"\nwrote {out_dir}/master_heatmap.json (grid {len(DASH_ALTITUDES)}x{len(DASH_INCLINATIONS)})")
    print(f"wrote {out_dir}/master_profiles.json ({len(profiles)} spectra)")
    print("NOTE: keep these files out of the public repo (ESA licence). "
          "Load them via the dashboard's Import button.")


if __name__ == "__main__":
    main()