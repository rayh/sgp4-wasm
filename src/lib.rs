use serde::Serialize;
use wasm_bindgen::prelude::*;

/// WGS84 constants
const WGS84_A: f64 = 6378.137; // Earth's semi-major axis in km
const WGS84_F: f64 = 1.0 / 298.257223563; // Flattening
const WGS84_E2: f64 = WGS84_F * (2.0 - WGS84_F); // First eccentricity squared

/// Earth's rotation rate in rad/s
const EARTH_ROTATION_RATE: f64 = 7.292115e-5;

/// Result of a single propagation step
#[derive(Serialize)]
pub struct PropagationResult {
    /// ECI position [x, y, z] in km
    pub position_eci: [f64; 3],
    /// ECI velocity [vx, vy, vz] in km/s
    pub velocity_eci: [f64; 3],
    /// Geodetic latitude in degrees
    pub latitude_deg: f64,
    /// Geodetic longitude in degrees
    pub longitude_deg: f64,
    /// Altitude above WGS84 ellipsoid in km
    pub altitude_km: f64,
    /// Speed in km/s
    pub speed_km_s: f64,
    /// Minutes since TLE epoch used for this propagation
    pub minutes_since_epoch: f64,
}

/// Result for batch propagation
#[derive(Serialize)]
pub struct BatchResult {
    pub results: Vec<PropagationResult>,
}

/// Satellite record holding parsed TLE and precomputed constants
#[wasm_bindgen]
pub struct Satellite {
    constants: sgp4::Constants,
    elements: sgp4::Elements,
}

#[wasm_bindgen]
impl Satellite {
    /// Create a Satellite from two TLE lines.
    /// line1 and line2 should be the standard 69-character TLE lines.
    #[wasm_bindgen(constructor)]
    pub fn new(line1: &str, line2: &str) -> Result<Satellite, JsError> {
        // The sgp4 crate's parse_2les expects the full two-line string
        let tle_string = format!("{}\n{}", line1.trim(), line2.trim());
        let elements_vec = sgp4::parse_2les(&tle_string)
            .map_err(|e| JsError::new(&format!("TLE parse error: {:?}", e)))?;

        let elements = elements_vec
            .into_iter()
            .next()
            .ok_or_else(|| JsError::new("No elements parsed from TLE"))?;

        let constants = sgp4::Constants::from_elements(&elements)
            .map_err(|e| JsError::new(&format!("SGP4 init error: {:?}", e)))?;

        Ok(Satellite {
            constants,
            elements,
        })
    }

    /// Create a Satellite from three TLE lines (name + line1 + line2).
    #[wasm_bindgen(js_name = "fromTle3")]
    pub fn from_tle3(name: &str, line1: &str, line2: &str) -> Result<Satellite, JsError> {
        let tle_string = format!("{}\n{}\n{}", name.trim(), line1.trim(), line2.trim());
        let elements_vec = sgp4::parse_3les(&tle_string)
            .map_err(|e| JsError::new(&format!("TLE parse error: {:?}", e)))?;

        let elements = elements_vec
            .into_iter()
            .next()
            .ok_or_else(|| JsError::new("No elements parsed from TLE"))?;

        let constants = sgp4::Constants::from_elements(&elements)
            .map_err(|e| JsError::new(&format!("SGP4 init error: {:?}", e)))?;

        Ok(Satellite {
            constants,
            elements,
        })
    }

    /// Propagate to a given number of minutes since the TLE epoch.
    /// Returns a JS object with all position/velocity/geodetic data.
    #[wasm_bindgen]
    pub fn propagate(&self, minutes_since_epoch: f64) -> Result<JsValue, JsError> {
        let prediction = self
            .constants
            .propagate(sgp4::MinutesSinceEpoch(minutes_since_epoch))
            .map_err(|e| JsError::new(&format!("Propagation error: {:?}", e)))?;

        let pos = prediction.position;
        let vel = prediction.velocity;

        // Compute GMST for ECI -> ECEF rotation
        let gmst = self.gmst_at_minutes(minutes_since_epoch);

        // ECI to ECEF
        let (ecef_x, ecef_y, ecef_z) = eci_to_ecef(pos[0], pos[1], pos[2], gmst);

        // ECEF to geodetic
        let (lat_rad, lon_rad, alt_km) = ecef_to_geodetic(ecef_x, ecef_y, ecef_z);

        let speed = (vel[0] * vel[0] + vel[1] * vel[1] + vel[2] * vel[2]).sqrt();

        let result = PropagationResult {
            position_eci: [pos[0], pos[1], pos[2]],
            velocity_eci: [vel[0], vel[1], vel[2]],
            latitude_deg: lat_rad.to_degrees(),
            longitude_deg: lon_rad.to_degrees(),
            altitude_km: alt_km,
            speed_km_s: speed,
            minutes_since_epoch,
        };

        serde_wasm_bindgen::to_value(&result)
            .map_err(|e| JsError::new(&format!("Serialization error: {:?}", e)))
    }

