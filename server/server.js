const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

// ─── HTTP & WebSocket Server ───────────────────────────
const app = express();
const server = http.createServer(app);
const socketOptions = process.env.ALLOWED_ORIGIN
    ? { cors: { origin: process.env.ALLOWED_ORIGIN } }
    : {};
const io = new Server(server, socketOptions);

app.use(express.json({ limit: '16kb' }));

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

// ─── REST Telemetry Webhooks (Replaces MQTT) ───────────
app.post('/api/alpr', (req, res) => {
    try {
        if (facilityState.cameraOffline) {
            return res.status(503).json({ error: "System Offline: Camera Disconnected" });
        }
        const data = req.body || {};
        const spotId = typeof data.spot === 'string' ? data.spot.trim().toUpperCase() : '';
        const direction = typeof data.direction === 'string' ? data.direction.trim().toUpperCase() : '';
        const plate = typeof data.plate === 'string' ? data.plate.trim().toUpperCase() : '';
        const vehicleType = typeof data.vehicleType === 'string' ? data.vehicleType.trim() : '';

        if (!hasOwn(facilityState.spots, spotId)) {
            return res.status(400).json({ error: 'Unknown parking spot' });
        }
        if (!['ENTRY', 'EXIT'].includes(direction)) {
            return res.status(400).json({ error: 'Direction must be ENTRY or EXIT' });
        }
        if (!plate || plate.length > 20 || !/^[A-Z0-9 -]+$/.test(plate)) {
            return res.status(400).json({ error: 'Plate must contain 1-20 letters, numbers, spaces, or hyphens' });
        }
        if (!vehicleType || vehicleType.length > 32) {
            return res.status(400).json({ error: 'Vehicle type must contain 1-32 characters' });
        }

        const event = {
            spot: spotId,
            direction,
            plate,
            vehicleType,
            timestamp: Number.isFinite(data.timestamp) ? data.timestamp : Date.now()
        };
        console.log('[REST] Incoming ALPR event:', event);

        facilityState.spots[spotId].status = direction === 'ENTRY' ? 'occupied' : 'free';
        facilityState.spots[spotId].vehicle = direction === 'ENTRY' ? plate : null;
        facilityState.spots[spotId].entryTime = direction === 'ENTRY' ? Date.now() : null;
        io.emit('alpr_event', event);
        io.emit('spot_update', { spotId, state: facilityState.spots[spotId] });
        io.emit('pricing_update', getPricingState());
        
        res.status(200).json({ status: "OK" });
    } catch (err) {
        console.error('[REST] Parse error:', err);
        res.status(400).json({ error: err.message });
    }
});

app.post('/api/spots', (req, res) => {
    try {
        if (facilityState.cameraOffline) {
            return res.status(503).json({ error: "System Offline: Sensors Disconnected" });
        }
        const data = req.body || {};
        const spotId = typeof data.spot === 'string' ? data.spot.trim().toUpperCase() : '';
        const status = typeof data.status === 'string' ? data.status.trim().toLowerCase() : '';

        if (!hasOwn(facilityState.spots, spotId)) {
            return res.status(400).json({ error: 'Unknown parking spot' });
        }
        if (!['free', 'occupied'].includes(status)) {
            return res.status(400).json({ error: 'Status must be free or occupied' });
        }

        console.log('[REST] Incoming spot event:', { spot: spotId, status });
        facilityState.spots[spotId].status = status;
        io.emit('spot_update', { spotId, state: facilityState.spots[spotId] });
        io.emit('pricing_update', getPricingState());
        
        res.status(200).json({ status: "OK" });
    } catch (err) {
        console.error('[REST] Parse error:', err);
        res.status(400).json({ error: err.message });
    }
});

app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        service: 'smartparking-gateway',
        uptimeSeconds: Math.round(process.uptime()),
        pricing: getPricingState()
    });
});

// Serve frontend dashboard statically
app.use(express.static(path.join(__dirname, '../')));

// ─── State Management ──────────────────────────────────
// We maintain facility state here in the Cloud/Gateway layer
const CONFIG = {
    totalSpots: 48,
    baseRate: 3.50,
    maxSurge: 2.8
};

const facilityState = {
    spots: {}, // spotId: { status, vehicle, entryTime }
    cameraOffline: false,
    forceSurge: false
};

// Initialize empty spots for tracking
['A', 'B', 'C', 'D'].forEach(zone => {
    for (let i = 1; i <= 12; i++) {
        const id = `${zone}${String(i).padStart(2, '0')}`;
        facilityState.spots[id] = { status: 'free', vehicle: null, entryTime: null };
    }
});

// Calculate current dynamic price
function getPricingState() {
    const occupied = Object.values(facilityState.spots).filter(s => s.status === 'occupied').length;
    let surge = 1 + (CONFIG.maxSurge - 1) * Math.pow(occupied / CONFIG.totalSpots, 2);
    if (facilityState.forceSurge) surge = CONFIG.maxSurge;
    
    return {
        occupied,
        total: CONFIG.totalSpots,
        baseRate: CONFIG.baseRate,
        surge: surge,
        currentRate: CONFIG.baseRate * surge,
        forceSurge: facilityState.forceSurge
    };
}

