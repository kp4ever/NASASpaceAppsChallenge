// USGS Data Integration

// Primary USGS endpoint (may not set CORS headers for browser requests)
const USGS_ELEVATION_API = 'https://nationalmap.gov/epqs/pqs.php';
// Public, CORS-friendly alternative: Open-Elevation (limited rate)
const OPEN_ELEVATION_API = 'https://api.open-elevation.com/api/v1/lookup';
const USGS_SEISMIC_FEED = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson';

// Optional CORS proxy (leave null to disable). You can run a simple local CORS proxy
// (for example: https://github.com/Rob--W/cors-anywhere/) and set its URL here.
const OPTIONAL_CORS_PROXY = null; // e.g. 'https://my-cors-proxy.example.com/'

// Helper: attempt fetch and detect CORS failure by checking for network errors
async function tryFetch(url, options = {}) {
    try {
        const response = await fetch(url, options);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.json();
    } catch (err) {
        // Rethrow to allow caller to handle fallback; log minimal info
        console.warn(`Fetch failed for ${url}: ${err.message}`);
        throw err;
    }
}

// Fetch elevation data for impact point with fallbacks to avoid CORS blocking in the browser
async function getElevation(lat, lon) {
    const usgsUrl = `${USGS_ELEVATION_API}?x=${lon}&y=${lat}&units=Meters&output=json`;
    try {
        const urlToUse = OPTIONAL_CORS_PROXY ? OPTIONAL_CORS_PROXY + usgsUrl : usgsUrl;
        const data = await tryFetch(urlToUse);
        
        if (data && data.USGS_Elevation_Point_Query_Service && data.USGS_Elevation_Point_Query_Service.Elevation_Query) {
            return data.USGS_Elevation_Point_Query_Service.Elevation_Query.Elevation || 0;
        }
    } catch (err) {}

    try {
        const openUrl = `${OPEN_ELEVATION_API}?locations=${lat},${lon}`;
        const data = await tryFetch(openUrl);
        if (data && data.results && data.results.length > 0 && typeof data.results[0].elevation === 'number') {
            return data.results[0].elevation;
        }
    } catch (err) {}

    // 3) If configured, try the optional proxy with Open-Elevation through the proxy
    if (OPTIONAL_CORS_PROXY) {
        try {
            const proxiedOpen = OPTIONAL_CORS_PROXY + `${OPEN_ELEVATION_API}?locations=${lat},${lon}`;
            const data = await tryFetch(proxiedOpen);
            if (data && data.results && data.results.length > 0) return data.results[0].elevation || 0;
        } catch (err) {}
    }

    // 4) Final fallback: return sea level (0) and log the issue once
    console.error('All elevation providers failed or were blocked by CORS. Returning elevation=0.');
    return 0;
}

// Check if impact point is in a tsunami risk zone
// Using simplified coastal elevation check
async function checkTsunamiRisk(lat, lon) {
    const elevation = await getElevation(lat, lon);
    const COASTAL_THRESHOLD = 100; // meters
    
    // If elevation is low and near coast, consider it at risk
    return elevation < COASTAL_THRESHOLD;
}

// Get recent seismic activity near impact point
async function getSeismicActivity(lat, lon, radius = 100) {
    try {
        const response = await fetch(USGS_SEISMIC_FEED);
        const data = await response.json();
        
        // Filter earthquakes within radius km of impact point
        return data.features.filter(quake => {
            const [qLon, qLat] = quake.geometry.coordinates;
            const distance = calculateDistance(lat, lon, qLat, qLon);
            return distance <= radius;
        });
    } catch (error) {
        console.error('Error fetching seismic data:', error);
        return [];
    }
}

// Helper function to calculate distance between two points
function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // Earth's radius in km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = 
        Math.sin(dLat/2) * Math.sin(dLat/2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
        Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
}