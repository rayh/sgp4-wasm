/**
 * DISCOSweb API Client
 * ====================
 * Thin browser-side client for ESA's DISCOSweb REST API.
 * API base: https://discosweb.esoc.esa.int/api/
 * Auth: Bearer token (ESA SSO)
 * Format: JSON:API (https://jsonapi.org/)
 *
 * Requires user to provide their own API token.
 */

const DISCOS_API_BASE = 'https://discosweb.esoc.esa.int/api';

export class DiscosClient {
    constructor(token) {
        this.token = token;
        this.headers = {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.api+json',
        };
    }

    /**
     * Generic GET request with JSON:API query params.
     */
    async get(endpoint, params = {}) {
        const url = new URL(`${DISCOS_API_BASE}/${endpoint}`);
        for (const [key, value] of Object.entries(params)) {
            url.searchParams.set(key, value);
        }

        const response = await fetch(url.toString(), { headers: this.headers });

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`DISCOSweb API error ${response.status}: ${text}`);
        }

        return response.json();
    }

    /**
     * Search objects by name (partial match).
     * Returns array of objects with id, name, noradId, cosparId, objectClass.
     */
    async searchObjects(name, { page = 1, pageSize = 20 } = {}) {
        const result = await this.get('objects', {
            'filter': `icontains(name,${name})`,
            'page[number]': page,
            'page[size]': pageSize,
            'sort': 'name',
        });

        return {
            objects: (result.data || []).map(obj => this._parseObject(obj)),
            meta: result.meta,
            links: result.links,
        };
    }

    /**
     * Get a single object by DISCOS ID.
     */
    async getObject(id) {
        const result = await this.get(`objects/${id}`);
        return this._parseObject(result.data);
    }

    /**
     * Get objects by NORAD catalog number.
     */
    async getObjectByNoradId(noradId) {
        const result = await this.get('objects', {
            'filter': `eq(satno,${noradId})`,
        });

        if (result.data && result.data.length > 0) {
            return this._parseObject(result.data[0]);
        }
        return null;
    }

    /**
     * Get initial orbit data for an object.
     */
    async getInitialOrbits(objectId, { page = 1, pageSize = 10 } = {}) {
        const result = await this.get('initial-orbits', {
            'filter': `eq(object.id,${objectId})`,
            'page[number]': page,
            'page[size]': pageSize,
            'sort': '-epoch',
        });

        return (result.data || []).map(orbit => ({
            id: orbit.id,
            epoch: orbit.attributes?.epoch,
            semiMajorAxis_km: orbit.attributes?.sma,
            eccentricity: orbit.attributes?.ecc,
            inclination_deg: orbit.attributes?.inc,
            raan_deg: orbit.attributes?.raan,
            argPerigee_deg: orbit.attributes?.argp,
            meanAnomaly_deg: orbit.attributes?.meanAnomaly,
            apogee_km: orbit.attributes?.apogee,
            perigee_km: orbit.attributes?.perigee,
            period_min: orbit.attributes?.period,
        }));
    }

    /**
     * Get objects filtered by orbit regime.
     */
    async getObjectsByOrbitClass(orbitClass, { page = 1, pageSize = 50 } = {}) {
        // orbitClass: LEO, MEO, GEO, HEO, etc.
        const result = await this.get('objects', {
            'filter': `eq(objectClass,${orbitClass})`,
            'page[number]': page,
            'page[size]': pageSize,
        });

        return {
            objects: (result.data || []).map(obj => this._parseObject(obj)),
            meta: result.meta,
        };
    }

    /**
     * Get reentry events.
     */
    async getReentries({ page = 1, pageSize = 20 } = {}) {
        const result = await this.get('reentries', {
            'page[number]': page,
            'page[size]': pageSize,
            'sort': '-epoch',
        });

        return (result.data || []).map(r => ({
            id: r.id,
            epoch: r.attributes?.epoch,
            ...r.attributes,
        }));
    }

    /**
     * Parse a JSON:API object resource into a flat structure.
     */
    _parseObject(obj) {
        if (!obj) return null;
        const attrs = obj.attributes || {};
        return {
            id: obj.id,
            name: attrs.name,
            noradId: attrs.satno,
            cosparId: attrs.cosparId,
            objectClass: attrs.objectClass,
            shape: attrs.shape,
            mass_kg: attrs.mass,
            length_m: attrs.length,
            width_m: attrs.width,
            height_m: attrs.height,
            crossSection_m2: attrs.xSectMax,
            depth_m: attrs.depth,
            diameter_m: attrs.diameter,
            span_m: attrs.span,
            // Orbit info if included
            apogee_km: attrs.apogee,
            perigee_km: attrs.perigee,
            inclination_deg: attrs.inc,
            period_min: attrs.period,
        };
    }
}

