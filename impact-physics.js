// Advanced Impact Physics Calculations

// Constants
const G = 6.67430e-11;  // Gravitational constant in m³/kg/s²
const EARTH_MASS = 5.972e24;  // Earth's mass in kg
const EARTH_RADIUS = 6371000;  // Earth's radius in meters
const AIR_DENSITY = 1.225;  // Air density at sea level in kg/m³

/**
 * Calculate the final velocity after atmospheric entry
 * Uses the pancake model for atmospheric entry
 */
function calculateAtmosphericEntry(initialVelocity, radius, density, entryAngle) {
    const crossSection = Math.PI * radius * radius;
    const mass = (4/3) * Math.PI * Math.pow(radius, 3) * density;
    const dragCoefficient = 1.0;  // Approximate for spherical object
    
    // Simplified atmospheric drag equation
    const velocityLoss = (AIR_DENSITY * crossSection * dragCoefficient * Math.pow(initialVelocity, 2)) / (2 * mass);
    const finalVelocity = Math.max(0, initialVelocity - velocityLoss);
    
    return finalVelocity;
}

/**
 * Calculate crater dimensions using scaling laws
 * Based on Holsapple (1993) crater scaling relationships
 */
function calculateCraterDimensions(energy, targetDensity, gravity, impactAngle) {
    const pi2 = energy / (targetDensity * Math.pow(gravity, 1.65));
    const transientRadius = 0.75 * Math.pow(pi2, 0.13);  // Simple-to-complex transition
    
    // Adjust for impact angle (vertical = 1.0)
    const angleEffect = Math.pow(Math.sin(impactAngle * Math.PI / 180), 0.33);
    
    return {
        radius: transientRadius * angleEffect,
        depth: transientRadius * angleEffect * 0.28  // Depth-to-diameter ratio
    };
}

/**
 * Calculate seismic effects using energy-magnitude scaling
 * Returns Richter scale magnitude and max distance for various effects
 */
function calculateSeismicEffects(energy) {
    // Convert energy to TNT equivalent
    const TNT = energy / 4.184e9;
    
    // Empirical relationship for seismic magnitude
    const magnitude = 0.67 * (Math.log10(TNT) - 0.645);
    
    // Calculate effect radii based on magnitude
    const effects = {
        magnitude: magnitude,
        severeShaking: Math.pow(10, 0.5 * magnitude - 1.8),  // km
        moderateShaking: Math.pow(10, 0.5 * magnitude - 1.2),  // km
        lightShaking: Math.pow(10, 0.5 * magnitude - 0.6)   // km
    };
    
    return effects;
}

/**
 * Calculate tsunami wave height and propagation
 * Simplified model based on energy and water depth
 */
function calculateTsunamiEffects(energy, waterDepth, distance) {
    if (waterDepth <= 0) return { height: 0, velocity: 0 };
    
    // Deep water wave velocity
    const waveVelocity = Math.sqrt(9.81 * waterDepth);  // m/s
    
    // Initial wave height (simplified energy conversion)
    const initialHeight = Math.pow(energy / (1000 * 9.81 * waterDepth), 0.25);
    
    // Wave height decay with distance (cylindrical spreading)
    const height = initialHeight * Math.sqrt(100 / Math.max(distance, 100));
    
    return {
        height: height,
        velocity: waveVelocity
    };
}

/**
 * Calculate atmospheric effects (shock wave, thermal radiation)
 */
function calculateAtmosphericEffects(energy, altitude) {
    const TNT = energy / 4.184e9;
    
    // Scaled distance for overpressure calculations
    const z = (r) => r / Math.pow(TNT, 1/3);
    
    // Calculate blast wave overpressure at different distances
    const getOverpressure = (r) => {
        const zVal = z(r);
        return 808 * Math.pow(1 + Math.pow(zVal/4.5, 2), -1.5);  // kPa
    };
    
    // Calculate thermal radiation intensity
    const thermalEnergy = 0.3 * energy;  // 30% converted to thermal
    const getThermalIntensity = (r) => {
        return thermalEnergy / (4 * Math.PI * Math.pow(r, 2));  // W/m²
    };
    
    return {
        overpressure: getOverpressure,
        thermalIntensity: getThermalIntensity
    };
}

// Export all functions
export {
    calculateAtmosphericEntry,
    calculateCraterDimensions,
    calculateSeismicEffects,
    calculateTsunamiEffects,
    calculateAtmosphericEffects
};