/**
 * SmartPark AI Dashboard - Real Backend Edition
 * Connects via WebSockets to the Node.js Edge Gateway.
 */

document.addEventListener('DOMContentLoaded', () => {
    window.onerror = function(msg, url, line, col, err) {
        document.body.innerHTML += `<div style="position:fixed;bottom:0;left:0;width:100%;background:rgba(255,0,0,0.9);color:white;z-index:9999;padding:20px;font-family:monospace;font-size:16px;border-top:3px solid white;"><strong>🚨 FRONTEND CRASH:</strong> ${msg}<br>Line: ${line} • Col: ${col}</div>`;
        return false;
    };
    
    // ─── DOM Elements ──────────────────────────────────
    const $ = selector => document.querySelector(selector);
    const $$ = selector => document.querySelectorAll(selector);

    // ─── State ─────────────────────────────────────────
    let state = {
        spots: {},
        currentRate: 3.50,
        todayRevenue: 0,
        forceSurge: false,
        cameraOffline: false,
    };

    // ─── WebSocket Connection ──────────────────────────
    const socket = io(); // Auto-detect host (works for localhost AND deployed URL)

    socket.on('connect', () => {
        console.log("🟢 Connected to Edge Gateway WebSocket");
        $('.live-indicator').innerHTML = '<span class="pulse-dot"></span><span>LIVE</span>';
        $('.live-indicator').style.background = '';
        $('.live-indicator').style.borderColor = '';
        updateClock();
    });

    socket.on('disconnect', () => {
        console.log("🔴 Disconnected from Edge Gateway");
        $('.live-indicator').innerHTML = '<span class="pulse-dot" style="background:var(--red);box-shadow:0 0 8px var(--red-glow)"></span><span style="color:var(--red)">OFFLINE</span>';
        $('.live-indicator').style.background = 'rgba(239, 68, 68, 0.1)';
        $('.live-indicator').style.borderColor = 'rgba(239, 68, 68, 0.2)';
    });

    function updateLiveIndicator() {
        if (!socket.connected) return; // Real socket disconnect takes priority
        if (state.cameraOffline) {
            $('.live-indicator').innerHTML = '<span class="pulse-dot" style="background:var(--red);box-shadow:0 0 8px var(--red-glow)"></span><span style="color:var(--red)">SYSTEM OFFLINE</span>';
            $('.live-indicator').style.background = 'rgba(239, 68, 68, 0.1)';
            $('.live-indicator').style.borderColor = 'rgba(239, 68, 68, 0.2)';
        } else {
            $('.live-indicator').innerHTML = '<span class="pulse-dot"></span><span>LIVE</span>';
            $('.live-indicator').style.background = '';
            $('.live-indicator').style.borderColor = '';
        }
    }

    socket.on('init_state', (data) => {
        console.log("📥 Received Initial State", data);
        state.spots = data.spots;
        state.forceSurge = data.pricing.forceSurge;
        state.cameraOffline = data.arch.cameraOffline;
        state.currentRate = data.pricing.currentRate;
        
        initSpotsUI();
        updateStats();
        renderPricingFromState(data.pricing);
        renderArchitecture();
        updateLiveIndicator();
    });

    socket.on('spot_update', (data) => {
        const { spotId, state: spotState } = data;
        state.spots[spotId] = spotState;
        updateSpotDOM(spotId);
        updateStats();
    });

    socket.on('alpr_event', (data) => {
        // Calculate dynamic fee if it's an exit
        if (data.direction === 'EXIT') {
            const spotData = state.spots[data.spot];
            const now = Date.now();
            const entryMs = spotData && spotData.entryTime ? spotData.entryTime : (now - (Math.random() * 120 + 30) * 60000);
            const durationMins = Math.round((now - entryMs) / 60000);
            const hours = durationMins / 60;
            const fee = parseFloat((hours * state.currentRate).toFixed(2));
            state.todayRevenue += fee;
            data.fee = fee;
            data.duration = durationMins >= 60 ? `${Math.floor(durationMins / 60)}h ${durationMins % 60}m` : `${durationMins}m`;
        }
        
        // Format time properly
        data.time = new Date(data.timestamp).toISOString().substr(11, 8);
        renderALPREntry(data);
        updateStats();
    });

    socket.on('pricing_update', (pricingData) => {
        state.currentRate = pricingData.currentRate;
        state.forceSurge = pricingData.forceSurge;
        renderPricingFromState(pricingData);
    });

    socket.on('arch_status', (archData) => {
        state.cameraOffline = archData.cameraOffline;
        renderArchitecture();
        updateLiveIndicator();
    });

    // ─── Helpers ───────────────────────────────────────
    function formatTime(date) {
        return date.toISOString().substr(11, 8);
    }
    
    function clamp(val, min, max) {
        return Math.min(Math.max(val, min), max);
    }

    function escapeHTML(value) {
        const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
        return String(value ?? '').replace(/[&<>"']/g, character => entities[character]);
    }

    // ─── Rendering: Parking Map ────────────────────────
    function initSpotsUI() {
        const grid = $('#parking-map');
        grid.innerHTML = '';
        
        // 4 zones
        const zones = [
            { id: 'A', name: 'VIP', class: 'vip' },
            { id: 'B', name: 'Standard 1', class: 'standard' },
            { id: 'C', name: 'Standard 2', class: 'standard' },
            { id: 'D', name: 'EV Charging', class: 'ev' }
        ];
        
        zones.forEach(z => {
            const zoneEl = document.createElement('div');
            zoneEl.className = `zone zone-${z.id.toLowerCase()}`;
            zoneEl.innerHTML = `
                <div class="zone-title">
                    <span class="zone-type-badge">${z.id}</span>
                    ${z.name} Zone
                </div>
                <div class="zone-spots" id="zone-${z.id}-spots"></div>
            `;
            grid.appendChild(zoneEl);
        });

        // Populate spots
        Object.keys(state.spots).sort().forEach(id => {
            const zId = id.charAt(0);
            const spotEl = document.createElement('div');
            const spotData = state.spots[id];
            
            // Set base class depending on zone
            let typeClass = 'free';
            if (zId === 'A') typeClass += ' reserved';
            if (zId === 'D') typeClass += ' ev-charging';
            
            if (spotData.status === 'occupied') {
                typeClass = 'occupied';
                if (zId === 'A') typeClass += ' reserved';
                if (zId === 'D') typeClass += ' ev-charging';
            }

            spotEl.className = `spot ${typeClass}`;
            spotEl.id = `spot-${id}`;
            spotEl.innerHTML = `
                <div class="spot-id">${id}</div>
                <div class="spot-status-icon">${spotData.status === 'occupied' ? 'P' : ''}</div>
                <div class="spot-plate" style="font-size: 0.55rem; color: var(--text-bright); z-index: 2; position: absolute; bottom: 2px;">${spotData.vehicle || ''}</div>
            `;
            
            // Find its zone and append
            const zoneContainer = $(`#zone-${zId}-spots`);
            if (zoneContainer) zoneContainer.appendChild(spotEl);
        });

        // Add legends
        const legend = $('#zone-legend');
        legend.innerHTML = `
            <div class="legend-item"><span class="legend-color" style="background:var(--emerald-glow)"></span> Free</div>
            <div class="legend-item"><span class="legend-color" style="background:var(--red-glow)"></span> Occupied</div>
            <div class="legend-item"><span class="legend-color" style="background:var(--blue-glow)"></span> VIP</div>
            <div class="legend-item"><span class="legend-color" style="background:var(--purple-glow)"></span> EV</div>
        `;
    }

    function updateSpotDOM(spotId) {
        const el = $(`#spot-${spotId}`);
        if (!el) return;
        const s = state.spots[spotId];
        
        if (s.status === 'occupied') el.classList.add('occupied');
        else el.classList.remove('occupied');
        
        el.querySelector('.spot-status-icon').textContent = s.status === 'occupied' ? 'P' : '';
        el.querySelector('.spot-plate').textContent = s.vehicle || '';
        
        // Flash animation
        el.style.transform = 'scale(1.1)';
        el.style.boxShadow = s.status === 'occupied' ? '0 0 15px var(--red-glow)' : '0 0 15px var(--emerald-glow)';
        setTimeout(() => {
            el.style.transform = '';
            el.style.boxShadow = '';
        }, 400);
    }

    // ─── Rendering: Stats ──────────────────────────────
    function updateStats() {
        const total = Object.keys(state.spots).length;
        const occupied = Object.values(state.spots).filter(s => s.status === 'occupied').length;
        
        const statTotal = $('#stat-total-val');
        const statOcc = $('#stat-occupied-val');
        const statAvail = $('#stat-available-val');
        const statRev = $('#stat-revenue-val');

        if (statTotal) statTotal.textContent = total;
        if (statOcc) statOcc.textContent = occupied;
        if (statAvail) statAvail.textContent = total - occupied;
        
        // Format revenue
        if (statRev) {
            statRev.textContent = '$' + state.todayRevenue.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2});
        }
    }

    // ─── Rendering: ALPR Feed ──────────────────────────
    function renderALPREntry(event) {
        const feed = $('#alpr-feed');
        const entry = document.createElement('div');
        entry.className = 'alpr-entry';
        const safePlate = escapeHTML(event.plate);
        const safeVehicleType = escapeHTML(event.vehicleType);
        const safeSpot = escapeHTML(event.spot);
        const safeDirection = escapeHTML(event.direction);
        const safeTime = escapeHTML(event.time);
        const safeDuration = escapeHTML(event.duration);
        
        // Slide down animation
        entry.style.opacity = '0';
        entry.style.transform = 'translateY(-10px)';
        entry.style.transition = 'all 0.3s ease';

        const directionColor = event.direction === 'ENTRY' ? 'var(--emerald)' : 'var(--amber)';
        const directionIcon = event.direction === 'ENTRY' ? '↘' : '↗';
        const feeHTML = event.fee ? `<div style="font-size: 0.75rem; color: var(--emerald); font-weight: bold;">+$${event.fee.toFixed(2)}</div>` : '';
        const durHTML = event.duration ? `<div style="font-size: 0.7rem; color: var(--text-muted);">${safeDuration}</div>` : '';

        entry.innerHTML = `
            <div class="alpr-camera">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
            </div>
            <div class="alpr-details">
                <div class="alpr-plate">${safePlate}</div>
                <div class="alpr-meta">${safeVehicleType} • Spot ${safeSpot}</div>
            </div>
            <div class="alpr-direction">
                <div style="color: ${directionColor}; font-weight: bold; display: flex; align-items: center; gap: 4px;">
                    ${directionIcon} ${safeDirection}
                </div>
                ${durHTML}
                ${feeHTML}
            </div>
            <div class="alpr-time">${safeTime}</div>
        `;

        feed.insertBefore(entry, feed.firstChild);
        
        // Trigger reflow
        void entry.offsetWidth;
        entry.style.opacity = '1';
        entry.style.transform = 'translateY(0)';

        // Keep only top 20
        if (feed.children.length > 20) {
            feed.removeChild(feed.lastChild);
        }
    }

    // ─── Rendering: Pricing ────────────────────────────
    function renderPricingFromState(pricing) {
        const container = $('#pricing-content');
        
        let rateColor = 'var(--emerald)';
        if (pricing.surge > 1.4 || pricing.forceSurge) rateColor = 'var(--amber)';
        if (pricing.surge > 2.0 || pricing.forceSurge) rateColor = 'var(--red)';

        const gaugePercent = pricing.forceSurge ? 100 : clamp((pricing.occupied / pricing.total) * 100, 2, 100);

        container.innerHTML = `
            <div class="pricing-current">
                <span class="pricing-currency">$</span>
                <span class="pricing-amount" style="color: ${rateColor}">${pricing.currentRate.toFixed(2)}</span>
                <span style="font-size: 0.8rem; color: var(--text-muted)">/ hr</span>
            </div>
            
            <div class="pricing-factors">
                <div class="pricing-factor">
                    <span>Base Rate</span>
                    <span>$${pricing.baseRate.toFixed(2)}</span>
                </div>
                <div class="pricing-factor">
                    <span>Dynamic Surge Multiplier</span>
                    <span style="color: ${rateColor}">x${pricing.surge.toFixed(2)}</span>
                </div>
                <div class="pricing-factor">
                    <span>Facility Utilization</span>
                    <span>${Math.round((pricing.occupied / pricing.total) * 100)}%</span>
                </div>
            </div>

            <div class="surge-gauge">
                <div class="surge-fill" style="width: ${gaugePercent}%; background: ${rateColor}"></div>
            </div>
            <div style="font-size: 0.7rem; color: var(--text-muted); text-align: right; margin-top: 4px;">
                AI Optimization Active
            </div>
        `;
    }

    // ─── Rendering: Architecture Status ────────────────
    function renderArchitecture() {
        const container = $('#architecture-content');
        const edgeStatus = state.cameraOffline ? '<span class="badge badge-red" style="margin-top:4px">⚠ Offline</span>' : '<span class="badge badge-green" style="margin-top:4px">● Online</span>';
        const lineStyle = state.cameraOffline ? 'background: rgba(239, 68, 68, 0.3); animation: none;' : '';
        const lineAfter = state.cameraOffline ? 'display: none;' : '';
        
        container.innerHTML = `
            <style>
                #arch-line-edge { ${lineStyle} }
                #arch-line-edge::after { ${lineAfter} }
            </style>
            <div class="arch-tiers">
                <div class="arch-node edge" style="${state.cameraOffline ? 'border-color: var(--red); opacity: 0.8;' : ''}">
                    <div class="arch-node-icon">📡</div>
                    <div class="arch-node-name">Edge</div>
                    <div class="arch-node-desc">ALPR Cameras & IoT Sensors</div>
                    ${edgeStatus}
                </div>
                <div class="arch-connector">
                    <div class="arch-connector-line" id="arch-line-edge"></div>
                    <span class="arch-connector-label">MQTT/TLS</span>
                </div>
                <div class="arch-node dew">
                    <div class="arch-node-icon">🖥️</div>
                    <div class="arch-node-name">Dew</div>
                    <div class="arch-node-desc">Local Mosquitto MQTT</div>
                    <span class="badge badge-green" style="margin-top:4px">● Synced</span>
                </div>
                <div class="arch-connector">
                    <div class="arch-connector-line"></div>
                    <span class="arch-connector-label">Node.js WebSockets</span>
                </div>
                <div class="arch-node cloud">
                    <div class="arch-node-icon">☁️</div>
                    <div class="arch-node-name">Gateway</div>
                    <div class="arch-node-desc">Express + Socket.io</div>
                    <span class="badge badge-green" style="margin-top:4px">● Connected</span>
                </div>
            </div>
            <div class="arch-stats">
                <div class="arch-stat">
                    <span class="arch-stat-value" id="arch-latency">${state.cameraOffline ? 'ERR' : '18ms'}</span>
                    <span class="arch-stat-label">Packet Latency</span>
                </div>
                <div class="arch-stat">
                    <span class="arch-stat-value" id="arch-uptime">${state.cameraOffline ? '99.96%' : '99.97%'}</span>
                    <span class="arch-stat-label">Uptime</span>
                </div>
                <div class="arch-stat">
                    <span class="arch-stat-value" id="arch-devices">${state.cameraOffline ? '0' : '1'}</span>
                    <span class="arch-stat-label">Active Edges</span>
                </div>
            </div>
        `;
    }

    // ─── Utility ───────────────────────────────────────
    function updateClock() {
        const now = new Date();
        const clockEl = $('#header-time');
        if (clockEl) {
            clockEl.textContent = now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) + 
                                  ' • ' + now.toLocaleTimeString('en-US');
        }
    }

    // ─── Sidebar Logic ─────────────────────────────────
    function initSidebar() {
        const sidebar = $('.sidebar');
        const overlay = document.createElement('div');
        overlay.className = 'sidebar-overlay';
        document.body.appendChild(overlay);

        const toggleBtn = $('#sidebar-toggle');
        if (toggleBtn) {
            toggleBtn.addEventListener('click', () => {
                sidebar.classList.add('open');
                overlay.classList.add('active');
            });
        }

        overlay.addEventListener('click', () => {
            sidebar.classList.remove('open');
            overlay.classList.remove('active');
        });

        // Nav active state & View Switching
        $$('.nav-item').forEach(item => {
            item.addEventListener('click', (e) => {
                e.preventDefault();
                const targetView = item.getAttribute('data-section');
                
                $$('.nav-item').forEach(n => n.classList.remove('active'));
                item.classList.add('active');
                
                // Switch Views
                $$('.widget').forEach(widget => {
                    const views = widget.getAttribute('data-views') || '';
                    if (views && views.includes(targetView)) {
                        widget.style.display = '';
                    } else {
                        widget.style.display = 'none';
                    }
                });

                // Close mobile sidebar
                sidebar.classList.remove('open');
                overlay.classList.remove('active');
            });
        });
    }

    // ─── IoT Simulation Handlers ───────────────────────
    function initIoTSimulation() {
        const btnSurge = $('#btn-sim-surge');

        // Request Server overrides
        if (btnSurge) {
            btnSurge.addEventListener('click', () => {
                state.forceSurge = !state.forceSurge;
                btnSurge.classList.toggle('active');
                socket.emit('manual_override', { type: 'force_surge', value: state.forceSurge });
            });
        }

        const btnOffline = $('#btn-sim-offline');
        if (btnOffline) btnOffline.addEventListener('click', function() {
            state.cameraOffline = !state.cameraOffline;
            this.classList.toggle('active');
            socket.emit('manual_override', { type: 'toggle_camera', value: state.cameraOffline });
            renderArchitecture();
            updateLiveIndicator();
        });
        
        // Helper for generating fake plates
        function generateFakePlate() {
            const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
            const rndL = () => letters[Math.floor(Math.random()*letters.length)];
            const rndD = () => Math.floor(Math.random()*10);
            return `${rndL()}${rndL()} ${rndD()}${rndD()} ${rndL()}${rndL()} ${Math.floor(Math.random()*9000)+1000}`;
        }

        // Helper for firing ALPR event
        function triggerALPREvent(direction) {
            const zones = ['A','B','C','D'];
            const spot = zones[Math.floor(Math.random()*zones.length)] + String(Math.floor(Math.random()*12)+1).padStart(2, '0');
            const payload = {
                spot: spot,
                direction: direction,
                plate: generateFakePlate(),
                vehicleType: 'Sedan',
                timestamp: Date.now()
            };
            fetch('/api/alpr', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            }).then(res => res.json()).then(data => console.log('Simulated ALPR:', data))
              .catch(err => console.error('Sim error:', err));
        }

        const btnEntry = $('#btn-sim-entry');
        if (btnEntry) btnEntry.addEventListener('click', () => triggerALPREvent('ENTRY'));
        
        const btnExit = $('#btn-sim-exit');
        if (btnExit) btnExit.addEventListener('click', () => triggerALPREvent('EXIT'));

        // Keyboard shortcuts for E and X
        document.addEventListener('keydown', (e) => {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
            const key = e.key.toLowerCase();
            if (key === 'e') {
                if (btnEntry) {
                    btnEntry.style.transform = 'scale(0.95)';
                    setTimeout(() => btnEntry.style.transform = '', 150);
                    btnEntry.click();
                }
            }
            if (key === 'x') {
                if (btnExit) {
                    btnExit.style.transform = 'scale(0.95)';
                    setTimeout(() => btnExit.style.transform = '', 150);
                    btnExit.click();
                }
            }
        });
    }

    // ─── Charts (Dummy Data for UI) ────────────────────
    function initCharts() {
        const occCtx = document.getElementById('occupancy-chart');
        const revCtx = document.getElementById('revenue-chart');
        
        if (occCtx) {
            new Chart(occCtx, {
                type: 'line',
                data: {
                    labels: Array.from({length: 24}, (_, i) => `${i}:00`),
                    datasets: [{
                        label: 'Predicted Occupancy',
                        data: Array.from({length: 24}, () => Math.floor(Math.random() * 40 + 5)),
                        borderColor: '#8b5cf6',
                        backgroundColor: 'rgba(139, 92, 246, 0.1)',
                        borderWidth: 2,
                        fill: true,
                        tension: 0.4
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: { legend: { display: false } },
                    scales: {
                        y: { display: false, min: 0, max: 50 },
                        x: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#8896b3', maxTicksLimit: 8 } }
                    }
                }
            });
        }

        if (revCtx) {
            new Chart(revCtx, {
                type: 'bar',
                data: {
                    labels: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
                    datasets: [{
                        label: 'Revenue',
                        data: [420, 580, 490, 610, 850, 920, 780],
                        backgroundColor: '#10b981',
                        borderRadius: 4
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: { legend: { display: false } },
                    scales: {
                        y: { display: false },
                        x: { grid: { display: false }, ticks: { color: '#8896b3' } }
                    }
                }
            });
        }
    }

    // ─── Boot ──────────────────────────────────────────
    function boot() {
        setInterval(updateClock, 1000);
        updateClock();
        initSidebar();
        initIoTSimulation();
        initCharts();
    }

    boot();
});