/**
 * Fetch TLE from Celestrak (public, no auth needed).
 * DISCOSweb doesn't serve TLEs directly — Celestrak/Space-Track are the sources.
 * This is a convenience for getting propagatable TLEs by NORAD ID.
 */
export async function fetchTleFromCelestrak(noradId) {
    const url = `https://celestrak.org/NORAD/elements/gp.php?CATNR=${noradId}&FORMAT=TLE`;
    const response = await fetch(url);

    if (!response.ok) {
        throw new Error(`Celestrak error ${response.status}`);
    }

    const text = await response.text();
    const lines = text.trim().split('\n').map(l => l.trim()).filter(l => l.length > 0);

    if (lines.length === 3) {
        return { name: lines[0], line1: lines[1], line2: lines[2] };
    } else if (lines.length === 2) {
        return { name: null, line1: lines[0], line2: lines[1] };
    }

    throw new Error(`Unexpected TLE format: ${lines.length} lines`);
}

/**
 * Fetch TLEs for a group of objects from Celestrak.
 * group: e.g. 'stations', 'starlink', 'active', 'cosmos-2251-debris'
 */
export async function fetchTleGroup(group) {
    const url = `https://celestrak.org/NORAD/elements/gp.php?GROUP=${group}&FORMAT=TLE`;
    const response = await fetch(url);

    if (!response.ok) {
        throw new Error(`Celestrak error ${response.status}`);
    }

    const text = await response.text();
    const lines = text.trim().split('\n').map(l => l.trim()).filter(l => l.length > 0);

    const tles = [];
    for (let i = 0; i < lines.length - 2; i += 3) {
        tles.push({
            name: lines[i],
            line1: lines[i + 1],
            line2: lines[i + 2],
        });
    }

    return tles;
}

/**
 * Well-known objects for quick selection (no API needed).
 */
export const WELL_KNOWN_OBJECTS = [
    {
        name: 'ISS (ZARYA)',
        noradId: 25544,
        description: 'International Space Station',
        orbitType: 'LEO',
    },
    {
        name: 'TIANGONG',
        noradId: 48274,
        description: 'Chinese Space Station',
        orbitType: 'LEO',
    },
    {
        name: 'HUBBLE',
        noradId: 20580,
        description: 'Hubble Space Telescope',
        orbitType: 'LEO',
    },
    {
        name: 'STARLINK-30000',
        noradId: 56200,
        description: 'Starlink satellite (representative)',
        orbitType: 'LEO',
    },
    {
        name: 'SENTINEL-2A',
        noradId: 40697,
        description: 'ESA Earth observation (SSO)',
        orbitType: 'SSO',
    },
    {
        name: 'COSMOS 2251 DEB',
        noradId: 34454,
        description: 'Iridium-Cosmos collision debris',
        orbitType: 'LEO',
    },
    {
        name: 'FENGYUN 1C DEB',
        noradId: 31141,
        description: 'Chinese ASAT test debris',
        orbitType: 'LEO',
    },
    {
        name: 'GPS BIIR-2 (PRN 13)',
        noradId: 24876,
        description: 'GPS navigation satellite',
        orbitType: 'MEO',
    },
    {
        name: 'ASTRA 1N',
        noradId: 37775,
        description: 'GEO communications satellite',
        orbitType: 'GEO',
    },
    {
        name: 'MOLNIYA 1-91',
        noradId: 25485,
        description: 'Highly elliptical orbit',
        orbitType: 'HEO',
    },
];