    /// Propagate over a range of times (batch mode).
    /// start_minutes: start time in minutes since epoch
    /// end_minutes: end time in minutes since epoch
    /// step_minutes: time step in minutes
    #[wasm_bindgen(js_name = "propagateBatch")]
    pub fn propagate_batch(
        &self,
        start_minutes: f64,
        end_minutes: f64,
        step_minutes: f64,
    ) -> Result<JsValue, JsError> {
        if step_minutes <= 0.0 {
            return Err(JsError::new("step_minutes must be positive"));
        }

        let mut results = Vec::new();
        let mut t = start_minutes;
        while t <= end_minutes {
            let prediction = self
                .constants
                .propagate(sgp4::MinutesSinceEpoch(t))
                .map_err(|e| JsError::new(&format!("Propagation error at t={}: {:?}", t, e)))?;

            let pos = prediction.position;
            let vel = prediction.velocity;

            let gmst = self.gmst_at_minutes(t);
            let (ecef_x, ecef_y, ecef_z) = eci_to_ecef(pos[0], pos[1], pos[2], gmst);
            let (lat_rad, lon_rad, alt_km) = ecef_to_geodetic(ecef_x, ecef_y, ecef_z);
            let speed = (vel[0] * vel[0] + vel[1] * vel[1] + vel[2] * vel[2]).sqrt();

            results.push(PropagationResult {
                position_eci: [pos[0], pos[1], pos[2]],
                velocity_eci: [vel[0], vel[1], vel[2]],
                latitude_deg: lat_rad.to_degrees(),
                longitude_deg: lon_rad.to_degrees(),
                altitude_km: alt_km,
                speed_km_s: speed,
                minutes_since_epoch: t,
            });

            t += step_minutes;
        }

        let batch = BatchResult { results };
        serde_wasm_bindgen::to_value(&batch)
            .map_err(|e| JsError::new(&format!("Serialization error: {:?}", e)))
    }

    /// Get the epoch as an ISO 8601 string
    #[wasm_bindgen(js_name = "getEpoch")]
    pub fn get_epoch(&self) -> String {
        self.elements.datetime.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
    }

    /// Get the NORAD catalog number
    #[wasm_bindgen(js_name = "getNoradId")]
    pub fn get_norad_id(&self) -> u64 {
        self.elements.norad_id
    }

    /// Get the object name (if available from 3LE)
    #[wasm_bindgen(js_name = "getObjectName")]
    pub fn get_object_name(&self) -> Option<String> {
        self.elements.object_name.clone()
    }

    /// Compute GMST at a given minutes since TLE epoch
    fn gmst_at_minutes(&self, minutes_since_epoch: f64) -> f64 {
        // Use the sgp4 crate's epoch to sidereal time, then advance by elapsed time
        let epoch_sidereal =
            sgp4::iau_epoch_to_sidereal_time(self.elements.epoch_afspc_compatibility_mode());
        // Advance GMST by Earth rotation over elapsed minutes
        let elapsed_seconds = minutes_since_epoch * 60.0;
        epoch_sidereal + EARTH_ROTATION_RATE * elapsed_seconds
    }
}

/// Rotate ECI coordinates to ECEF using GMST angle
pub(crate) fn eci_to_ecef(x_eci: f64, y_eci: f64, z_eci: f64, gmst: f64) -> (f64, f64, f64) {
    let cos_gmst = gmst.cos();
    let sin_gmst = gmst.sin();
    let x_ecef = x_eci * cos_gmst + y_eci * sin_gmst;
    let y_ecef = -x_eci * sin_gmst + y_eci * cos_gmst;
    let z_ecef = z_eci;
    (x_ecef, y_ecef, z_ecef)
}

