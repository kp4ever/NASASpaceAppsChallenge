// Mitigation Strategy Calculations

// Constants
const G = 6.67430e-11;  // Gravitational constant
const EARTH_MASS = 5.972e24;  // kg
const AU = 149597870700;  // meters
const YEAR_SECONDS = 31557600;  // seconds in a year

/**
 * Calculate kinetic impact deflection
 * @param {Object} asteroid - Asteroid parameters (mass, velocity, distance)
 * @param {Object} impactor - Impactor parameters (mass, velocity)
 * @returns {Object} New asteroid trajectory
 */
function calculateKineticImpact(asteroid, impactor) {
    // Conservation of momentum
    const combinedMass = asteroid.mass + impactor.mass;
    const newVelocity = {
        x: (asteroid.mass * asteroid.velocity.x + impactor.mass * impactor.velocity.x) / combinedMass,
        y: (asteroid.mass * asteroid.velocity.y + impactor.mass * impactor.velocity.y) / combinedMass,
        z: (asteroid.mass * asteroid.velocity.z + impactor.mass * impactor.velocity.z) / combinedMass
    };
    
    return {
        velocity: newVelocity,
        deflectionAngle: calculateDeflectionAngle(asteroid.velocity, newVelocity),
        missDistance: calculateNewMissDistance(asteroid, newVelocity)
    };
}

/**
 * Calculate gravity tractor effect
 * @param {Object} asteroid - Asteroid parameters
 * @param {Object} tractor - Spacecraft parameters
 * @param {number} duration - Duration in seconds
 * @returns {Object} Deflection results
 */
function calculateGravityTractor(asteroid, tractor, duration) {
    // Force between asteroid and tractor
    const distance = tractor.hoverDistance;
    const force = (G * asteroid.mass * tractor.mass) / (distance * distance);
    
    // Acceleration imparted to asteroid
    const acceleration = force / asteroid.mass;
    
    // Total velocity change
    const deltaV = acceleration * duration;
    
    // Calculate new trajectory
    const deflectionDistance = 0.5 * acceleration * duration * duration;
    
    return {
        deltaV,
        deflectionDistance,
        requiredHoverTime: calculateRequiredHoverTime(asteroid, deltaV)
    };
}

/**
 * Calculate nuclear standoff deflection
 * @param {Object} asteroid - Asteroid parameters
 * @param {number} megatons - Nuclear yield in megatons TNT
 * @param {number} standoffDistance - Distance in meters
 * @returns {Object} Deflection results
 */
function calculateNuclearDeflection(asteroid, megatons, standoffDistance) {
    // Convert megatons to joules
    const energy = megatons * 4.184e15;
    
    // Calculate radiation coupling efficiency
    const efficiency = calculateRadiationCoupling(standoffDistance, asteroid.radius);
    
    // Calculate momentum transfer
    const ablatedMass = calculateAblatedMass(energy * efficiency, asteroid.material);
    const exhaustVelocity = Math.sqrt(2 * energy * efficiency / ablatedMass);
    const deltaV = ablatedMass * exhaustVelocity / asteroid.mass;
    
    return {
        deltaV,
        ablatedMass,
        deflectionDistance: calculateDeflectionDistance(deltaV, asteroid.timeToImpact)
    };
}

// Helper functions

function calculateDeflectionAngle(v1, v2) {
    const dot = v1.x * v2.x + v1.y * v2.y + v1.z * v2.z;
    const mag1 = Math.sqrt(v1.x * v1.x + v1.y * v1.y + v1.z * v1.z);
    const mag2 = Math.sqrt(v2.x * v2.x + v2.y * v2.y + v2.z * v2.z);
    return Math.acos(dot / (mag1 * mag2)) * 180 / Math.PI;
}

function calculateNewMissDistance(asteroid, newVelocity) {
    const speed = Math.sqrt(
        newVelocity.x * newVelocity.x + 
        newVelocity.y * newVelocity.y + 
        newVelocity.z * newVelocity.z
    );
    
    const angle = calculateDeflectionAngle(asteroid.velocity, newVelocity);
    return asteroid.distance * Math.tan(angle * Math.PI / 180);
}

function calculateRequiredHoverTime(asteroid, deltaV) {
    const escape_velocity = Math.sqrt(2 * G * asteroid.mass / (asteroid.radius * asteroid.radius));
    return (deltaV / escape_velocity) * asteroid.timeToImpact;
}

function calculateRadiationCoupling(distance, radius) {
    const solidAngle = Math.PI * radius * radius / (4 * Math.PI * distance * distance);
    return Math.min(0.7 * solidAngle, 0.7); // Max 70% coupling efficiency
}

function calculateAblatedMass(energy, material) {
    // Simplified calculation based on material properties
    const specificHeat = material === 'ice' ? 2000 : 1000; // J/kg/K
    const vaporization = material === 'ice' ? 2.3e6 : 8e6; // J/kg
    return energy / (specificHeat * 2000 + vaporization); // Assume 2000K temperature rise
}

function calculateDeflectionDistance(deltaV, timeToImpact) {
    return deltaV * timeToImpact;
}

// Export functions
export {
    calculateKineticImpact,
    calculateGravityTractor,
    calculateNuclearDeflection
};