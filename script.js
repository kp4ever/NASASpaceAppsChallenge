// Use global UMD bundles: THREE and Globe (from globe.gl UMD build)
// IIFE to avoid global scope pollution
(async function() {
    // Utility function for debouncing resize events
    function debounce(func, wait) {
        let timeout;
        return function executedFunction(...args) {
            const later = () => {
                clearTimeout(timeout);
                func(...args);
            };
            clearTimeout(timeout);
            timeout = setTimeout(later, wait);
        };
    }

    // Global variables for visualization
    let currentPage = 'simulator';
    let menuOpen = true;
    let globe;
    let lat = 0, lon = 0; // Default impact coordinates
    let impactMarker = null; // Track the current impact marker

    // --- Population / casualty estimation helpers ---
    // Small sample of major cities with lat, lon, and approximate population (used for coarse casualty estimates)
    const CITY_POPULATION_SAMPLES = [
        { name: 'Tokyo', lat: 35.6895, lon: 139.6917, pop: 37400068 },
        { name: 'Delhi', lat: 28.7041, lon: 77.1025, pop: 28514000 },
        { name: 'Shanghai', lat: 31.2304, lon: 121.4737, pop: 25582000 },
        { name: 'Sao Paulo', lat: -23.5505, lon: -46.6333, pop: 21650000 },
        { name: 'Mexico City', lat: 19.4326, lon: -99.1332, pop: 21581000 },
        { name: 'Cairo', lat: 30.0444, lon: 31.2357, pop: 20076000 },
        { name: 'Mumbai', lat: 19.0760, lon: 72.8777, pop: 19980000 },
        { name: 'Beijing', lat: 39.9042, lon: 116.4074, pop: 19618000 },
        { name: 'Dhaka', lat: 23.8103, lon: 90.4125, pop: 19578000 },
        { name: 'Osaka', lat: 34.6937, lon: 135.5023, pop: 19281000 },
        { name: 'New York', lat: 40.7128, lon: -74.0060, pop: 18804000 },
        { name: 'Karachi', lat: 24.8607, lon: 67.0011, pop: 15400000 },
        { name: 'Buenos Aires', lat: -34.6037, lon: -58.3816, pop: 14967000 },
        { name: 'Kolkata', lat: 22.5726, lon: 88.3639, pop: 14667000 },
        { name: 'Istanbul', lat: 41.0082, lon: 28.9784, pop: 15030000 },
        { name: 'Manila', lat: 14.5995, lon: 120.9842, pop: 13923452 },
        { name: 'Lagos', lat: 6.5244, lon: 3.3792, pop: 13900000 },
        { name: 'Rio de Janeiro', lat: -22.9068, lon: -43.1729, pop: 13293000 },
        { name: 'Tianjin', lat: 39.3434, lon: 117.3616, pop: 13215000 },
        { name: 'Kinshasa', lat: -4.4419, lon: 15.2663, pop: 13130000 }
    ];

    // Basic haversine distance (km)
    function haversineKm(lat1, lon1, lat2, lon2) {
        const R = 6371; // km
        const toRad = (d) => d * Math.PI / 180;
        const dLat = toRad(lat2 - lat1);
        const dLon = toRad(lon2 - lon1);
        const a = Math.sin(dLat/2) * Math.sin(dLat/2) + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2) * Math.sin(dLon/2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
        return R * c;
    }

    // Estimate population within a radius (km) using city samples plus a low background density for non-city areas
    function estimatePopulationWithin(latC, lonC, radiusKm) {
        // Sum populations of sample cities weighted by overlap (if city center lies within radius)
        let pop = 0;
        CITY_POPULATION_SAMPLES.forEach(city => {
            const d = haversineKm(latC, lonC, city.lat, city.lon);
            if (d <= radiusKm) pop += city.pop;
            else if (d <= radiusKm * 2) pop += city.pop * 0.25; // partial influence
        });
        // Add coarse rural population estimate: area * average density (people per km^2)
        const areaKm2 = Math.PI * Math.pow(radiusKm, 2);
        // global average density ~58 people/km^2 but much of Earth's surface is water - use conservative 20
        const backgroundDensity = 20; // people per km^2
        const ruralPop = Math.max(0, areaKm2 * backgroundDensity - 50000); // subtract some to avoid double-counting
        pop += Math.max(0, ruralPop);
        return Math.round(pop);
    }

    // Estimate lives lost using coarse CFR (case-fatality ratio) by distance band (within crater, within severe blast, within shockwave)
    function estimateLivesLost(population, impact) {
        // Distribute population with severity bands: inside crater (most severe), inside blast radius (severe), inside shockwave (moderate)
        const craterPop = Math.round(population * 0.25);
        const blastPop = Math.round(population * 0.45);
        const shockPop = Math.round(population * 0.30);

        // CFR assumptions (very coarse): crater 90%, blast 30%, shock 5%
        const craterDeaths = Math.round(craterPop * 0.9);
        const blastDeaths = Math.round(blastPop * 0.3);
        const shockDeaths = Math.round(shockPop * 0.05);

        const totalDeaths = craterDeaths + blastDeaths + shockDeaths;
        return {
            totalDeaths,
            breakdown: { craterDeaths, blastDeaths, shockDeaths }
        };
    }

    // Rough economic cost estimate based on population affected and impact energy
    function estimateEconomicCost(population, impact) {
        // Base per-person cost assumption for severe disasters: $20k per affected person
        const perPerson = 20000;
        const popCost = population * perPerson;
        // Energy multiplier: scale cost by (impact.energy / 1e15) to reflect larger events
        const energyFactor = Math.max(1, impact.energy / 1e15);
        const cost = Math.round(popCost * energyFactor);
        return cost;
    }

    // Format large numbers with SI-style suffixes
    function formatLargeNumber(n) {
        if (n >= 1e12) return (n / 1e12).toFixed(2) + 'T';
        if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
        if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
        if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
        return String(n);
    }

    // Create or update the impact facts overlay element
    function showImpactFacts(latC, lonC, impact) {
        let container = document.querySelector('.impact-facts');
        if (!container) {
            container = document.createElement('div');
            container.className = 'impact-facts';
            // No close button: overlay is persistent over the globe
            container.innerHTML = '<h4>Impact Facts</h4><div class="facts"></div>';
            // Prefer to append to the main globe container so it sits over the earth model
            const mainView = document.querySelector('.main-view') || document.body;
            mainView.appendChild(container);
        }

        const blastKm = Math.round((impact.blastRadius || 0) / 1000);
        const craterM = Math.round(impact.craterDiameter || 0);
        const pop = estimatePopulationWithin(latC, lonC, Math.max(blastKm, 10));
        const casualties = estimateLivesLost(pop, impact);
        const cost = estimateEconomicCost(pop, impact);

        const factsEl = container.querySelector('.facts');
        factsEl.innerHTML = '';
        const rows = [
            ['Impact Energy', (impact.energy >= 1e18 ? (impact.energy/1e18).toFixed(2)+' EJ' : (impact.energy>=1e15 ? (impact.energy/1e15).toFixed(2)+' PJ' : (impact.energy/1e12).toFixed(2)+' TJ'))],
            ['Crater Diameter', craterM >= 1000 ? (craterM/1000).toFixed(1)+' km' : craterM+' m'],
            ['Blast Radius', blastKm + ' km'],
            ['Population within blast', formatLargeNumber(pop)],
            ['Estimated lives lost', formatLargeNumber(casualties.totalDeaths)],
            ['Estimated cost', '$' + formatLargeNumber(cost)],
            ['Seismic magnitude', (impact.seismicMagnitude||0).toFixed(2)],
        ];

        rows.forEach(([label, val]) => {
            const r = document.createElement('div'); r.className = 'fact-row';
            const l = document.createElement('div'); l.className = 'fact-label'; l.textContent = label;
            const v = document.createElement('div'); v.className = 'fact-value'; v.textContent = val;
            r.appendChild(l); r.appendChild(v); factsEl.appendChild(r);
        });

        const note = document.createElement('div'); note.className = 'small-note'; note.textContent = 'Estimates are coarse and for educational purposes only.';
        factsEl.appendChild(note);
        container.style.display = 'block';
    }

    // Hide or remove the impact facts window
    function hideImpactFacts() {
        const container = document.querySelector('.impact-facts');
        if (container) {
            container.style.display = 'none';
            // Optionally remove completely: container.remove();
        }
    }

    // NASA NEO API configuration
    const NASA_API_KEY = 'DEMO_KEY'; // Replace with your NASA API key if needed
    const NASA_NEO_API = 'https://api.nasa.gov/neo/rest/v1/';

    // Function to provide specific high-risk asteroid data
    async function fetchNearEarthObjects() {
        return [{
            name: "Impactor-2025",
            absoluteMagnitude: 22.4,
            diameter: {
                min: 100,
                max: 225
            },
            nextApproach: {
                date: "2027-03-14",
                distance: 135000, // km
                au: 0.0009
            },
            hazardous: true,
            impactRisk: {
                probability: 0.00012, // 1.2 × 10⁻⁴
                probabilityFraction: "1 in 8,300",
                timeframe: "2025–2125",
                palegroScale: -2.6,
                torinoScale: 1
            },
            velocity: 25.3, // Example velocity in km/s
            missDistance: 135000 // km
        }];
    }

    // Update NEO list display
    async function updateNEOList() {
        const neoList = document.getElementById('neo-list');
        const asteroids = await fetchNearEarthObjects();
        
        if (asteroids.length === 0) {
            neoList.innerHTML = '<p>No near-Earth objects found.</p>';
            return;
        }

        const asteroid = asteroids[0];
        
        neoList.innerHTML = `
            <div class="neo-item hazardous" onclick="loadNEO('${asteroid.name}', ${asteroid.diameter.max}, ${asteroid.velocity})">
                <div class="name">${asteroid.name}</div>
                <div class="stats">
                    <strong>Absolute Magnitude (H):</strong> ${asteroid.absoluteMagnitude}<br>
                    <strong>Estimated Diameter:</strong> ${asteroid.diameter.min}–${asteroid.diameter.max} m<br>
                    <strong>Next Close Approach:</strong> ${asteroid.nextApproach.date}<br>
                    <strong>Approach Distance:</strong> ${asteroid.nextApproach.au} au (${(asteroid.nextApproach.distance).toLocaleString()} km)<br>
                    <strong>Impact Probability:</strong> ${asteroid.impactRisk.probability.toExponential(1)} (${asteroid.impactRisk.probabilityFraction})<br>
                    <strong>Risk Period:</strong> ${asteroid.impactRisk.timeframe}<br>
                    <strong>Palermo Scale:</strong> ${asteroid.impactRisk.palegroScale}<br>
                    <strong>Torino Scale:</strong> ${asteroid.impactRisk.torinoScale}
                </div>
            </div>
        `;
    }

    // Initialize visualization
    async function initGlobe() {
        try {
            console.log('initGlobe: starting');
            // Initialize Globe.GL
            await updateNEOList(); // Fetch and display NEO data
            
            const mainView = document.querySelector('.main-view');
            const width = window.innerWidth;
            const height = window.innerHeight;

            // Initialize the globe instance and mount it into the DOM container
            globe = Globe()(mainView)
                .width(width)
                .height(height)
                .globeImageUrl('//unpkg.com/three-globe/example/img/earth-blue-marble.jpg')
                .bumpImageUrl('//unpkg.com/three-globe/example/img/earth-topology.png')
                .backgroundImageUrl('//unpkg.com/three-globe/example/img/night-sky.png')
                // Use a full-scene background image so the background fills the canvas area
                .showAtmosphere(true)
                .atmosphereColor('lightskyblue')
                .atmosphereAltitude(0.2);
            
                // Register click handler so user can select an impact location (won't simulate immediately)
                globe.onGlobeClick((latLng) => {
                    // latLng is { lat, lng }
                    lat = latLng.lat;
                    lon = latLng.lng;
                    console.log('Selected impact location (click):', { lat, lon });
                    
                    // Update impact marker
                    updateImpactMarker(lat, lon);
                    
                    // Update instruction text to inform user
                    try {
                        const instr = document.querySelector('.instruction');
                        if (instr) instr.textContent = 'Impact location selected. Press "Simulation Start" to run.';
                    } catch (e) {
                        /* ignore */
                    }
                });

                // Debug: expose some globe API info so we can inspect in the console
                try {
                    console.log('globe API methods:', Object.keys(globe).filter(k => typeof globe[k] === 'function'));
                    // Do not initialize pointsData — we'll render flat disks/rings via customLayerData
                } catch (e) {
                    console.warn('Could not inspect globe API or initialize pointsData:', e && e.message);
                }

                // Ensure UI panels (impact info, legend, instruction) are present and on top.
                // Some Globe.gl builds replace the container's innerHTML when mounting the canvas,
                // which can remove elements placed inside `.main-view`. Move these panels to document.body
                // so they persist above the globe canvas.
                try {
                    ['impact-info', 'legend', 'instruction'].forEach(id => {
                        const el = document.getElementById(id);
                        if (el && !document.body.contains(el)) {
                            // Set absolute positioning to overlay on the globe
                            el.style.position = 'absolute';
                            el.style.zIndex = 2000;
                            // Try to preserve the original top/right/left styles if present
                            document.body.appendChild(el);
                        }
                    });
                } catch (e) {
                    console.warn('Could not reattach UI panels after globe mount:', e && e.message);
                }

                // Configure controls after globe creation (some Globe.gl builds don't expose chainable zoom methods)
                try {
                    const controls = globe.controls && globe.controls();
                    if (controls) {
                        if (typeof controls.zoomSpeed !== 'undefined') controls.zoomSpeed = 4;
                        if (typeof controls.enableZoom !== 'undefined') controls.enableZoom = true;
                        // Optionally set reasonable distance limits if properties exist
                        if (typeof controls.minDistance !== 'undefined') controls.minDistance = 10;
                        if (typeof controls.maxDistance !== 'undefined') controls.maxDistance = 1000;
                        controls.update && controls.update();
                    }
                } catch (e) {
                    console.warn('Could not adjust globe controls:', e && e.message);
                }

                // Smooth scroll wheel zooming on the globe container
                try {
                    const container = mainView;
                    container.addEventListener('wheel', (ev) => {
                        // Prevent page scroll but keep zoom subtle
                        ev.preventDefault();
                        const delta = ev.deltaY;
                        const controls = globe.controls && globe.controls();

                        // Prefer OrbitControls dolly methods if available
                        if (controls && typeof controls.dollyIn === 'function' && typeof controls.dollyOut === 'function') {
                            // Small multiplicative step based on wheel delta
                            const factor = 1 + Math.min(0.12, Math.abs(delta) / 800);
                            if (delta > 0) controls.dollyOut(factor); else controls.dollyIn(factor);
                            controls.update && controls.update();
                            return;
                        }

                        // Fallback: move camera along its position vector toward/away from origin
                        try {
                            const cam = globe.camera && globe.camera();
                            if (!cam || !cam.position) return;

                            // Compute small multiplicative zoom factor
                            const zoomStep = Math.sign(delta) * Math.min(0.15, Math.abs(delta) / 1000);
                            const zoomFactor = 1 + zoomStep;

                            // Move camera smoothly by scaling its position vector
                            cam.position.multiplyScalar(zoomFactor);

                            // Clamp distance to reasonable world units to avoid runaway zoom
                            const minDist = 30; // conservative minimum
                            const maxDist = 2000; // conservative maximum
                            const dist = cam.position.length();
                            if (dist < minDist) cam.position.setLength(minDist);
                            if (dist > maxDist) cam.position.setLength(maxDist);

                            cam.updateProjectionMatrix && cam.updateProjectionMatrix();
                        } catch (err) {
                            console.warn('Wheel zoom fallback failed:', err && err.message);
                        }
                    }, { passive: false });
                } catch (e) {
                    console.warn('Could not attach custom wheel handler for zoom amplification:', e && e.message);
                }
            
            // Set up event listeners after DOM is ready
            setupEventListeners();
            // Sync sidebar height to the main canvas area so they align visually
            try { syncSidebarToMain(); } catch (e) { /* ignore */ }
            
            // Add initial impact marker at default location
            updateImpactMarker(lat, lon);
        } catch (error) {
            console.error('Error initializing globe:', error);
        }
        console.log('initGlobe: finished');
    }

    // Keep the sidebar height matched to the rendered main-view/canvas height
    function syncSidebarToMain() {
        const sidebar = document.querySelector('.sidebar');
        const mainView = document.querySelector('.main-view');
        if (!sidebar || !mainView) return;

        const update = () => {
            try {
                // Prefer to match the actual rendered canvas height if present
                const canvas = mainView.querySelector('canvas');
                let available = 0;
                if (canvas && canvas.clientHeight && canvas.clientHeight > 50) {
                    available = canvas.clientHeight;
                } else {
                    // Fallback: use mainView height minus nav/padding
                    const rect = mainView.getBoundingClientRect();
                    const nav = document.querySelector('.top-nav');
                    const navHeight = nav ? nav.offsetHeight : 0;
                    available = Math.max(240, window.innerHeight - navHeight - 120);
                    // If mainView rect is larger, prefer it
                    if (rect && rect.height > available) available = Math.round(rect.height);
                }

                // Apply height to sidebar (allow some breathing room)
                sidebar.style.maxHeight = (available) + 'px';
                sidebar.style.height = (available) + 'px';
            } catch (err) { console.warn('syncSidebarToMain failed:', err && err.message); }
        };

    // Initial sync (run immediately and shortly after to allow canvas to size)
    update();
    setTimeout(update, 220);

    // Debounced resize listener
    const onResize = debounce(() => update(), 120);
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);

        // Expose for debugging/cleanup
        window._syncSidebarToMain = { update, onResize };
    }

    // Function to update the impact marker on the globe using Three.js objects
    function updateImpactMarker(latitude, longitude, diameter = null) {
        if (!globe) return;
        
        // Get current diameter from slider if not provided
        if (diameter === null) {
            const diameterSlider = document.getElementById('diameter');
            diameter = diameterSlider ? parseFloat(diameterSlider.value) || 100 : 100;
        }
        
        try {
            // Clear existing marker first
            clearImpactMarker();
            
            // Get the globe's scene to add custom 3D objects
            const scene = (globe.scene && globe.scene()) || globe._scene;
            if (!scene) {
                console.warn('Could not access globe scene for marker');
                return;
            }
            
            // Get globe radius and convert coordinates to 3D position
            const globeRadius = globe.getGlobeRadius ? globe.getGlobeRadius() : 100;
            
            // Calculate scale factor based on diameter (logarithmic scaling for better visual range)
            // Small asteroids (10m): scale = 0.5, Large asteroids (1000m): scale = 2.0
            const minDiameter = 10;   // 10 meters
            const maxDiameter = 1000; // 1000 meters
            const minScale = 0.5;
            const maxScale = 3.0;
            
            const normalizedDiameter = Math.max(minDiameter, Math.min(maxDiameter, diameter));
            const logScale = (Math.log(normalizedDiameter) - Math.log(minDiameter)) / (Math.log(maxDiameter) - Math.log(minDiameter));
            const scaleFactor = minScale + (maxScale - minScale) * logScale;
            
            const coords = globe.getCoords(latitude, longitude, 0.015 * scaleFactor); // Scale height with marker
            
            if (!coords) {
                console.warn('Could not get coordinates for marker position');
                return;
            }
            
            // Create a Google Maps-style red pin marker
            const markerGroup = new THREE.Group();
            
            // Pin head (rounded top part) - scaled by diameter
            const headGeometry = new THREE.SphereGeometry(globeRadius * 0.008 * scaleFactor, 12, 8);
            const pinMaterial = new THREE.MeshBasicMaterial({ 
                color: 0xff0000, // Red color
                transparent: true, 
                opacity: 0.9
            });
            const head = new THREE.Mesh(headGeometry, pinMaterial);
            head.position.y = globeRadius * 0.004 * scaleFactor; // Lift the head up (scaled)
            markerGroup.add(head);
            
            // Pin point (cone pointing down) - scaled by diameter
            const pointGeometry = new THREE.ConeGeometry(globeRadius * 0.003 * scaleFactor, globeRadius * 0.012 * scaleFactor, 8);
            const point = new THREE.Mesh(pointGeometry, pinMaterial);
            point.position.y = -globeRadius * 0.002 * scaleFactor; // Position below the head (scaled)
            point.rotateX(Math.PI); // Point downward
            markerGroup.add(point);
            
            // Small white center dot on the pin head for better visibility - scaled
            const dotGeometry = new THREE.SphereGeometry(globeRadius * 0.003 * scaleFactor, 8, 6);
            const dotMaterial = new THREE.MeshBasicMaterial({ 
                color: 0xffffff, // White center
                transparent: true, 
                opacity: 0.9
            });
            const dot = new THREE.Mesh(dotGeometry, dotMaterial);
            dot.position.y = globeRadius * 0.004 * scaleFactor; // Same height as head (scaled)
            markerGroup.add(dot);
            
            // Position the marker at the coordinates
            markerGroup.position.copy(coords);
            
            // Orient the pin to point toward the globe center (surface normal)
            const surfaceNormal = coords.clone().normalize();
            markerGroup.lookAt(markerGroup.position.clone().add(surfaceNormal));
            
            // Store marker data for future reference
            markerGroup.userData = {
                type: 'impactMarker',
                latitude: latitude,
                longitude: longitude,
                diameter: diameter,
                scaleFactor: scaleFactor,
                originalScale: markerGroup.scale.clone()
            };
            
            // Add to scene
            scene.add(markerGroup);
            
            // Store reference
            impactMarker = markerGroup;
            
            console.log('3D Impact marker created at:', { 
                lat: latitude, 
                lon: longitude, 
                diameter: diameter + 'm', 
                scaleFactor: scaleFactor.toFixed(2) 
            });
            
        } catch (error) {
            console.warn('Failed to create 3D impact marker:', error);
            
            // Fallback to simple pointsData approach
            try {
                // Scale fallback marker size based on diameter too
                const fallbackScale = Math.max(2, Math.min(8, 2 + (diameter / 200))); // 2-8 range
                
                const markerData = [{
                    lat: latitude,
                    lng: longitude,
                    label: `📍 Impact Target (${diameter}m)`,
                    color: '#ff0000', // Red to match the 3D pin
                    size: fallbackScale
                }];
                
                globe.pointsData(markerData)
                    .pointLat('lat')
                    .pointLng('lng')
                    .pointColor('color')
                    .pointRadius('size')
                    .pointAltitude(0.01)
                    .pointLabel('label');
                    
                impactMarker = { lat: latitude, lng: longitude, fallback: true };
                console.log('Using fallback pointsData marker');
            } catch (fallbackError) {
                console.warn('Fallback marker also failed:', fallbackError);
            }
        }
    }

    // Function to clear the impact marker
    function clearImpactMarker() {
        if (!globe || !impactMarker) return;
        
        try {
            if (impactMarker.fallback) {
                // Clear pointsData fallback
                globe.pointsData([]);
            } else {
                // Remove 3D object from scene
                const scene = (globe.scene && globe.scene()) || globe._scene;
                if (scene && impactMarker.parent) {
                    scene.remove(impactMarker);
                }
            }
            
            impactMarker = null;
            console.log('Impact marker cleared');
        } catch (error) {
            console.warn('Failed to clear impact marker:', error);
        }
    }

    // Set up event listeners
    function setupEventListeners() {
        // Mitigation strategy selection
        document.getElementById('mitigation-strategy')?.addEventListener('change', (e) => {
            document.querySelectorAll('.mitigation-params').forEach(el => el.style.display = 'none');
            document.getElementById(`${e.target.value}-params`).style.display = 'block';
        });
        
        // Mitigation parameter updates
        ['impactor-mass', 'impactor-velocity', 'spacecraft-mass', 'hover-distance', 'duration', 'yield', 'standoff'].forEach(id => {
            const element = document.getElementById(id);
            if (element) {
                element.addEventListener('input', () => {
                    document.getElementById(`${id}-value`).textContent = element.value;
                });
            }
        });

        // Live updates for main simulator sliders (diameter, speed, angle)
        ['diameter', 'speed', 'angle'].forEach(id => {
            const el = document.getElementById(id);
            if (!el) return;
            const update = () => {
                const val = parseFloat(el.value);
                if (id === 'diameter') {
                    const disp = val >= 1000 ? (val / 1000).toFixed(1) + ' km' : val.toFixed(1) + ' m';
                    const target = document.getElementById('diameter-value');
                    if (target) target.textContent = disp;
                    
                    // Update marker size in real-time if marker exists
                    if (impactMarker && typeof lat === 'number' && typeof lon === 'number') {
                        updateImpactMarker(lat, lon, val);
                    }
                } else if (id === 'speed') {
                    const target = document.getElementById('speed-value');
                    if (target) target.textContent = val.toFixed(1) + ' km/s';
                } else if (id === 'angle') {
                    const target = document.getElementById('angle-value');
                    if (target) target.textContent = val.toFixed(1) + '°';
                }
            };
            el.addEventListener('input', update);
            // also initialize once
            update();
        });

        // Initialize any custom select controls (replaces native dropdown visuals)
        try { initCustomSelects(); } catch (e) { console.warn('Custom selects init failed:', e && e.message); }
    }

    // Custom select replacement: builds a styled dropdown UI and keeps the original <select> in sync
    function initCustomSelects() {
        document.querySelectorAll('.custom-select').forEach(wrapper => {
            const select = wrapper.querySelector('select');
            const display = wrapper.querySelector('.custom-select-display');
            const list = wrapper.querySelector('.custom-select-list');
            if (!select || !display || !list) return;

            // Hide original native select visually but keep it in the DOM for form/state
            select.style.position = 'absolute';
            select.style.left = '-9999px';

            // Placeholder handling for specific selects
            const placeholders = {
                'mitigation-strategy': 'Select Method',
                'material': 'Select material'
            };
            const key = wrapper.getAttribute('data-for');
            const placeholder = placeholders[key] || null;

            // Populate custom list
            list.innerHTML = '';
            Array.from(select.options).forEach((opt, idx) => {
                const item = document.createElement('div');
                item.className = 'custom-select-item';
                item.setAttribute('role', 'option');
                item.dataset.value = opt.value;
                item.textContent = opt.textContent;
                if (opt.selected) item.classList.add('selected');
                item.addEventListener('click', () => {
                    // select this value
                    select.value = opt.value;
                    // update selected classes
                    list.querySelectorAll('.custom-select-item').forEach(i => i.classList.remove('selected'));
                    item.classList.add('selected');
                    // update display
                    display.textContent = opt.textContent;
                    display.classList.remove('placeholder');
                    // close list
                    list.setAttribute('aria-hidden', 'true');
                    list.style.display = 'none';
                    // trigger change event on the original select for existing listeners
                    select.dispatchEvent(new Event('change', { bubbles: true }));
                });
                list.appendChild(item);
            });

            // set initial display
            // If a placeholder is defined, start with no selection so the placeholder is shown
            if (placeholder) {
                // clear selection so the placeholder is displayed
                try { select.selectedIndex = -1; } catch (e) { /* ignore */ }
                display.textContent = placeholder;
                display.classList.add('placeholder');
            } else {
                const selected = select.options[select.selectedIndex];
                display.textContent = selected ? selected.textContent : (select.options[0] && select.options[0].textContent);
                display.classList.remove('placeholder');
            }

            // Toggle list on click/focus
            const toggleList = () => {
                const open = list.getAttribute('aria-hidden') === 'false';
                if (open) {
                    list.setAttribute('aria-hidden', 'true'); list.style.display = 'none';
                } else {
                    list.setAttribute('aria-hidden', 'false'); list.style.display = 'block';
                }
            };

            display.addEventListener('click', toggleList);
            display.addEventListener('keydown', (ev) => {
                if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggleList(); }
                if (ev.key === 'ArrowDown') { ev.preventDefault(); list.firstChild && list.firstChild.focus(); }
            });

            // Close when clicking outside
            document.addEventListener('click', (ev) => {
                if (!wrapper.contains(ev.target)) { list.setAttribute('aria-hidden', 'true'); list.style.display = 'none'; }
            });
        });
    }

    // Load NEO data into simulator
    window.loadNEO = function(name, diameter, velocity) {
        document.getElementById('diameter').value = diameter;
        document.getElementById('diameter-value').textContent = diameter.toFixed(1) + ' m';
        document.getElementById('speed').value = velocity;
        document.getElementById('speed-value').textContent = parseFloat(velocity).toFixed(1) + ' km/s';
    };

    // Update impact visualization

    async function calculateImpact(radius, density, speed, angle, lat, lon) {
        // Initial calculations
        const mass = (4/3) * Math.PI * Math.pow(radius, 3) * density;
        const initialVelocity = speed * 1000; // Convert to m/s
        
        // Get environmental data
        let elevation = 0;
        let isCoastal = false;
        let recentSeismicActivity = [];

        const hasValidCoords = typeof lat === 'number' && typeof lon === 'number' && isFinite(lat) && isFinite(lon);
        if (hasValidCoords) {
            try {
                elevation = await getElevation(lat, lon);
            } catch (err) {
                console.warn('Elevation lookup failed, defaulting to 0:', err && err.message);
                elevation = 0;
            }

            try {
                isCoastal = await checkTsunamiRisk(lat, lon);
            } catch (err) {
                console.warn('Tsunami risk check failed, defaulting to false:', err && err.message);
                isCoastal = false;
            }

            try {
                recentSeismicActivity = await getSeismicActivity(lat, lon);
            } catch (err) {
                console.warn('Seismic activity lookup failed, defaulting to empty array:', err && err.message);
                recentSeismicActivity = [];
            }
        } else {
            elevation = 0;
            isCoastal = false;
            recentSeismicActivity = [];
        }
        
        // Calculate atmospheric entry effects
        const finalVelocity = initialVelocity * Math.pow(0.7, Math.cos(angle * Math.PI / 180));
        const impactEnergy = 0.5 * mass * Math.pow(finalVelocity, 2);
        
        // Convert to TNT equivalent for easy comparison
        const tntEquivalent = impactEnergy / 4.184e9;
        
        // Calculate crater size with environmental adjustments
        const terrainMultiplier = elevation < 0 ? 0.8 : (elevation > 2000 ? 1.2 : 1.0);
        const craterDiameter = Math.pow(impactEnergy / 1e15, 0.26) * 1000 * terrainMultiplier;
        
        // Calculate blast and shockwave effects
        const blastRadius = Math.pow(impactEnergy / 4.184e12, 0.33) * 1000;
        const shockwaveRadius = blastRadius * 2.5;
        
        // Calculate seismic magnitude (Richter scale)
        const seismicMagnitude = 0.67 * (Math.log10(tntEquivalent) - 0.645);
        
        // Calculate tsunami wave height if coastal
        const tsunamiHeight = isCoastal ? Math.pow(impactEnergy / 1e15, 0.25) * 10 : 0;
        
        return {
            energy: impactEnergy,
            craterDiameter,
            blastRadius,
            shockwaveRadius,
            tntEquivalent,
            seismicMagnitude,
            tsunamiHeight,
            elevation,
            isCoastal,
            recentSeismicActivity
        };
    }

    async function createImpact(coords) {
        // Validate coords (should be [lon, lat])
        if (!coords || !Array.isArray(coords) || coords.length < 2 || isNaN(coords[0]) || isNaN(coords[1])) {
            console.warn('Invalid coordinates for impact:', coords);
            return;
        }

        const diameter = parseFloat(document.getElementById('diameter').value) || 0;
        const radius = diameter / 2;
        const density = parseFloat(document.getElementById('material').value) || 3000;
        const speed = parseFloat(document.getElementById('speed').value) || 20;
        const angle = parseFloat(document.getElementById('angle').value) || 45;

        // Extract lat/lon properly for environmental queries
        const lon = coords[0];
        const lat = coords[1];

        // Await the async calculation which uses elevation and seismic helpers
        console.log('createImpact: coords', { lat, lon, diameter, radius, density, speed, angle });
        const impact = await calculateImpact(radius, density, speed, angle, lat, lon);

        // Defensive checks on returned impact data
        if (!impact || typeof impact.craterDiameter !== 'number' || typeof impact.blastRadius !== 'number') {
            console.error('Invalid impact data:', impact);
            return;
        }

        const craterRadiusKm = impact.craterDiameter / 2 / 1000;
        const blastRadiusKm = impact.blastRadius / 1000;

        const blastColor = (alpha) => `rgba(255, 152, 0, ${alpha})`;
        const craterColor = (alpha) => `rgba(255, 23, 68, ${alpha})`;
        const impactLayers = [
            { lat: lat, lng: lon, maxR: Number(blastRadiusKm) || 0.1, color: (t) => blastColor(1-t), propagationSpeed: 10, period: 400},
            { lat: lat, lng: lon, maxR: Number(craterRadiusKm) || 0.05, color: (t) => craterColor(1-t), propagationSpeed: 0.5, period: 50},
        ]
        console.log('createImpact: applying layers', { lat, lon, impactLayers });

        // Update globe layers
        try {
            if (typeof globe.ringsData === 'function') {
                globe
                    .ringColor('color')
                    .ringMaxRadius('maxR')
                    .ringPropagationSpeed('propagationSpeed')
                    .ringRepeatPeriod('period')
                    .ringsData(impactLayers);
            } else {
                // Fallback: attempt to use customLayerData with our ring/disk shapes
                globe.customLayerData(impactLayers.map(l => ({ lat: l.lat, lng: l.lng, radius: l.maxR, color: l.color, alt: 0.02, shape: 'ring', opacity: 0.5 })));
            }
        } catch (e) {
            console.warn('Failed to set ringsData; falling back to customLayerData:', e && e.message);
            globe.customLayerData(impactLayers.map(l => ({ lat: l.lat, lng: l.lng, radius: l.maxR, color: l.color, alt: 0.02, shape: 'ring', opacity: 0.5 })));
        }

        // No point markers — visualization uses flat rings/disks via customLayerData only

        // Add 3D explosion effect based on impact energy
        try {
            createImpactExplosion(lat, lon, impact.energy);
        } catch (e) {
            console.warn('Could not create impact explosion:', e && e.message);
        }

        updateImpactInfo(impact);
        showImpactDisplay();
        // Also compute and show the impact facts overlay (population, casualties, cost, etc.)
        try { showImpactFacts(lat, lon, impact); } catch (e) { console.warn('Could not show impact facts:', e && e.message); }
    }

    // Create 3D explosion effect at impact location based on crater size
    function createImpactExplosion(lat, lon, impactEnergy) {
        try {
            if (!globe) return;

            const scene = (globe.scene && globe.scene()) || globe._scene || null;
            if (!scene) return;

            // Calculate crater diameter to base explosion size on
            const diameter = parseFloat(document.getElementById('diameter')?.value) || 25;
            const density = parseFloat(document.getElementById('material')?.value) || 3000;
            const speed = parseFloat(document.getElementById('speed')?.value) || 20;
            const mass = (4/3) * Math.PI * Math.pow(diameter/2, 3) * density;
            const finalVelocity = Math.sqrt(Math.pow(speed * 1000, 2) + Math.pow(11200, 2));
            const craterDiameter = Math.pow(impactEnergy / 1e15, 0.26) * 1000; // meters
            
            // Make explosion 1.2x the size of the crater
            const explosionDiameter = craterDiameter * 1.2; // meters
            const globeRadiusUnits = (globe.getGlobeRadius ? globe.getGlobeRadius() : 100);
            const earthRadiusMeters = 6371000; // Earth radius in meters
            const baseScale = (explosionDiameter / earthRadiusMeters) * globeRadiusUnits * 50; // Scale to globe units

            // Get impact position on Earth's surface
            const impactPos = globe.getCoords(lat, lon, 0.01); // Slightly above surface

            // Calculate direction toward center of Earth for proper orientation
            const earthCenter = new THREE.Vector3(0, 0, 0);
            const upDirection = new THREE.Vector3().copy(impactPos).normalize();

            // Create multiple explosion spheres (smaller than nuclear version)
            const explosionSpheres = [];
            
            // Core impact explosion sphere (bright white/yellow)
            const coreSize = globeRadiusUnits * 0.020 * baseScale;
            const coreGeometry = new THREE.SphereGeometry(coreSize, 12, 8);
            const coreMaterial = new THREE.MeshBasicMaterial({ 
                color: 0xffff88, 
                transparent: true, 
                opacity: 1.0 
            });
            const coreExplosion = new THREE.Mesh(coreGeometry, coreMaterial);
            coreExplosion.position.copy(impactPos);
            // Orient sphere toward Earth center
            coreExplosion.lookAt(earthCenter);
            scene.add(coreExplosion);
            explosionSpheres.push({ mesh: coreExplosion, baseScale: 1, growthRate: 0.12 });
            
            // Secondary explosion sphere (orange)
            const secondarySize = globeRadiusUnits * 0.035 * baseScale;
            const secondaryGeometry = new THREE.SphereGeometry(secondarySize, 10, 6);
            const secondaryMaterial = new THREE.MeshBasicMaterial({ 
                color: 0xff8800, 
                transparent: true, 
                opacity: 0.7 
            });
            const secondaryExplosion = new THREE.Mesh(secondaryGeometry, secondaryMaterial);
            secondaryExplosion.position.copy(impactPos);
            secondaryExplosion.lookAt(earthCenter);
            scene.add(secondaryExplosion);
            explosionSpheres.push({ mesh: secondaryExplosion, baseScale: 0.9, growthRate: 0.10 });
            
            // Outer explosion sphere (red-orange)
            const outerSize = globeRadiusUnits * 0.050 * baseScale;
            const outerGeometry = new THREE.SphereGeometry(outerSize, 10, 6);
            const outerMaterial = new THREE.MeshBasicMaterial({ 
                color: 0xff4400, 
                transparent: true, 
                opacity: 0.5 
            });
            const outerExplosion = new THREE.Mesh(outerGeometry, outerMaterial);
            outerExplosion.position.copy(impactPos);
            outerExplosion.lookAt(earthCenter);
            scene.add(outerExplosion);
            explosionSpheres.push({ mesh: outerExplosion, baseScale: 1.1, growthRate: 0.08 });

            // Heat/debris cloud sphere (very transparent)
            const heatSize = globeRadiusUnits * 0.065 * baseScale;
            const heatGeometry = new THREE.SphereGeometry(heatSize, 6, 4);
            const heatMaterial = new THREE.MeshBasicMaterial({ 
                color: 0xaa2200, 
                transparent: true, 
                opacity: 0.3 
            });
            const heatExplosion = new THREE.Mesh(heatGeometry, heatMaterial);
            heatExplosion.position.copy(impactPos);
            heatExplosion.lookAt(earthCenter);
            scene.add(heatExplosion);
            explosionSpheres.push({ mesh: heatExplosion, baseScale: 1.3, growthRate: 0.06 });

            // Animate explosion
            const duration = 3000; // 3 seconds
            const startTime = performance.now();

            function animateExplosion(now) {
                const t = Math.min(1, (now - startTime) / duration);
                const fadeStart = 0.4; // Start fading at 40% through animation

                explosionSpheres.forEach((sphere, index) => {
                    // Growth animation
                    const growthFactor = 1 + (t * sphere.growthRate * 10);
                    sphere.mesh.scale.set(
                        sphere.baseScale * growthFactor,
                        sphere.baseScale * growthFactor,
                        sphere.baseScale * growthFactor
                    );

                    // Fade out after fadeStart
                    if (t > fadeStart) {
                        const fadeProgress = (t - fadeStart) / (1 - fadeStart);
                        const currentOpacity = sphere.mesh.material.opacity;
                        const baseOpacity = index === 0 ? 1.0 : (index === 1 ? 0.7 : (index === 2 ? 0.5 : 0.3));
                        sphere.mesh.material.opacity = baseOpacity * (1 - fadeProgress);
                    }

                    // Ensure spheres face Earth center throughout animation
                    sphere.mesh.lookAt(earthCenter);
                });

                if (t < 1) {
                    requestAnimationFrame(animateExplosion);
                } else {
                    // Clean up explosion objects
                    explosionSpheres.forEach(sphere => {
                        scene.remove(sphere.mesh);
                    });
                }
            }

            requestAnimationFrame(animateExplosion);

        } catch (err) {
            console.warn('Impact explosion animation failed:', err && err.message);
        }
    }

    // Create reusable meteor trail system
    function createMeteorTrail(meteorMesh, scene, startPosition) {
        try {
            const trailLength = 200;
            const trailGeom = new THREE.BufferGeometry();
            const trailPositions = new Float32Array(trailLength * 3);
            
            // Initialize all trail positions to start position
            for (let i = 0; i < trailLength; i++) {
                trailPositions[i*3 + 0] = startPosition.x;
                trailPositions[i*3 + 1] = startPosition.y;
                trailPositions[i*3 + 2] = startPosition.z;
            }
            
            trailGeom.setAttribute('position', new THREE.BufferAttribute(trailPositions, 3));
            const trailMat = new THREE.PointsMaterial({ 
                color: 0xffcc66, 
                size: 8, 
                sizeAttenuation: true, 
                transparent: true, 
                opacity: 0.95, 
                depthWrite: false, 
                blending: THREE.AdditiveBlending 
            });
            const trail = new THREE.Points(trailGeom, trailMat);
            
            // Add trail to scene
            if (scene && scene.add) {
                scene.add(trail);
            }
            
            return {
                trail: trail,
                update: function(meteorPosition) {
                    try {
                        // Update trail positions (simple tail behind meteor)
                        const positions = trail.geometry.attributes.position.array;
                        // Shift older positions down the buffer
                        for (let i = positions.length - 3; i >= 3; i--) {
                            positions[i] = positions[i - 3];
                        }
                        // Write current meteor position into head
                        positions[0] = meteorPosition.x;
                        positions[1] = meteorPosition.y;
                        positions[2] = meteorPosition.z;
                        trail.geometry.attributes.position.needsUpdate = true;
                    } catch (e) {
                        console.warn('Trail update failed:', e && e.message);
                    }
                },
                dispose: function() {
                    try {
                        if (scene && scene.remove && trail) {
                            scene.remove(trail);
                        }
                        if (trail && trail.geometry) {
                            trail.geometry.dispose();
                        }
                        if (trail && trail.material) {
                            trail.material.dispose();
                        }
                    } catch (e) {
                        console.warn('Trail disposal failed:', e && e.message);
                    }
                }
            };
        } catch (err) {
            console.warn('Trail creation failed:', err && err.message);
            return {
                trail: null,
                update: function() {},
                dispose: function() {}
            };
        }
    }

    // Start simulation using the last-selected coordinates (exposed to UI)
    window.startSimulation = function() {
        if (typeof lat !== 'number' || typeof lon !== 'number' || isNaN(lat) || isNaN(lon)) {
            console.warn('No impact location selected. Click on the globe to pick a location first.');
            alert('Please click on the globe to select an impact location before starting the simulation.');
            return;
        }
        
        // Clear the impact marker when simulation starts
        clearImpactMarker();
        
    console.log('startSimulation: running impact at', { lat, lon });
    
    // Check mitigation strategy selection
    const mitigationStrategy = document.getElementById('mitigation-strategy')?.value;
    
    if (mitigationStrategy === 'kinetic') {
        // Show kinetic impact mitigation animation
        animateKineticMitigation(lat, lon).then((success) => {
            if (success) {
                // Mitigation successful - show deflected meteor or reduced impact
                const instr = document.querySelector('.instruction');
                if (instr) instr.textContent = 'Kinetic impactor successful! Asteroid deflected.';
                // Hide impact facts since mitigation was successful
                hideImpactFacts();
                // Show reduced impact or miss
                createReducedImpact([lon, lat]);
            } else {
                // Mitigation failed - impact effects already shown in animation
                const instr = document.querySelector('.instruction');
                if (instr) instr.textContent = 'Kinetic impactor failed! Asteroid impact occurred.';
                createImpact([lon, lat]);
            }
        });
    } else if (mitigationStrategy === 'nuclear') {
        // Show nuclear standoff mitigation animation
        animateNuclearMitigation(lat, lon).then((success) => {
            if (success) {
                // Mitigation successful - meteor vaporized
                const instr = document.querySelector('.instruction');
                if (instr) instr.textContent = 'Nuclear standoff successful! Asteroid vaporized.';
                // Hide impact facts since mitigation was successful
                hideImpactFacts();
                // No impact - meteor was destroyed
            } else {
                // Mitigation failed - impact effects already shown in animation
                const instr = document.querySelector('.instruction');
                if (instr) instr.textContent = 'Nuclear standoff failed! Asteroid impact occurred.';
                createImpact([lon, lat]);
            }
        });
    } else if (mitigationStrategy === 'gravity') {
        // Show gravity tractor mitigation animation
        animateGravityTractor(lat, lon).then((success) => {
            if (success) {
                // Mitigation successful - meteor deflected away from Earth
                const instr = document.querySelector('.instruction');
                if (instr) instr.textContent = 'Gravity tractor successful! Asteroid trajectory altered.';
                // Hide impact facts since mitigation was successful
                hideImpactFacts();
                // No impact - meteor deflected away
            } else {
                // Mitigation failed - impact effects already shown in animation
                const instr = document.querySelector('.instruction');
                if (instr) instr.textContent = 'Gravity tractor failed! Asteroid impact occurred.';
                createImpact([lon, lat]);
            }
        });
    } else if (mitigationStrategy === 'none') {
        // No mitigation - direct impact with clear message
        const instr = document.querySelector('.instruction');
        if (instr) instr.textContent = 'No mitigation deployed. Asteroid impact imminent!';
        animateMeteorTo(lat, lon).then(() => createImpact([lon, lat]));
    } else {
        // Default case - normal meteor animation
        animateMeteorTo(lat, lon).then(() => createImpact([lon, lat]));
    }
        try {
            const instr = document.querySelector('.instruction');
            if (instr) instr.textContent = 'Simulation running...';
        } catch (e) {}
    };

    // Animate a meteor (a simple 3D sphere with emissive material) from space down to the target lat/lon.
    // Returns a Promise resolved when the meteor reaches the surface.
    function animateMeteorTo(targetLat, targetLng) {
        return new Promise((resolve) => {
            try {
                if (!globe) return resolve();

                // Compute start and end positions in globe units
                const surfacePos = globe.getCoords(targetLat, targetLng, 0.0);
                // Start position: a point above the surface along the surface normal
                const globeRadiusUnits = (globe.getGlobeRadius ? globe.getGlobeRadius() : 100);
                const startAlt = globeRadiusUnits * 3.0; // start 3x globe radius away (far above)
                const startPos = globe.getCoords(targetLat, targetLng, startAlt / globeRadiusUnits);

                // Create meteor as a single circular sprite so it behaves as one circle that scales with diameter
                const diameterVal = parseFloat(document.getElementById('diameter')?.value) || 25;
                // Create a canvas texture for a soft orange circle (gives an emissive look without lights)
                const createMeteorTexture = () => {
                    const size = 256;
                    const canvas = document.createElement('canvas');
                    canvas.width = size; canvas.height = size;
                    const ctx = canvas.getContext('2d');
                    // Draw radial gradient circle
                    const grad = ctx.createRadialGradient(size/2, size/2, size*0.05, size/2, size/2, size*0.5);
                    grad.addColorStop(0, 'rgba(255, 170, 100, 1)');
                    grad.addColorStop(0.4, 'rgba(255, 120, 50, 0.9)');
                    grad.addColorStop(1, 'rgba(0,0,0,0)');
                    ctx.fillStyle = grad;
                    ctx.beginPath();
                    ctx.arc(size/2, size/2, size/2, 0, Math.PI*2);
                    ctx.fill();
                    const tex = new THREE.CanvasTexture(canvas);
                    tex.needsUpdate = true;
                    return tex;
                };

                const meteorTexture = createMeteorTexture();
                const meteorMat = new THREE.SpriteMaterial({ map: meteorTexture, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
                const meteor = new THREE.Sprite(meteorMat);
                // Map diameter (meters) to sprite scale in scene units (tunable mapping)
                const initialMeteorScale = Math.max(0.6, diameterVal / 30); // scene-scale scalar
                meteor.scale.set(initialMeteorScale, initialMeteorScale, 1);
                if (meteor.position && typeof meteor.position.copy === 'function') meteor.position.copy(startPos);
                else Object.assign(meteor.position, startPos);

                // Add a simple trail using Points (small hack) or a sprite
                // Trail: prefill positions with the start position so the trail is visible immediately
                const trailLength = 200;
                const trailGeom = new THREE.BufferGeometry();
                const trailPositions = new Float32Array(trailLength * 3);
                for (let i = 0; i < trailLength; i++) {
                    trailPositions[i*3 + 0] = startPos.x;
                    trailPositions[i*3 + 1] = startPos.y;
                    trailPositions[i*3 + 2] = startPos.z;
                }
                trailGeom.setAttribute('position', new THREE.BufferAttribute(trailPositions, 3));
                const trailMat = new THREE.PointsMaterial({ color: 0xffcc66, size: 8, sizeAttenuation: true, transparent: true, opacity: 0.95, depthWrite: false, blending: THREE.AdditiveBlending });
                const trail = new THREE.Points(trailGeom, trailMat);

                // Add to scene via globe.scene() if available, else add to globe._scene
                const scene = (globe.scene && globe.scene()) || globe._scene || null;
                if (scene && scene.add) {
                    try { scene.add(meteor); } catch (e) { console.warn('Could not add meteor to scene:', e && e.message); }
                    try { scene.add(trail); } catch (e) { console.warn('Could not add trail to scene:', e && e.message); }
                }

                // Create a yellow dashed path line from startPos to surfacePos to indicate the trajectory.
                let pathLine = null;
                try {
                    const lineGeom = new THREE.BufferGeometry().setFromPoints([startPos, surfacePos]);
                    // LineDashedMaterial requires computeLineDistances to be called on the geometry
                    const lineMat = new THREE.LineDashedMaterial({ color: 0xFFFF66, dashSize: startPos.distanceTo(surfacePos) * 0.02, gapSize: startPos.distanceTo(surfacePos) * 0.02, linewidth: 2, transparent: true, opacity: 0.95 });
                    lineGeom.computeLineDistances && lineGeom.computeLineDistances();
                    pathLine = new THREE.Line(lineGeom, lineMat);
                    // Slightly offset the line outward from the globe surface so it doesn't z-fight
                    pathLine.renderOrder = 999;
                    scene.add(pathLine);
                } catch (e) {
                    console.warn('Could not create path line:', e && e.message);
                    pathLine = null;
                }

                // Create minor flame sprites off the sides of the meteor for special effects
                const flames = [];
                // baseFlameScale needs to be in outer scope so the animation frame can pulse it
                let baseFlameScale = Math.max(0.6, initialMeteorScale * 0.8);
                try {
                    // Travel direction (normalized)
                    const travelDir = new THREE.Vector3().subVectors(surfacePos, startPos).normalize();
                    // Choose an arbitrary up vector and compute a side vector perpendicular to travelDir
                    const up = new THREE.Vector3(0, 1, 0);
                    let side = new THREE.Vector3().crossVectors(travelDir, up);
                    if (side.lengthSq() < 1e-6) side = new THREE.Vector3(1, 0, 0); // fallback
                    side.normalize();

                    const flameMat = new THREE.SpriteMaterial({ color: 0xffaa33, blending: THREE.AdditiveBlending, transparent: true, opacity: 0.9, depthWrite: false });
                    const flameMat2 = new THREE.SpriteMaterial({ color: 0xffdd66, blending: THREE.AdditiveBlending, transparent: true, opacity: 0.6, depthWrite: false });

                    // Two small flames, left and right
                    const flameLeft = new THREE.Sprite(flameMat);
                    const flameRight = new THREE.Sprite(flameMat2);
                    const flameOffset = Math.max(0.6, initialMeteorScale * 0.6);
                    flameLeft.position.copy ? flameLeft.position.copy(meteor.position) : Object.assign(flameLeft.position, meteor.position);
                    flameRight.position.copy ? flameRight.position.copy(meteor.position) : Object.assign(flameRight.position, meteor.position);
                    flameLeft.position.add(side.clone().multiplyScalar(flameOffset));
                    flameRight.position.add(side.clone().multiplyScalar(-flameOffset));
                    // Initial scales
                    flameLeft.scale.set(baseFlameScale, baseFlameScale, 1);
                    flameRight.scale.set(baseFlameScale * 0.7, baseFlameScale * 0.7, 1);

                    scene.add(flameLeft);
                    scene.add(flameRight);
                    flames.push(flameLeft, flameRight);
                } catch (e) {
                    console.warn('Could not create flame sprites:', e && e.message);
                }

                const duration = 1500 + Math.min(3500, (parseFloat(document.getElementById('speed')?.value)||20) * 20); // ms based on speed
                const startTime = performance.now();

                function frame(now) {
                    const t = Math.min(1, (now - startTime) / duration);
                    // easeInQuad for descent
                    const ease = t * t;
                    // Interpolate position
                    const pos = new THREE.Vector3().lerpVectors(startPos, surfacePos, ease);
                    meteor.position.copy ? meteor.position.copy(pos) : Object.assign(meteor.position, pos);

                    // Update meteor orientation to face travel direction
                    const lookAt = new THREE.Vector3().subVectors(surfacePos, startPos).normalize();
                    meteor.lookAt(pos.x + lookAt.x, pos.y + lookAt.y, pos.z + lookAt.z);

                    // Update trail positions (simple tail behind meteor)
                    const positions = trail.geometry.attributes.position.array;
                    // shift older positions down the buffer
                    for (let i = positions.length - 3; i >= 3; i--) positions[i] = positions[i - 3];
                    // write current meteor position into head
                    positions[0] = meteor.position.x; positions[1] = meteor.position.y; positions[2] = meteor.position.z;
                    trail.geometry.attributes.position.needsUpdate = true;

                    // Slight glow scale-up while preserving the initial size mapping
                    meteor.scale.setScalar(initialMeteorScale * (1 + 0.5 * ease));

                    // Animate path dash offset so it appears to flow toward the surface
                    try {
                        if (pathLine && pathLine.material) {
                            pathLine.material.dashOffset = -ease * 5.0; // animate dash offset
                            pathLine.material.needsUpdate = true;
                        }
                    } catch (e) {}

                    // Update flame positions to track the meteor and pulse them for effect
                    try {
                        for (let i = 0; i < flames.length; i++) {
                            const f = flames[i];
                            // Keep flames offset relative to meteor travel side vector
                            const travelDir = new THREE.Vector3().subVectors(surfacePos, startPos).normalize();
                            const up = new THREE.Vector3(0,1,0);
                            let side = new THREE.Vector3().crossVectors(travelDir, up);
                            if (side.lengthSq() < 1e-6) side = new THREE.Vector3(1,0,0);
                            side.normalize();
                            const offsetSign = (i % 2 === 0) ? 1 : -1;
                            const flameOffset = Math.max(0.6, initialMeteorScale * 0.6);
                            f.position.copy ? f.position.copy(meteor.position) : Object.assign(f.position, meteor.position);
                            f.position.add(side.clone().multiplyScalar(flameOffset * offsetSign));
                            // Pulse size and opacity
                            const pulse = 1 + 0.25 * Math.sin(ease * Math.PI * 6 + i);
                            f.scale.set(baseFlameScale * pulse * (i===0?1:0.85), baseFlameScale * pulse * (i===0?1:0.85), 1);
                            f.material.opacity = 0.6 + 0.4 * (1 - ease) * (0.7 + 0.3 * Math.abs(Math.sin(ease * Math.PI * 6 + i)));
                            f.material.needsUpdate = true;
                        }
                    } catch (e) {}

                    if (t < 1) requestAnimationFrame(frame); else {
                        // Impact reached: remove meteor/trail/path/flames from scene and resolve
                        try {
                            scene.remove(meteor);
                            scene.remove(trail);
                            if (pathLine) scene.remove(pathLine);
                            flames.forEach(f => scene.remove(f));
                        } catch (e) {}
                        resolve();
                    }
                }

                requestAnimationFrame(frame);
            } catch (err) {
                console.warn('Meteor animation failed, continuing to impact:', err && err.message);
                resolve();
            }
        });
    }

    // Animate kinetic impactor hitting the meteor and deflecting it
    function animateKineticMitigation(targetLat, targetLng) {
        return new Promise((resolve) => {
            try {
                if (!globe) return resolve(false);

                const scene = (globe.scene && globe.scene()) || globe._scene || null;
                if (!scene) return resolve(false);

                // Calculate positions
                const surfacePos = globe.getCoords(targetLat, targetLng, 0.0);
                const globeRadiusUnits = (globe.getGlobeRadius ? globe.getGlobeRadius() : 100);
                const interceptAlt = globeRadiusUnits * 1.5; // Intercept halfway down
                const interceptPos = globe.getCoords(targetLat, targetLng, interceptAlt / globeRadiusUnits);
                const meteorStartPos = globe.getCoords(targetLat, targetLng, 3.0);
                
                // Create meteor
                const diameterVal = parseFloat(document.getElementById('diameter')?.value) || 25;
                const meteorScale = Math.max(0.4, Math.log10(Math.max(diameterVal, 1)) * 0.6);
                
                const meteorGeometry = new THREE.SphereGeometry(globeRadiusUnits * 0.02 * meteorScale, 8, 6);
                const meteorMaterial = new THREE.MeshBasicMaterial({ 
                    color: 0xff6644, 
                    transparent: true, 
                    opacity: 0.9 
                });
                const meteor = new THREE.Mesh(meteorGeometry, meteorMaterial);
                meteor.position.copy(meteorStartPos);
                scene.add(meteor);
                
                // Create meteor trail
                const meteorTrail = createMeteorTrail(meteor, scene, meteorStartPos);
                
                // Create kinetic impactor (smaller, metallic)
                const impactorGeometry = new THREE.SphereGeometry(globeRadiusUnits * 0.008, 6, 4);
                const impactorMaterial = new THREE.MeshBasicMaterial({ 
                    color: 0x888888, 
                    transparent: true, 
                    opacity: 0.8 
                });
                const impactor = new THREE.Mesh(impactorGeometry, impactorMaterial);
                
                // Calculate launch site farther from the impact zone (offset by ~2000km on Earth's surface)
                const launchLatOffset = 18; // ~2000km offset in degrees for more curve
                const launchLonOffset = 18;
                const launchLat = Math.max(-85, Math.min(85, targetLat + launchLatOffset));
                const launchLon = targetLng + launchLonOffset;
                
                // Launch position starts on Earth's surface
                const launchPos = globe.getCoords(launchLat, launchLon, 0.0);
                impactor.position.copy(launchPos);
                scene.add(impactor);
                
                // Create launch site indicator
                const launchSiteGeometry = new THREE.RingGeometry(globeRadiusUnits * 0.01, globeRadiusUnits * 0.015, 8);
                const launchSiteMaterial = new THREE.MeshBasicMaterial({ 
                    color: 0x00ff00, 
                    transparent: true, 
                    opacity: 0.8,
                    side: THREE.DoubleSide
                });
                const launchSite = new THREE.Mesh(launchSiteGeometry, launchSiteMaterial);
                launchSite.position.copy(launchPos);
                launchSite.lookAt(0, 0, 0); // Face away from globe center
                scene.add(launchSite);
                
                // Create impactor trail
                const trailPoints = [];
                const maxTrailLength = 15;
                const trailGeometry = new THREE.BufferGeometry();
                const trailMaterial = new THREE.LineBasicMaterial({ 
                    color: 0x00ff88, 
                    transparent: true, 
                    opacity: 0.6,
                    linewidth: 2
                });
                const trailLine = new THREE.Line(trailGeometry, trailMaterial);
                scene.add(trailLine);
                
                // Calculate curved trajectory control points for realistic launch path (moderate arc)
                const midPoint1 = globe.getCoords(
                    targetLat + launchLatOffset * 0.7, 
                    targetLng + launchLonOffset * 0.7, 
                    1.0 // First arc point (reduced)
                );
                const midPoint2 = globe.getCoords(
                    targetLat + launchLatOffset * 0.3, 
                    targetLng + launchLonOffset * 0.3, 
                    1.3 // Higher arc point (reduced)
                );

                // Helper function to calculate cubic Bezier curve point
                function calculateBezierPoint(p0, p1, p2, p3, t) {
                    const u = 1 - t;
                    const tt = t * t;
                    const uu = u * u;
                    const uuu = uu * u;
                    const ttt = tt * t;
                    
                    // Cubic Bezier formula: B(t) = (1-t)³P₀ + 3(1-t)²tP₁ + 3(1-t)t²P₂ + t³P₃
                    const point = new THREE.Vector3();
                    point.addScaledVector(p0, uuu);              // (1-t)³P₀
                    point.addScaledVector(p1, 3 * uu * t);       // 3(1-t)²tP₁
                    point.addScaledVector(p2, 3 * u * tt);       // 3(1-t)t²P₂
                    point.addScaledVector(p3, ttt);              // t³P₃
                    
                    return point;
                }

                // Calculate physics-based kinetic effectiveness upfront
                const diameter = parseFloat(document.getElementById('diameter')?.value) || 25;
                const density = parseFloat(document.getElementById('material')?.value) || 3000;
                const radius = diameter / 2;
                const mass = (4/3) * Math.PI * Math.pow(radius, 3) * density;
                const speed = parseFloat(document.getElementById('speed')?.value) || 20;
                const finalVelocity = Math.sqrt(Math.pow(speed * 1000, 2) + Math.pow(11200, 2));
                const impactEnergy = 0.5 * mass * Math.pow(finalVelocity, 2);
                
                const effectiveness = calculateMitigationEffectiveness('kinetic', mass, impactEnergy, diameter);
                // Mitigation strategies are always effective - no random failure
                const willSucceed = true;

                const duration = 4000; // 4 seconds for the sequence (increased from 2.5s)
                const startTime = performance.now();
                
                let impactOccurred = false;
                let meteorDeflected = false;
                const deflectionDirection = new THREE.Vector3(1, 0.5, 0.3).normalize(); // Deflection vector

                function frame(now) {
                    const t = Math.min(1, (now - startTime) / duration);
                    
                    if (t < 0.75) {
                        // Phase 1: Meteor descends first, then impactor launches after delay
                        const meteorProgress = t / 0.75;
                        const meteorPos = new THREE.Vector3().lerpVectors(meteorStartPos, interceptPos, meteorProgress);
                        meteor.position.copy(meteorPos);
                        
                        // Update meteor trail
                        meteorTrail.update(meteor.position);
                        
                        // Impactor launches after 25% of the animation (1 second delay)
                        const impactorLaunchDelay = 0.25;
                        if (t >= impactorLaunchDelay) {
                            // Calculate impactor progress starting from launch time
                            const impactorProgress = (t - impactorLaunchDelay) / (0.75 - impactorLaunchDelay);
                            const impactorPos = calculateBezierPoint(
                                launchPos,    // Start: Launch site on Earth
                                midPoint1,    // Control point 1: Lower arc
                                midPoint2,    // Control point 2: Higher arc  
                                interceptPos, // End: Intercept point
                                Math.max(0, Math.min(1, impactorProgress)) // Clamp between 0-1
                            );
                            impactor.position.copy(impactorPos);
                        } else {
                            // Before launch: keep impactor at launch site
                            impactor.position.copy(launchPos);
                            
                            // Pre-launch warning effect (pulsing launch site)
                            const prelaunchWarning = 0.1; // Warning starts 0.1 before launch
                            if (t >= (impactorLaunchDelay - prelaunchWarning)) {
                                const warningProgress = (t - (impactorLaunchDelay - prelaunchWarning)) / prelaunchWarning;
                                const pulseFactor = 1 + 0.3 * Math.sin(warningProgress * Math.PI * 8); // Fast pulse
                                launchSite.scale.set(pulseFactor, pulseFactor, pulseFactor);
                                
                                // Change color to yellow during warning
                                launchSite.material.color.setHex(0xffff00);
                            } else {
                                launchSite.scale.set(1, 1, 1);
                                launchSite.material.color.setHex(0x00ff00); // Green when idle
                            }
                        }
                        // Update impactor trail (only after launch)
                        if (t >= impactorLaunchDelay) {
                            trailPoints.push(impactor.position.clone());
                            if (trailPoints.length > maxTrailLength) {
                                trailPoints.shift(); // Remove oldest point
                            }
                            
                            // Update trail geometry
                            if (trailPoints.length > 1) {
                                trailGeometry.setFromPoints(trailPoints);
                                trailGeometry.needsUpdate = true;
                            }
                        }
                        
                        // Add launch exhaust effect at launch time (after delay)
                        const launchEffectDuration = 0.15;
                        const launchEffectEnd = impactorLaunchDelay + launchEffectDuration;
                        if (t >= impactorLaunchDelay && t < launchEffectEnd) {
                            // Scale impactor slightly during launch
                            const launchProgress = (t - impactorLaunchDelay) / launchEffectDuration;
                            const launchScale = 1 + 0.5 * (1 - launchProgress);
                            impactor.scale.set(launchScale, launchScale, launchScale);
                            
                            // Launch site glow effect (first half of launch effect)
                            if (launchProgress < 0.5) {
                                try {
                                    const launchGlow = new THREE.Mesh(
                                        new THREE.SphereGeometry(globeRadiusUnits * 0.02, 8, 6),
                                        new THREE.MeshBasicMaterial({ 
                                            color: 0xff4400, 
                                            transparent: true, 
                                            opacity: 0.8 * (1 - launchProgress / 0.5)
                                        })
                                    );
                                    launchGlow.position.copy(launchPos);
                                    scene.add(launchGlow);
                                    
                                    // Remove glow after brief moment
                                    setTimeout(() => scene.remove(launchGlow), 200);
                                } catch (e) {}
                            }
                        } else {
                            impactor.scale.set(1, 1, 1);
                        }
                        
                    } else if (t < 0.80 && !impactOccurred) {
                        // Phase 2: Impact moment - flash effect and direction change
                        impactOccurred = true;
                        meteorDeflected = willSucceed; // Only deflect if mitigation will succeed
                        
                        // Create impact flash
                        const flashGeometry = new THREE.SphereGeometry(globeRadiusUnits * 0.05, 8, 6);
                        const flashMaterial = new THREE.MeshBasicMaterial({ 
                            color: 0xffffff, 
                            transparent: true, 
                            opacity: 1.0 
                        });
                        const flash = new THREE.Mesh(flashGeometry, flashMaterial);
                        flash.position.copy(interceptPos);
                        scene.add(flash);
                        
                        // Fade out flash quickly
                        setTimeout(() => {
                            try {
                                if (flash.material) {
                                    const fadeFlash = () => {
                                        flash.material.opacity -= 0.1;
                                        if (flash.material.opacity <= 0) {
                                            scene.remove(flash);
                                        } else {
                                            requestAnimationFrame(fadeFlash);
                                        }
                                    };
                                    fadeFlash();
                                }
                            } catch (e) {}
                        }, 100);
                        
                        // Remove impactor (it's destroyed/spent)
                        scene.remove(impactor);
                        
                    } else if (meteorDeflected) {
                        // Phase 3: Deflected meteor flies away
                        const deflectionProgress = (t - 0.80) / 0.20;
                        const deflectedPos = new THREE.Vector3().copy(interceptPos);
                        deflectedPos.add(deflectionDirection.clone().multiplyScalar(deflectionProgress * globeRadiusUnits * 2));
                        meteor.position.copy(deflectedPos);
                        
                        // Update meteor trail during deflection
                        meteorTrail.update(meteor.position);
                        
                        // Fade out meteor as it moves away
                        meteor.material.opacity = Math.max(0, 0.9 - deflectionProgress);
                    } else if (!meteorDeflected) {
                        // Phase 3: Failed deflection - meteor continues to surface
                        const impactProgress = (t - 0.80) / 0.20;
                        const finalPos = new THREE.Vector3().lerpVectors(interceptPos, surfacePos, impactProgress);
                        meteor.position.copy(finalPos);
                        
                        // Update meteor trail during final descent
                        meteorTrail.update(meteor.position);
                        
                        // Keep meteor visible as it impacts
                        meteor.material.opacity = 0.9;
                    }
                    
                    if (t < 1) {
                        requestAnimationFrame(frame);
                    } else {
                        // Animation complete - clean up
                        try {
                            scene.remove(meteor);
                            scene.remove(impactor);
                            scene.remove(trailLine);
                            scene.remove(launchSite);
                            meteorTrail.dispose(); // Clean up meteor trail
                        } catch (e) {}
                        
                        // Return the pre-calculated success result
                        resolve(willSucceed);
                    }
                }
                
                requestAnimationFrame(frame);
                
            } catch (err) {
                console.warn('Kinetic mitigation animation failed:', err && err.message);
                resolve(false);
            }
        });
    }

    // Animate nuclear standoff mitigation - launches nuclear device that vaporizes the meteor
    function animateNuclearMitigation(targetLat, targetLng) {
        return new Promise((resolve) => {
            try {
                if (!globe) return resolve(false);

                const scene = (globe.scene && globe.scene()) || globe._scene || null;
                if (!scene) return resolve(false);

                // Calculate positions
                const surfacePos = globe.getCoords(targetLat, targetLng, 0.0);
                const globeRadiusUnits = (globe.getGlobeRadius ? globe.getGlobeRadius() : 100);
                const detonationAlt = globeRadiusUnits * 2.0; // Detonate higher up for standoff
                const detonationPos = globe.getCoords(targetLat, targetLng, detonationAlt / globeRadiusUnits);
                const meteorStartPos = globe.getCoords(targetLat, targetLng, 3.0);
                
                // Create meteor
                const diameterVal = parseFloat(document.getElementById('diameter')?.value) || 25;
                const meteorScale = Math.max(0.4, Math.log10(Math.max(diameterVal, 1)) * 0.6);
                
                const meteorGeometry = new THREE.SphereGeometry(globeRadiusUnits * 0.02 * meteorScale, 8, 6);
                const meteorMaterial = new THREE.MeshBasicMaterial({ 
                    color: 0xff6644, 
                    transparent: true, 
                    opacity: 0.9 
                });
                const meteor = new THREE.Mesh(meteorGeometry, meteorMaterial);
                meteor.position.copy(meteorStartPos);
                scene.add(meteor);
                
                // Create meteor trail
                const meteorTrail = createMeteorTrail(meteor, scene, meteorStartPos);
                
                // Create nuclear device (bigger than kinetic impactor)
                const nukeGeometry = new THREE.SphereGeometry(globeRadiusUnits * 0.015, 8, 6); // Bigger than kinetic
                const nukeMaterial = new THREE.MeshBasicMaterial({ 
                    color: 0x444444, 
                    transparent: true, 
                    opacity: 0.9 
                });
                const nuke = new THREE.Mesh(nukeGeometry, nukeMaterial);
                
                // Calculate launch site much further away for nuclear safety and dramatic curve
                const launchLatOffset = 25; // ~2500km offset for nuclear launch
                const launchLonOffset = 25;
                const launchLat = Math.max(-85, Math.min(85, targetLat + launchLatOffset));
                const launchLon = targetLng + launchLonOffset;
                
                const launchPos = globe.getCoords(launchLat, launchLon, 0.0);
                nuke.position.copy(launchPos);
                scene.add(nuke);
                
                // Create launch site indicator (larger for nuclear)
                const launchSiteGeometry = new THREE.RingGeometry(globeRadiusUnits * 0.015, globeRadiusUnits * 0.025, 8);
                const launchSiteMaterial = new THREE.MeshBasicMaterial({ 
                    color: 0x00ff00, 
                    transparent: true, 
                    opacity: 0.8,
                    side: THREE.DoubleSide
                });
                const launchSite = new THREE.Mesh(launchSiteGeometry, launchSiteMaterial);
                launchSite.position.copy(launchPos);
                launchSite.lookAt(0, 0, 0);
                scene.add(launchSite);
                
                // Calculate curved trajectory control points for nuclear device (moderate arc)
                const midPoint1 = globe.getCoords(
                    targetLat + launchLatOffset * 0.7, 
                    targetLng + launchLonOffset * 0.7, 
                    1.2 // Reduced first arc point
                );
                const midPoint2 = globe.getCoords(
                    targetLat + launchLatOffset * 0.3, 
                    targetLng + launchLonOffset * 0.3, 
                    1.6 // Reduced arc point
                );
                
                // Create nuclear device trail (orange/red for nuclear)
                const trailPoints = [];
                const maxTrailLength = 12;
                const trailGeometry = new THREE.BufferGeometry();
                const trailMaterial = new THREE.LineBasicMaterial({ 
                    color: 0xff4400, 
                    transparent: true, 
                    opacity: 0.7,
                    linewidth: 3
                });
                const trailLine = new THREE.Line(trailGeometry, trailMaterial);
                scene.add(trailLine);

                // Helper function for Bezier curve (same as kinetic)
                function calculateBezierPoint(p0, p1, p2, p3, t) {
                    const u = 1 - t;
                    const tt = t * t;
                    const uu = u * u;
                    const uuu = uu * u;
                    const ttt = tt * t;
                    
                    const point = new THREE.Vector3();
                    point.addScaledVector(p0, uuu);
                    point.addScaledVector(p1, 3 * uu * t);
                    point.addScaledVector(p2, 3 * u * tt);
                    point.addScaledVector(p3, ttt);
                    
                    return point;
                }

                // Calculate physics-based nuclear effectiveness upfront
                const diameter = parseFloat(document.getElementById('diameter')?.value) || 25;
                const density = parseFloat(document.getElementById('material')?.value) || 3000;
                const radius = diameter / 2;
                const mass = (4/3) * Math.PI * Math.pow(radius, 3) * density;
                const speed = parseFloat(document.getElementById('speed')?.value) || 20;
                const finalVelocity = Math.sqrt(Math.pow(speed * 1000, 2) + Math.pow(11200, 2));
                const impactEnergy = 0.5 * mass * Math.pow(finalVelocity, 2);
                
                const effectiveness = calculateMitigationEffectiveness('nuclear', mass, impactEnergy, diameter);
                // Mitigation strategies are always effective - no random failure
                const willSucceed = true;

                const duration = 4000; // Same 4 second duration
                const startTime = performance.now();
                
                let detonationOccurred = false;
                let meteorVaporized = false;

                function frame(now) {
                    const t = Math.min(1, (now - startTime) / duration);
                    
                    if (t < 0.70 && !detonationOccurred) {
                        // Phase 1: Meteor descends, nuclear device launches after delay
                        const meteorProgress = t / 0.70;
                        const meteorPos = new THREE.Vector3().lerpVectors(meteorStartPos, detonationPos, meteorProgress);
                        meteor.position.copy(meteorPos);
                        
                        // Update meteor trail
                        meteorTrail.update(meteor.position);
                        
                        // Nuclear device launches after 25% delay (same as kinetic)
                        const nukeLaunchDelay = 0.25;
                        if (t >= nukeLaunchDelay) {
                            const nukeProgress = (t - nukeLaunchDelay) / (0.70 - nukeLaunchDelay);
                            const nukePos = calculateBezierPoint(
                                launchPos,
                                midPoint1,
                                midPoint2,
                                detonationPos,
                                Math.max(0, Math.min(1, nukeProgress))
                            );
                            nuke.position.copy(nukePos);
                            
                            // Update nuclear device trail
                            trailPoints.push(nuke.position.clone());
                            if (trailPoints.length > maxTrailLength) {
                                trailPoints.shift();
                            }
                            
                            if (trailPoints.length > 1) {
                                trailGeometry.setFromPoints(trailPoints);
                                trailGeometry.needsUpdate = true;
                            }
                        } else {
                            nuke.position.copy(launchPos);
                            
                            // Pre-launch warning (red for nuclear)
                            const prelaunchWarning = 0.1;
                            if (t >= (nukeLaunchDelay - prelaunchWarning)) {
                                const warningProgress = (t - (nukeLaunchDelay - prelaunchWarning)) / prelaunchWarning;
                                const pulseFactor = 1 + 0.4 * Math.sin(warningProgress * Math.PI * 10);
                                launchSite.scale.set(pulseFactor, pulseFactor, pulseFactor);
                                launchSite.material.color.setHex(0xff0000); // Red for nuclear
                            } else {
                                launchSite.scale.set(1, 1, 1);
                                launchSite.material.color.setHex(0x00ff00);
                            }
                        }
                        
                        // Nuclear launch effects
                        const launchEffectDuration = 0.2; // Longer for nuclear
                        const launchEffectEnd = nukeLaunchDelay + launchEffectDuration;
                        if (t >= nukeLaunchDelay && t < launchEffectEnd) {
                            const launchProgress = (t - nukeLaunchDelay) / launchEffectDuration;
                            const launchScale = 1 + 0.8 * (1 - launchProgress); // Bigger effect
                            nuke.scale.set(launchScale, launchScale, launchScale);
                            
                            if (launchProgress < 0.6) {
                                try {
                                    const launchGlow = new THREE.Mesh(
                                        new THREE.SphereGeometry(globeRadiusUnits * 0.03, 8, 6), // Bigger glow
                                        new THREE.MeshBasicMaterial({ 
                                            color: 0xff2200, 
                                            transparent: true, 
                                            opacity: 0.9 * (1 - launchProgress / 0.6)
                                        })
                                    );
                                    launchGlow.position.copy(launchPos);
                                    scene.add(launchGlow);
                                    
                                    setTimeout(() => scene.remove(launchGlow), 150);
                                } catch (e) {}
                            }
                        } else {
                            nuke.scale.set(1, 1, 1);
                        }
                        
                    } else if (t < 0.85 && !detonationOccurred) {
                        // Phase 2: Nuclear detonation - MUCH bigger explosion
                        detonationOccurred = true;
                        meteorVaporized = willSucceed; // Only vaporize if mitigation will succeed
                        
                        // Create 3D nuclear explosion with multiple spheres
                        const explosionSpheres = [];
                        
                        // Core explosion sphere (bright white)
                        const coreGeometry = new THREE.SphereGeometry(globeRadiusUnits * 0.025, 12, 8);
                        const coreMaterial = new THREE.MeshBasicMaterial({ 
                            color: 0xffffff, 
                            transparent: true, 
                            opacity: 1.0 
                        });
                        const coreExplosion = new THREE.Mesh(coreGeometry, coreMaterial);
                        coreExplosion.position.copy(detonationPos);
                        scene.add(coreExplosion);
                        explosionSpheres.push({ mesh: coreExplosion, baseScale: 1, growthRate: 0.15 });
                        
                        // Secondary explosion sphere (orange)
                        const secondaryGeometry = new THREE.SphereGeometry(globeRadiusUnits * 0.04, 10, 6);
                        const secondaryMaterial = new THREE.MeshBasicMaterial({ 
                            color: 0xffaa00, 
                            transparent: true, 
                            opacity: 0.8 
                        });
                        const secondaryExplosion = new THREE.Mesh(secondaryGeometry, secondaryMaterial);
                        secondaryExplosion.position.copy(detonationPos);
                        scene.add(secondaryExplosion);
                        explosionSpheres.push({ mesh: secondaryExplosion, baseScale: 0.8, growthRate: 0.12 });
                        
                        // Outer explosion sphere (red-orange)
                        const outerGeometry = new THREE.SphereGeometry(globeRadiusUnits * 0.055, 8, 6);
                        const outerMaterial = new THREE.MeshBasicMaterial({ 
                            color: 0xff6600, 
                            transparent: true, 
                            opacity: 0.6 
                        });
                        const outerExplosion = new THREE.Mesh(outerGeometry, outerMaterial);
                        outerExplosion.position.copy(detonationPos);
                        scene.add(outerExplosion);
                        explosionSpheres.push({ mesh: outerExplosion, baseScale: 1.2, growthRate: 0.10 });
                        
                        // Heat distortion sphere (very transparent)
                        const heatGeometry = new THREE.SphereGeometry(globeRadiusUnits * 0.07, 8, 6);
                        const heatMaterial = new THREE.MeshBasicMaterial({ 
                            color: 0xff4400, 
                            transparent: true, 
                            opacity: 0.3 
                        });
                        const heatExplosion = new THREE.Mesh(heatGeometry, heatMaterial);
                        heatExplosion.position.copy(detonationPos);
                        scene.add(heatExplosion);
                        explosionSpheres.push({ mesh: heatExplosion, baseScale: 1.5, growthRate: 0.08 });
                        
                        // Multiple expanding shockwave rings
                        const createShockwave = (delay, color, size) => {
                            setTimeout(() => {
                                try {
                                    const shockGeometry = new THREE.RingGeometry(globeRadiusUnits * 0.02, globeRadiusUnits * size, 16);
                                    const shockMaterial = new THREE.MeshBasicMaterial({ 
                                        color: color, 
                                        transparent: true, 
                                        opacity: 0.8,
                                        side: THREE.DoubleSide
                                    });
                                    const shock = new THREE.Mesh(shockGeometry, shockMaterial);
                                    shock.position.copy(detonationPos);
                                    scene.add(shock);
                                    
                                    // Animate shockwave expansion
                                    let shockScale = 1;
                                    const expandShock = () => {
                                        shockScale += 0.15;
                                        shock.scale.set(shockScale, shockScale, shockScale);
                                        shock.material.opacity *= 0.92;
                                        if (shock.material.opacity > 0.01) {
                                            requestAnimationFrame(expandShock);
                                        } else {
                                            scene.remove(shock);
                                        }
                                    };
                                    expandShock();
                                } catch (e) {}
                            }, delay);
                        };
                        
                        // Create multiple shockwaves (smaller sizes)
                        createShockwave(0, 0xffffff, 0.08);   // White flash
                        createShockwave(100, 0xffaa00, 0.12); // Orange
                        createShockwave(200, 0xff6600, 0.15); // Red-orange
                        
                        // Animate and fade out 3D explosion spheres
                        setTimeout(() => {
                            try {
                                const fadeExplosions = () => {
                                    let anyVisible = false;
                                    
                                    explosionSpheres.forEach((sphere, index) => {
                                        // Different fade rates for each sphere
                                        const fadeRate = 0.03 + (index * 0.01);
                                        sphere.mesh.material.opacity -= fadeRate;
                                        
                                        // Different growth rates for each sphere
                                        const currentScale = sphere.baseScale + (sphere.growthRate * (1 - sphere.mesh.material.opacity));
                                        sphere.mesh.scale.set(currentScale, currentScale, currentScale);
                                        
                                        if (sphere.mesh.material.opacity > 0) {
                                            anyVisible = true;
                                        } else {
                                            scene.remove(sphere.mesh);
                                        }
                                    });
                                    
                                    if (anyVisible) {
                                        requestAnimationFrame(fadeExplosions);
                                    }
                                };
                                fadeExplosions();
                            } catch (e) {}
                        }, 200);
                        
                        // Remove nuclear device 
                        scene.remove(nuke);
                        
                        if (meteorVaporized) {
                            // Successful vaporization - remove meteor
                            scene.remove(meteor);
                            meteorTrail.dispose(); // Clean up meteor trail when vaporized
                        }
                        
                    } else if (meteorVaporized) {
                        // Phase 3: Aftermath - explosion dissipates (successful vaporization)
                        // Nothing needed - meteor is gone
                    } else if (!meteorVaporized && detonationOccurred) {
                        // Phase 3: Failed vaporization - meteor continues to surface
                        const failedProgress = (t - 0.85) / 0.15;
                        const finalPos = new THREE.Vector3().lerpVectors(detonationPos, surfacePos, failedProgress);
                        meteor.position.copy(finalPos);
                        
                        // Update meteor trail during final descent
                        meteorTrail.update(meteor.position);
                        
                        // Keep meteor visible as it impacts
                        meteor.material.opacity = 0.9;
                    }
                    
                    if (t < 1) {
                        requestAnimationFrame(frame);
                    } else {
                        // Animation complete - clean up
                        try {
                            scene.remove(meteor);
                            scene.remove(nuke);
                            scene.remove(trailLine);
                            scene.remove(launchSite);
                            meteorTrail.dispose(); // Clean up meteor trail
                        } catch (e) {}
                        
                        // Return the pre-calculated success result
                        resolve(willSucceed);
                    }
                }
                
                requestAnimationFrame(frame);
                
            } catch (err) {
                console.warn('Nuclear mitigation animation failed:', err && err.message);
                resolve(false);
            }
        });
    }

    // Animate gravity tractor mitigation - spacecraft pulls meteor off course gradually
    function animateGravityTractor(targetLat, targetLng) {
        return new Promise((resolve) => {
            try {
                if (!globe) return resolve(false);

                const scene = (globe.scene && globe.scene()) || globe._scene || null;
                if (!scene) return resolve(false);

                // Calculate positions
                const surfacePos = globe.getCoords(targetLat, targetLng, 0.0);
                const globeRadiusUnits = (globe.getGlobeRadius ? globe.getGlobeRadius() : 100);
                const meteorStartPos = globe.getCoords(targetLat, targetLng, 3.0);
                
                // Create meteor
                const diameterVal = parseFloat(document.getElementById('diameter')?.value) || 25;
                const meteorScale = Math.max(0.4, Math.log10(Math.max(diameterVal, 1)) * 0.6);
                
                const meteorGeometry = new THREE.SphereGeometry(globeRadiusUnits * 0.02 * meteorScale, 8, 6);
                const meteorMaterial = new THREE.MeshBasicMaterial({ 
                    color: 0xff6644, 
                    transparent: true, 
                    opacity: 0.9 
                });
                const meteor = new THREE.Mesh(meteorGeometry, meteorMaterial);
                meteor.position.copy(meteorStartPos);
                scene.add(meteor);
                
                // Create meteor trail
                const meteorTrail = createMeteorTrail(meteor, scene, meteorStartPos);
                
                // Create gravity tractor spacecraft (positioned to the side of the meteor's path)
                const tractorGeometry = new THREE.BoxGeometry(
                    globeRadiusUnits * 0.025, 
                    globeRadiusUnits * 0.012, 
                    globeRadiusUnits * 0.016
                );
                const tractorMaterial = new THREE.MeshBasicMaterial({ 
                    color: 0x4488ff, 
                    transparent: true, 
                    opacity: 0.9 
                });
                const tractor = new THREE.Mesh(tractorGeometry, tractorMaterial);
                
                // Position tractor offset from meteor path (hovering nearby)
                const hoverDistance = parseFloat(document.getElementById('hover-distance')?.value) || 100;
                const hoverOffset = globeRadiusUnits * (hoverDistance / 10000); // Convert meters to globe units
                const tractorStartPos = new THREE.Vector3().copy(meteorStartPos);
                tractorStartPos.x += hoverOffset;
                tractorStartPos.y += hoverOffset * 0.5;
                tractor.position.copy(tractorStartPos);
                scene.add(tractor);
                
                // Create visual connection beam between tractor and meteor
                const beamGeometry = new THREE.BufferGeometry();
                const beamMaterial = new THREE.LineBasicMaterial({ 
                    color: 0x44aaff, 
                    transparent: true, 
                    opacity: 0.4,
                    linewidth: 2
                });
                const beam = new THREE.Line(beamGeometry, beamMaterial);
                scene.add(beam);
                
                // Create tractor thruster effects
                const thrusterGeometry = new THREE.SphereGeometry(globeRadiusUnits * 0.004, 6, 4);
                const thrusterMaterial = new THREE.MeshBasicMaterial({ 
                    color: 0x00aaff, 
                    transparent: true, 
                    opacity: 0.7 
                });
                const thruster = new THREE.Mesh(thrusterGeometry, thrusterMaterial);
                scene.add(thruster);

                // Calculate physics-based gravity tractor effectiveness upfront
                const diameter = parseFloat(document.getElementById('diameter')?.value) || 25;
                const density = parseFloat(document.getElementById('material')?.value) || 3000;
                const radius = diameter / 2;
                const mass = (4/3) * Math.PI * Math.pow(radius, 3) * density;
                const speed = parseFloat(document.getElementById('speed')?.value) || 20;
                const finalVelocity = Math.sqrt(Math.pow(speed * 1000, 2) + Math.pow(11200, 2));
                const impactEnergy = 0.5 * mass * Math.pow(finalVelocity, 2);
                
                const effectiveness = calculateMitigationEffectiveness('gravity', mass, impactEnergy, diameter);
                // Mitigation strategies are always effective - no random failure
                const willSucceed = true;

                const duration = 8000; // 8 seconds for gradual deflection and slower escape
                const startTime = performance.now();
                
                let deflectionStarted = false;
                const deflectionDirection = new THREE.Vector3(0.8, 0.3, 0.6).normalize(); // Deflection vector

                function frame(now) {
                    const t = Math.min(1, (now - startTime) / duration);
                    
                    if (t < 0.6) {
                        // Phase 1: Tractor approaches and begins gradual pull (60% of animation)
                        const approachProgress = t / 0.6;
                        
                        // Meteor descends slowly while being pulled
                        let meteorProgress = approachProgress * 0.6; // Slower descent due to tractor pull
                        
                        // Apply gradual deflection as tractor pulls
                        if (approachProgress > 0.3) {
                            deflectionStarted = true;
                            const deflectionStrength = (approachProgress - 0.3) / 0.7; // Gradual increase
                            const deflectionOffset = deflectionDirection.clone().multiplyScalar(
                                deflectionStrength * globeRadiusUnits * 0.5
                            );
                            
                            // Meteor path curves away from original trajectory
                            const basePos = new THREE.Vector3().lerpVectors(meteorStartPos, surfacePos, meteorProgress);
                            meteor.position.copy(basePos.add(deflectionOffset));
                            
                            // Update meteor trail
                            meteorTrail.update(meteor.position);
                        } else {
                            // Early phase - meteor follows original path
                            const meteorPos = new THREE.Vector3().lerpVectors(meteorStartPos, surfacePos, meteorProgress);
                            meteor.position.copy(meteorPos);
                            
                            // Update meteor trail
                            meteorTrail.update(meteor.position);
                        }
                        
                        // Tractor maintains relative position to meteor
                        const tractorPos = new THREE.Vector3().copy(meteor.position);
                        tractorPos.add(new THREE.Vector3(hoverOffset, hoverOffset * 0.5, 0));
                        tractor.position.copy(tractorPos);
                        
                        // Update gravitational beam
                        beamGeometry.setFromPoints([tractor.position, meteor.position]);
                        beamGeometry.needsUpdate = true;
                        
                        // Animate beam opacity (pulsing effect)
                        beam.material.opacity = 0.2 + 0.3 * Math.sin(t * Math.PI * 8);
                        
                        // Position thruster effect behind tractor
                        const thrusterPos = new THREE.Vector3().copy(tractor.position);
                        thrusterPos.add(new THREE.Vector3(-hoverOffset * 0.3, -hoverOffset * 0.2, 0));
                        thruster.position.copy(thrusterPos);
                        
                        // Thruster pulse effect
                        const thrusterPulse = 1 + 0.5 * Math.sin(t * Math.PI * 12);
                        thruster.scale.set(thrusterPulse, thrusterPulse, thrusterPulse);
                        
                    } else if (willSucceed) {
                        // Phase 2: Successful deflection - Meteor escapes Earth's gravity and flies away (40% of animation - much slower)
                        const escapeProgress = (t - 0.6) / 0.4;
                        
                        // Much slower meteor escape with gradual acceleration
                        const escapeSpeed = escapeProgress * escapeProgress; // Quadratic for slower start
                        const escapeDistance = escapeSpeed * globeRadiusUnits * 2.5;
                        const escapePos = new THREE.Vector3().copy(meteor.position);
                        escapePos.add(deflectionDirection.clone().multiplyScalar(escapeDistance));
                        meteor.position.copy(escapePos);
                        
                        // Update meteor trail during escape
                        meteorTrail.update(meteor.position);
                        
                        // Tractor follows much longer during escape
                        if (escapeProgress < 0.8) {
                            const tractorPos = new THREE.Vector3().copy(meteor.position);
                            tractorPos.add(new THREE.Vector3(hoverOffset, hoverOffset * 0.5, 0));
                            tractor.position.copy(tractorPos);
                            
                            // Maintain beam during most of escape
                            beamGeometry.setFromPoints([tractor.position, meteor.position]);
                            beamGeometry.needsUpdate = true;
                            
                            // Beam gradually fades but stays longer
                            beam.material.opacity = Math.max(0.1, 0.4 - escapeProgress * 0.3);
                        } else {
                            // Beam fades more gradually as distance increases
                            beam.material.opacity *= 0.95;
                        }
                        
                        // Much slower fade out - meteor stays visible longer
                        meteor.material.opacity = Math.max(0.2, 0.9 - escapeProgress * 0.6);
                        tractor.material.opacity = Math.max(0.1, 0.9 - escapeProgress * 0.4);
                        thruster.material.opacity = Math.max(0.1, 0.7 - escapeProgress * 0.5);
                    } else {
                        // Phase 2: Failed deflection - meteor overcomes tractor and continues to surface
                        const failedProgress = (t - 0.6) / 0.4;
                        
                        // Meteor overcomes the tractor pull and continues to surface
                        const currentMeteorPos = meteor.position.clone();
                        const finalPos = new THREE.Vector3().lerpVectors(currentMeteorPos, surfacePos, failedProgress);
                        meteor.position.copy(finalPos);
                        
                        // Update meteor trail during final descent
                        meteorTrail.update(meteor.position);
                        
                        // Tractor loses its grip gradually
                        if (failedProgress < 0.5) {
                            const tractorPos = new THREE.Vector3().copy(meteor.position);
                            tractorPos.add(new THREE.Vector3(hoverOffset, hoverOffset * 0.5, 0));
                            tractor.position.copy(tractorPos);
                            
                            // Weakening beam
                            beamGeometry.setFromPoints([tractor.position, meteor.position]);
                            beamGeometry.needsUpdate = true;
                            beam.material.opacity = Math.max(0.05, 0.3 * (1 - failedProgress * 2));
                        } else {
                            // Beam breaks completely
                            beam.material.opacity = 0;
                        }
                        
                        // Keep meteor and tractor visible
                        meteor.material.opacity = 0.9;
                        tractor.material.opacity = Math.max(0.3, 0.9 - failedProgress * 0.6);
                        thruster.material.opacity = Math.max(0.2, 0.7 - failedProgress * 0.5);
                    }
                    
                    if (t < 1) {
                        requestAnimationFrame(frame);
                    } else {
                        // Animation complete - clean up
                        try {
                            scene.remove(meteor);
                            scene.remove(tractor);
                            scene.remove(beam);
                            scene.remove(thruster);
                            meteorTrail.dispose(); // Clean up meteor trail
                        } catch (e) {}
                        
                        // Return the pre-calculated success result
                        resolve(willSucceed);
                    }
                }
                
                requestAnimationFrame(frame);
                
            } catch (err) {
                console.warn('Gravity tractor animation failed:', err && err.message);
                resolve(false);
            }
        });
    }

    // Create reduced impact effect for successful mitigation
    function createReducedImpact(coords) {
        if (!coords || !Array.isArray(coords) || coords.length < 2) {
            console.warn('createReducedImpact: invalid coordinates', coords);
            return;
        }
        
        const [lon, lat] = coords;
        console.log('createReducedImpact: creating minimal impact at', { lat, lon });
        
        // Calculate much smaller impact effects (10% of original)
        const originalDiameter = parseFloat(document.getElementById('diameter')?.value) || 25;
        const reducedDiameter = originalDiameter * 0.1; // 10% of original size
        
        // Use existing impact calculation but with reduced parameters
        const reducedImpact = calculateImpactEffects(reducedDiameter);
        
        if (!reducedImpact) return;
        
        const craterRadiusKm = (reducedImpact.craterDiameter / 2 / 1000) || 0.01;
        const blastRadiusKm = (reducedImpact.blastRadius / 1000) || 0.05;
        
        // Create much smaller, dimmer impact layers
        const blastColor = (alpha) => `rgba(100, 200, 100, ${alpha * 0.5})`; // Green, dimmer
        const craterColor = (alpha) => `rgba(100, 150, 200, ${alpha * 0.3})`; // Blue, much dimmer
        
        const impactLayers = [
            { lat: lat, lng: lon, maxR: Number(blastRadiusKm), color: (t) => blastColor(1-t), propagationSpeed: 5, period: 200},
            { lat: lat, lng: lon, maxR: Number(craterRadiusKm), color: (t) => craterColor(1-t), propagationSpeed: 0.3, period: 100},
        ];
        
        // Apply reduced impact visualization
        try {
            if (typeof globe.ringsData === 'function') {
                globe
                    .ringColor('color')
                    .ringMaxRadius('maxR')
                    .ringPropagationSpeed('propagationSpeed')
                    .ringRepeatPeriod('period')
                    .ringsData(impactLayers);
            } else {
                globe.customLayerData(impactLayers.map(l => ({ lat: l.lat, lng: l.lng, radius: l.maxR, color: l.color, alt: 0.02, shape: 'ring', opacity: 0.3 })));
            }
        } catch (e) {
            console.warn('Failed to set reduced impact visualization:', e && e.message);
        }
        
        // Show reduced impact info
        updateImpactInfo(reducedImpact);
        showImpactDisplay();
    }

    // Helper function to calculate impact effects (reusable)
    function calculateImpactEffects(diameter) {
        try {
            const density = parseFloat(document.getElementById('material')?.value) || 3000;
            const speed = parseFloat(document.getElementById('speed')?.value) || 20;
            const angle = parseFloat(document.getElementById('angle')?.value) || 45;
            
            const radius = diameter / 2;
            const mass = (4/3) * Math.PI * Math.pow(radius, 3) * density;
            const impactEnergy = 0.5 * mass * Math.pow(speed * 1000, 2);
            
            // Terrain multiplier based on impact location (simplified)
            const terrainMultiplier = 1.0; // Could be enhanced based on location
            
            const craterDiameter = Math.pow(impactEnergy / 1e15, 0.26) * 1000 * terrainMultiplier;
            const blastRadius = Math.pow(impactEnergy / 1e12, 0.33) * 1000;
            const tntEquivalent = impactEnergy / 4.184e15;
            
            return {
                impactEnergy,
                craterDiameter,
                blastRadius,
                tntEquivalent
            };
        } catch (error) {
            console.warn('Error calculating impact effects:', error);
            return null;
        }
    }

    // Presets and historic event UI have been removed; no preset helper functions remain.

    // Calculate physics-based mitigation effectiveness
    function calculateMitigationEffectiveness(method, meteorMass, meteorEnergy, meteorDiameter) {
        const impactorMass = parseFloat(document.getElementById('impactor-mass')?.value) || 500;
        const impactorVelocity = parseFloat(document.getElementById('impactor-velocity')?.value) || 10;
        const spacecraftMass = parseFloat(document.getElementById('spacecraft-mass')?.value) || 1000;
        const hoverDistance = parseFloat(document.getElementById('hover-distance')?.value) || 100;
        const nuclearYield = parseFloat(document.getElementById('yield')?.value) || 1;
        const standoffDistance = parseFloat(document.getElementById('standoff')?.value) || 1000;

        switch(method) {
            case 'kinetic':
                // Kinetic effectiveness based on momentum transfer
                const meteorSpeed = parseFloat(document.getElementById('speed')?.value) || 20;
                const meteorVelocity = Math.sqrt(Math.pow(meteorSpeed * 1000, 2) + Math.pow(11200, 2)); // Actual meteor velocity
                const impactorEnergy = 0.5 * impactorMass * Math.pow(impactorVelocity * 1000, 2);
                const momentumRatio = (impactorMass * impactorVelocity * 1000) / (meteorMass * meteorVelocity);
                const energyRatio = impactorEnergy / meteorEnergy;
                
                // Effectiveness increases with momentum and energy ratios
                let kineticEff = Math.min(0.98, momentumRatio * 3 + energyRatio * 0.8); // Increased multipliers for better scaling
                
                // Scale effectiveness based on impactor-to-meteor mass ratio
                const impactorMassRatio = impactorMass / meteorMass;
                if (impactorMassRatio < 0.0001) kineticEff *= 0.1; // Very small impactor vs very large meteor
                else if (impactorMassRatio < 0.001) kineticEff *= 0.3; // Small impactor vs large meteor
                else if (impactorMassRatio < 0.01) kineticEff *= 0.7; // Medium impactor vs meteor
                // Above 0.01 mass ratio, no penalty (realistic impactor size)
                
                return Math.max(0.05, kineticEff);

            case 'nuclear':
                // Nuclear effectiveness based on yield vs meteor mass
                const yieldEnergy = nuclearYield * 4.184e15; // Convert MT to Joules
                const yieldToMeteorRatio = yieldEnergy / meteorEnergy;
                const standoffEffect = Math.max(0.3, 2000 / standoffDistance); // Closer = more effective
                
                let nuclearEff = Math.min(0.98, yieldToMeteorRatio * 1.2 + standoffEffect * 0.4); // Increased effectiveness
                
                // Apply penalties only for insufficient yield relative to meteor size
                const yieldToMeteorMassRatio = (nuclearYield * 1e6) / meteorMass; // Convert MT to kg
                if (yieldToMeteorMassRatio < 0.1) nuclearEff *= 0.2; // Very low yield vs meteor mass
                else if (yieldToMeteorMassRatio < 1) nuclearEff *= 0.5; // Low yield vs meteor mass
                else if (yieldToMeteorMassRatio < 10) nuclearEff *= 0.8; // Moderate yield vs meteor mass
                // Above 10x mass ratio in yield, no penalty (guaranteed effective)
                
                return Math.max(0.1, nuclearEff);

            case 'gravity':
                // Gravity tractor effectiveness based on spacecraft mass and time
                const duration = parseFloat(document.getElementById('duration')?.value) || 12;
                const gravitationalForce = (6.674e-11 * spacecraftMass * meteorMass) / Math.pow(hoverDistance, 2);
                const accelerationEffect = gravitationalForce / meteorMass;
                const timeEffect = Math.pow(duration / 12, 1.5); // More time = much more effective
                const spacecraftMassRatio = spacecraftMass / meteorMass;
                
                let gravityEff = Math.min(0.90, spacecraftMassRatio * 2000 + timeEffect * 0.6); // Increased cap and scaling
                
                // Time requirement scales with meteor mass
                const requiredTimeRatio = duration / (meteorMass / 1e9); // Time in months per billion kg
                if (requiredTimeRatio < 0.1) gravityEff *= 0.1; // Very insufficient time
                else if (requiredTimeRatio < 1) gravityEff *= 0.4; // Insufficient time
                else if (requiredTimeRatio < 5) gravityEff *= 0.8; // Adequate time
                // Above 5x time ratio, no penalty (guaranteed effective with sufficient time)
                
                // Mass ratio penalty (more gradual)
                if (spacecraftMassRatio < 0.000001) gravityEff *= 0.1; // Extremely small spacecraft
                else if (spacecraftMassRatio < 0.00001) gravityEff *= 0.3; // Very small spacecraft
                else if (spacecraftMassRatio < 0.0001) gravityEff *= 0.7; // Small spacecraft
                
                return Math.max(0.02, gravityEff);

            case 'none':
                return 0.0;

            default:
                return 0.5;
        }
    }

    // Function to calculate effectiveness of mitigation strategies (exposed to UI)
    function calculateMitigation() {
        // Compute using current inputs and return structured results
        const computeResults = () => {
            const diameter = parseFloat(document.getElementById('diameter').value) || 0;
            const density = parseFloat(document.getElementById('material').value) || 3000;
            const speed = parseFloat(document.getElementById('speed').value) || 20;
            const angle = parseFloat(document.getElementById('angle').value) || 45;
            const radius = diameter / 2;

            const mass = (4/3) * Math.PI * Math.pow(radius, 3) * density;
            const impactEnergy = 0.5 * mass * Math.pow(speed * 1000, 2);

            const method = document.getElementById('mitigation-strategy')?.value || 'kinetic';
            const effectiveness = calculateMitigationEffectiveness(method, mass, impactEnergy, diameter);

            const energyReduction = impactEnergy * effectiveness;
            const successProbability = method === 'none' ? 0.0 : effectiveness;

            const leadTime = method === 'none' ? 0 : (method === 'gravity' ? 3650 : (method === 'nuclear' ? 180 : 365));

            return {
                impactEnergy,
                energyReduction,
                successProbability: successProbability * 100,
                requiredLeadTime: leadTime,
                method
            };
        };

        const formatEnergy = (joules) => {
            if (!isFinite(joules)) return 'N/A';
            if (joules >= 1e18) return (joules / 1e18).toFixed(2) + ' EJ';
            if (joules >= 1e15) return (joules / 1e15).toFixed(2) + ' PJ';
            if (joules >= 1e12) return (joules / 1e12).toFixed(2) + ' TJ';
            return Math.round(joules).toLocaleString() + ' J';
        };

        const out = document.getElementById('mitigation-results');
        if (!out) return;

        const render = (results) => {
            // Convert method code to display name
            const methodNames = {
                'none': 'No Mitigation',
                'kinetic': 'Kinetic Impact',
                'nuclear': 'Nuclear Standoff',
                'gravity': 'Gravity Tractor',
                'laser': 'Laser Ablation'
            };
            const methodDisplay = methodNames[results.method] || results.method;
            
            const html = `
                <div class="mitigation-output" style="line-height:1.4;">
                    <div style="margin-bottom:8px;"><strong>Method:</strong> ${methodDisplay} <button class="help-btn" data-key="method" aria-label="Help">?</button></div>
                    <div style="margin-bottom:8px;"><strong>Estimated Energy Reduction:</strong> ${formatEnergy(results.energyReduction)} (${(results.energyReduction / (results.impactEnergy || 1)).toFixed(3)}× of impact energy) <button class="help-btn" data-key="energyReduction" aria-label="Help">?</button></div>
                    <div style="margin-bottom:8px;"><strong>Success Probability:</strong> ${results.successProbability.toFixed(1)}% <button class="help-btn" data-key="successProbability" aria-label="Help">?</button></div>
                    <div style="margin-bottom:8px;"><strong>Required Lead Time:</strong> ${results.requiredLeadTime >= 365 ? Math.round(results.requiredLeadTime/365) + ' years' : results.requiredLeadTime + ' days'} <button class="help-btn" data-key="requiredLeadTime" aria-label="Help">?</button></div>
                </div>
            `;
            out.innerHTML = html;

            const helpTexts = {
                method: 'Mitigation method selected. None = no defense deployed. Kinetic = impactor spacecraft. Gravity = gravity tractor. Nuclear = standoff nuclear device.',
                energyReduction: 'Estimated reduction in impact energy (approx) achieved by the mitigation method. Shown in scientific units.',
                successProbability: 'Estimated probability the mitigation will prevent an impact or sufficiently reduce energy. This is a simplified heuristic.',
                requiredLeadTime: 'Estimated lead time required for the method to be effective. Longer lead time usually increases chance of success.'
            };

            const createTooltip = (btn, text) => {
                try { if (btn._tooltipElement) { btn._tooltipElement.remove(); btn._tooltipElement = null; } } catch (e) {}
                const tip = document.createElement('div');
                tip.className = 'mitigation-tooltip';
                tip.textContent = text;
                document.body.appendChild(tip);
                const rect = btn.getBoundingClientRect();
                const tipRect = tip.getBoundingClientRect();
                let top = rect.top - tipRect.height - 8;
                let placedBelow = false;
                if (top < 8) { top = rect.bottom + 8; placedBelow = true; }
                let left = rect.left + (rect.width / 2) - (tipRect.width / 2);
                left = Math.max(8, Math.min(left, window.innerWidth - tipRect.width - 8));
                tip.style.left = (left + window.scrollX) + 'px';
                tip.style.top = (top + window.scrollY) + 'px';
                if (placedBelow) tip.classList.add('below');
                requestAnimationFrame(() => tip.classList.add('visible'));
                btn._tooltipElement = tip;
            };

            const removeTooltip = (btn) => { try { if (btn && btn._tooltipElement) { btn._tooltipElement.classList.remove('visible'); setTimeout(() => { try { btn._tooltipElement.remove(); } catch (e) {} }, 240); btn._tooltipElement = null; } } catch (e) {} };

            const helpButtons = out.querySelectorAll('.help-btn');
            helpButtons.forEach(btn => {
                const key = btn.getAttribute('data-key');
                const text = helpTexts[key] || '';
                btn.addEventListener('mouseenter', () => createTooltip(btn, text));
                btn.addEventListener('focus', () => createTooltip(btn, text));
                btn.addEventListener('mouseleave', () => removeTooltip(btn));
                btn.addEventListener('blur', () => removeTooltip(btn));
            });
        };

        // Initial render
        render(computeResults());

        // Live-updates: when sliders/inputs change after calculation, recompute and rerender
        const liveSelectors = ['diameter','material','speed','angle','mitigation-strategy','impactor-mass','impactor-velocity','spacecraft-mass','hover-distance','duration','yield','standoff'];

        // Cleanup previous handlers if present
        if (window._mitigationLive && Array.isArray(window._mitigationLive.handlers)) {
            window._mitigationLive.handlers.forEach(({el, type, fn}) => el.removeEventListener(type, fn));
        }

        const handlers = [];
        const debouncedUpdate = debounce(() => {
            try { render(computeResults()); } catch (e) { console.warn('Live update failed:', e && e.message); }
        }, 200);

        liveSelectors.forEach(id => {
            const el = document.getElementById(id);
            if (!el) return;
            const fn = () => debouncedUpdate();
            el.addEventListener('input', fn);
            el.addEventListener('change', fn);
            handlers.push({el, type: 'input', fn});
            handlers.push({el, type: 'change', fn});
        });

        window._mitigationLive = { handlers };
    }

    // Expose to global scope for inline onclick handlers
    window.calculateMitigation = calculateMitigation;

    // Update impact information display
    function updateImpactInfo(impact) {
        const setText = (id, text) => {
            const el = document.getElementById(id);
            if (el) el.textContent = text; else console.debug('Missing element for impact info:', id, text);
        };

        setText('energy-value', impact.energy >= 1e18 ? (impact.energy / 1e18).toFixed(2) + ' EJ' : (impact.energy >= 1e15 ? (impact.energy / 1e15).toFixed(2) + ' PJ' : (impact.energy / 1e12).toFixed(2) + ' TJ'));
        setText('crater-value', impact.craterDiameter >= 1000 ? (impact.craterDiameter / 1000).toFixed(1) + ' km' : impact.craterDiameter.toFixed(0) + ' m');
        setText('blast-value', impact.blastRadius >= 1000 ? (impact.blastRadius / 1000).toFixed(1) + ' km' : impact.blastRadius.toFixed(0) + ' m');
        setText('shockwave-value', (impact.shockwaveRadius / 1000).toFixed(1) + ' km');
        setText('tnt-value', impact.tntEquivalent >= 1e9 ? (impact.tntEquivalent / 1e9).toFixed(2) + ' Gigatons' : impact.tntEquivalent >= 1e6 ? (impact.tntEquivalent / 1e6).toFixed(2) + ' Megatons' : (impact.tntEquivalent / 1e3).toFixed(2) + ' Kilotons');
    }

    // Show impact display
    function showImpactDisplay() {
        const show = id => {
            const el = document.getElementById(id);
            if (el) el.style.display = 'block'; else console.debug('Missing element to show:', id);
        };
        show('impact-info');
        show('legend');
    }

    // Update display values
    function updateDisplayValues() {
        const diameter = document.getElementById('diameter').value;
        const speed = document.getElementById('speed').value;
        const angle = document.getElementById('angle').value;
        
        document.getElementById('diameter-value').textContent = parseFloat(diameter).toFixed(1) + ' m';
        document.getElementById('speed-value').textContent = parseFloat(speed).toFixed(1) + ' km/s';
        document.getElementById('angle-value').textContent = parseFloat(angle).toFixed(1) + '°';
    }

    // Make navigation functions globally available
    window.toggleMenu = function() {
        const menu = document.querySelector('.menu-sidebar');
        const toggle = document.querySelector('.menu-toggle');
        // If no sidebar exists (top-nav mode), do nothing gracefully
        if (!menu && !toggle) return;
        menuOpen = !menuOpen;
        if (menu) {
            if (menuOpen) menu.classList.remove('closed'); else menu.classList.add('closed');
        }
        if (toggle) {
            if (menuOpen) toggle.classList.remove('closed'); else toggle.classList.add('closed');
        }
    };

    window.showPage = function(page) {
        currentPage = page;
        // Toggle active class on nav buttons
        try {
            document.querySelectorAll('.nav-btn').forEach(btn => {
                const target = btn.getAttribute('data-page');
                if (target === page) btn.classList.add('active'); else btn.classList.remove('active');
            });
        } catch (e) {}

        // Scroll to the requested page section if it exists (single-page layout)
        const el = document.getElementById(page) || document.querySelector('.simulator-view');
        if (el && el.scrollIntoView) {
            // account for fixed top nav height
            const navHeight = document.querySelector('.top-nav') ? document.querySelector('.top-nav').offsetHeight : 0;
            const rect = el.getBoundingClientRect();
            const absoluteY = window.scrollY + rect.top - navHeight - 12; // slight offset
            window.scrollTo({ top: absoluteY, behavior: 'smooth' });
        }
    };

    // Initialize when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initGlobe);
    } else {
        initGlobe();
    }
})();