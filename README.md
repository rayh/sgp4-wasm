# sgp4-wasm

Satellite orbit propagation in the browser. A WebAssembly build of
[SGP4/SDP4](https://celestrak.org/NORAD/documentation/gp4-prop.php) — the standard
analytic propagator for Two-Line Element (TLE) sets — with a clean JavaScript API
and a live 3D catalog demo.

**[Try the live demo](https://rayh.github.io/sgp4-wasm/)** — every dot is a
live SGP4 propagation running in your browser.

The propagator wraps the well-tested Rust
[`sgp4`](https://crates.io/crates/sgp4) crate (ported from the reference Celestrak
implementation) and adds TLE parsing ergonomics, GMST, ECI→ECEF rotation and
WGS84 geodetic conversion. Handles both near-Earth (SGP4) and deep-space (SDP4)
objects automatically.

## Output

For each propagation step:

- **ECI position** `[x, y, z]` in km (TEME frame)
- **ECI velocity** `[vx, vy, vz]` in km/s
- **Geodetic latitude / longitude** in degrees
- **Altitude** above the WGS84 ellipsoid in km
- **Speed** in km/s

The optimized binary is ~150 KB.

## Build

```bash
cargo install wasm-pack   # once

wasm-pack build --target web --release
```

Output lands in `pkg/` (`sgp4_wasm.js` + `sgp4_wasm_bg.wasm`).

## Usage (browser)

```js
import init, { Satellite } from './pkg/sgp4_wasm.js';

await init();

const line1 = "1 25544U 98067A   24001.50000000  .00016717  00000-0  10270-3 0  9002";
const line2 = "2 25544  51.6400 208.9163 0006703 130.5360 325.0288 15.49560532434083";

const sat = new Satellite(line1, line2);

// Single propagation (minutes since TLE epoch)
const result = sat.propagate(60.0);
console.log(result.position_eci);   // [x, y, z] km
console.log(result.altitude_km);    // km

// Batch propagation (start, end, step in minutes)
const batch = sat.propagateBatch(0, 1440, 1);
console.log(batch.results.length);  // 1441 points

// 3-line TLE (with name)
const sat2 = Satellite.fromTle3("ISS (ZARYA)", line1, line2);

sat.free();
```

## Demo

**Hosted on GitHub Pages** — pushed automatically by CI on every change to
`main`: https://rayh.github.io/sgp4-wasm/

The demo shows the current satellite catalog (~15–20k objects from a bundled
Celestrak snapshot, refreshed by CI) as a field of darts oriented along their
direction of travel, all propagated live in WebAssembly several times a second:

- **Click any dart** to select it — highlights it, propagates the full orbit,
  and shows details plus a ground track over a world map
- **Search the catalog** by name, pick from well-known objects, or paste any
  TLE (works fully offline)
- **Time is always live** (real time) — scrub ±24 h with the slider, snap back
  with the LIVE button
- The Moon follows a real Meeus lunar ephemeris and the Earth's day/night
  terminator tracks the actual sun position

To run it locally:

```bash
wasm-pack build --target web --release
python3 -m http.server 8080
# Open http://localhost:8080/demo/
```

## API

| JS | Rust | Description |
|---|---|---|
| `new Satellite(line1, line2)` | `Satellite::new` | Parse a 2-line TLE |
| `Satellite.fromTle3(name, l1, l2)` | `Satellite::from_tle3` | Parse a 3-line TLE |
| `sat.propagate(minutes)` | | Propagate to a single time point |
| `sat.propagateBatch(start, end, step)` | | Propagate over a time range |
| `sat.getEpoch()` | | ISO 8601 epoch from the TLE |
| `sat.getNoradId()` | | NORAD catalog number |
| `sat.getObjectName()` | | Name (only available from 3LE) |
| `new Catalog(text)` | `Catalog::new` | Parse a multi-TLE catalog |
| `catalog.count()` | | Number of objects |
| `catalog.getIds()` | | NORAD IDs as a `Uint32Array` |
| `catalog.propagateAll(unixMs)` | | All objects to one time; flat `[x,y,z,...]` |
| `catalog.propagateAllWithTrail(unixMs, trailMin)` | | As above, plus a trailing sample per object |
| `sat.free()` | | Release WASM memory |

## Tests

```bash
cargo test
```

Unit tests cover the ECI→ECEF rotation and the iterative WGS84 geodetic
conversion. Propagation accuracy comes from the upstream `sgp4` crate, verified
against the reference Celestrak C++ implementation (differences < 2×10⁻⁷ km
position, < 10⁻⁹ km/s velocity at 3.5 years from epoch).

## License

MIT