// ─── WebSocket Connections (Dashboard) ─────────────────
io.on('connection', (socket) => {
    console.log('[Socket] Dashboard client connected:', socket.id);
    
    // Send full initial state upon connection
    socket.emit('init_state', {
        spots: facilityState.spots,
        pricing: getPricingState(),
        arch: { cameraOffline: facilityState.cameraOffline }
    });

    // Listen for manual overrides from the IoT Simulation Panel in the browser
    socket.on('manual_override', (action = {}) => {
        console.log('[Simulation] Manual override:', action);
        
        if (action.type === 'force_surge' && typeof action.value === 'boolean') {
            facilityState.forceSurge = action.value;
            io.emit('pricing_update', getPricingState());
        } else if (action.type === 'toggle_camera' && typeof action.value === 'boolean') {
            facilityState.cameraOffline = action.value;
            io.emit('arch_status', { cameraOffline: facilityState.cameraOffline });
        }
    });

    socket.on('disconnect', () => {
        console.log('[Socket] Client disconnected');
    });
});

// ─── Built-in Simulators (No Python needed) ────────

// Helper: Generate fake license plate
function generateFakePlate() {
    const letters = 'ABCDEFGHJKLMNPRSTUVWXYZ';
    const rL = () => letters[Math.floor(Math.random() * letters.length)];
    const rD = () => Math.floor(Math.random() * 10);
    return `${rL()}${rL()} ${rD()}${rD()} ${rL()}${rL()} ${Math.floor(Math.random() * 9000) + 1000}`;
}

// Helper: Random element from array
const pick = arr => arr[Math.floor(Math.random() * arr.length)];

// Helper: Random float between min and max
const randBetween = (min, max) => Math.random() * (max - min) + min;

// IoT Ground Sensor Simulator (replaces virtual_sensors.py)
function startIoTSimulator() {
    const ZONES = ['A', 'B', 'C', 'D'];
    const SPOTS = ZONES.flatMap(z => Array.from({length: 12}, (_, i) => `${z}${String(i + 1).padStart(2, '0')}`));

    console.log('🔋 [Built-in] IoT Virtual Sensors Active');

    function simulateSensorEvent() {
        const spot = pick(SPOTS);
        const status = Math.random() < 0.6 ? 'occupied' : 'free';

        if (facilityState.cameraOffline) return;

        if (facilityState.spots[spot]) {
            facilityState.spots[spot].status = status;
        }
        io.emit('spot_update', { spotId: spot, state: facilityState.spots[spot] });
        io.emit('pricing_update', getPricingState());
    }

    // Fire a sensor event every 2-5 seconds
    (function loop() {
        simulateSensorEvent();
        setTimeout(loop, randBetween(2000, 5000));
    })();
}

// Edge AI ALPR Simulator (replaces edge-ai/main.py)
function startALPRSimulator() {
    const ZONES = ['A', 'B', 'C', 'D'];

    console.log('🧠 [Built-in] Edge AI ALPR Engine Active');

    function simulateALPREvent() {
        if (facilityState.cameraOffline) return;

        const spot = `${pick(ZONES)}${String(Math.floor(Math.random() * 12) + 1).padStart(2, '0')}`;
        const direction = Math.random() < 0.55 ? 'ENTRY' : 'EXIT';
        const plate = generateFakePlate();

        const data = {
            spot,
            direction,
            plate,
            vehicleType: pick(['Sedan', 'SUV', 'Hatchback', 'Truck', 'Coupe']),
            timestamp: Date.now()
        };

        // Update state
        if (facilityState.spots[spot]) {
            facilityState.spots[spot].status = direction === 'ENTRY' ? 'occupied' : 'free';
            facilityState.spots[spot].vehicle = direction === 'ENTRY' ? plate : null;
            facilityState.spots[spot].entryTime = direction === 'ENTRY' ? Date.now() : null;
        }

        io.emit('alpr_event', data);
        io.emit('spot_update', { spotId: spot, state: facilityState.spots[spot] });
        io.emit('pricing_update', getPricingState());
    }

    // Fire an ALPR event every 4-8 seconds
    (function loop() {
        simulateALPREvent();
        setTimeout(loop, randBetween(4000, 8000));
    })();
}

// Boot the gateway server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`\n🚀 SmartPark Gateway running at http://localhost:${PORT}`);
    console.log(`↳ Processing Edge Telemetry via REST APIs on /api/alpr and /api/spots`);
    console.log(`↳ Serving WebSocket dashboard to clients...`);

    // Auto-start simulators after 2 seconds (let clients connect first)
    if (process.env.DISABLE_SIMULATORS !== 'true') {
        setTimeout(() => {
            console.log(`\n⚡ Starting built-in simulators...`);
            startIoTSimulator();
            startALPRSimulator();
            console.log(`✅ All systems live! Dashboard is fully operational.\n`);
        }, 2000);
    }
});