/// Convert ECEF coordinates to geodetic (lat, lon, alt) using iterative method
/// Returns (latitude_rad, longitude_rad, altitude_km)
pub(crate) fn ecef_to_geodetic(x: f64, y: f64, z: f64) -> (f64, f64, f64) {
    let lon = y.atan2(x);

    let p = (x * x + y * y).sqrt();
    let mut lat = z.atan2(p * (1.0 - WGS84_E2));

    // Iterative solution (Bowring's method, converges in 2-3 iterations)
    for _ in 0..10 {
        let sin_lat = lat.sin();
        let n = WGS84_A / (1.0 - WGS84_E2 * sin_lat * sin_lat).sqrt();
        let new_lat = (z + WGS84_E2 * n * sin_lat).atan2(p);
        if (new_lat - lat).abs() < 1e-12 {
            break;
        }
        lat = new_lat;
    }

    let sin_lat = lat.sin();
    let cos_lat = lat.cos();
    let n = WGS84_A / (1.0 - WGS84_E2 * sin_lat * sin_lat).sqrt();

    let alt = if cos_lat.abs() > 1e-10 {
        p / cos_lat - n
    } else {
        z.abs() / sin_lat.abs() - n * (1.0 - WGS84_E2)
    };

    (lat, lon, alt)
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOL: f64 = 1e-6;

    #[test]
    fn eci_to_ecef_identity_at_zero_gmst() {
        let (x, y, z) = eci_to_ecef(1.0, 2.0, 3.0, 0.0);
        assert!((x - 1.0).abs() < TOL);
        assert!((y - 2.0).abs() < TOL);
        assert!((z - 3.0).abs() < TOL);
    }

    #[test]
    fn eci_to_ecef_rotates_by_gmst() {
        // Point on +x axis, GMST = 90° -> ECEF -y axis
        let (x, y, z) = eci_to_ecef(100.0, 0.0, 50.0, std::f64::consts::FRAC_PI_2);
        assert!(x.abs() < TOL);
        assert!((y + 100.0).abs() < TOL);
        assert!((z - 50.0).abs() < TOL);
    }

    #[test]
    fn eci_to_ecef_preserves_radius() {
        let gmst = 1.2345;
        let (x, y, z) = eci_to_ecef(300.0, -400.0, 700.0, gmst);
        assert!((x * x + y * y + z * z - (300f64 * 300.0 + 400.0 * 400.0 + 700.0 * 700.0)).abs() < 1e-6);
    }

    #[test]
    fn geodetic_roundtrip_equator() {
        let (lat, lon, alt) = ecef_to_geodetic(WGS84_A + 100.0, 0.0, 0.0);
        assert!(lat.abs() < 1e-9);
        assert!(lon.abs() < 1e-9);
        assert!((alt - 100.0).abs() < TOL);
    }

    #[test]
    fn geodetic_roundtrip_pole() {
        // Over the north pole: p ~ 0, z > 0
        let (lat, _lon, alt) = ecef_to_geodetic(0.0, 0.0, WGS84_A * (1.0 - WGS84_F) + 50.0);
        assert!((lat - std::f64::consts::FRAC_PI_2).abs() < 1e-6);
        assert!((alt - 50.0).abs() < 1e-3);
    }

    #[test]
    fn geodetic_roundtrip_general() {
        // ECEF position computed from a known geodetic coordinate
        let lat = 48.8584_f64.to_radians();
        let lon = 2.2945_f64.to_radians();
        let alt = 300.0;
        let sin_lat = lat.sin();
        let n = WGS84_A / (1.0 - WGS84_E2 * sin_lat * sin_lat).sqrt();
        let x = (n + alt) * cos_lat(lat) * lon.cos();
        let y = (n + alt) * cos_lat(lat) * lon.sin();
        let z = (n * (1.0 - WGS84_E2) + alt) * sin_lat;

        let (rlat, rlon, ralt) = ecef_to_geodetic(x, y, z);
        assert!((rlat - lat).abs() < 1e-9, "lat {} vs {}", rlat, lat);
        assert!((rlon - lon).abs() < 1e-9);
        assert!((ralt - alt).abs() < 1e-6, "alt {} vs {}", ralt, alt);
    }

    #[test]
    fn geodetic_negative_east_longitude() {
        // Point at longitude -45° on the equator of the ellipsoid
        let x = WGS84_A * std::f64::consts::FRAC_1_SQRT_2;
        let (lat, lon, alt) = ecef_to_geodetic(x, -x, 0.0);
        assert!(lat.abs() < 1e-9);
        assert!((lon + std::f64::consts::FRAC_PI_4).abs() < 1e-9);
        assert!(alt.abs() < TOL);
    }

    fn cos_lat(lat: f64) -> f64 {
        lat.cos()
    }
}
