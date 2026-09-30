const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');

const port = 3199;
const baseUrl = `http://127.0.0.1:${port}`;
const serverPath = path.join(__dirname, '..', 'server', 'server.js');

const child = spawn(process.execPath, [serverPath], {
    env: {
        ...process.env,
        PORT: String(port),
        DISABLE_SIMULATORS: 'true'
    },
    stdio: ['ignore', 'pipe', 'pipe']
});

let serverOutput = '';
child.stdout.on('data', chunk => { serverOutput += chunk.toString(); });
child.stderr.on('data', chunk => { serverOutput += chunk.toString(); });

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function waitForServer() {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(`${baseUrl}/api/health`);
            if (response.ok) return;
        } catch {
            // The server may still be starting.
        }
        await wait(150);
    }
    throw new Error(`Server did not become ready.\n${serverOutput}`);
}

async function post(pathname, body) {
    return fetch(`${baseUrl}${pathname}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
}

async function run() {
    try {
        await waitForServer();

        const dashboard = await fetch(baseUrl);
        assert.equal(dashboard.status, 200);
        assert.match(await dashboard.text(), /SmartPark AI/);

        const health = await fetch(`${baseUrl}/api/health`);
        assert.equal(health.status, 200);
        assert.equal((await health.json()).status, 'ok');

        const validEvent = await post('/api/alpr', {
            spot: 'A01',
            direction: 'ENTRY',
            plate: 'KA 01 AB 1234',
            vehicleType: 'Sedan',
            timestamp: Date.now()
        });
        assert.equal(validEvent.status, 200);

        const invalidEvent = await post('/api/spots', {
            spot: 'Z99',
            status: 'occupied'
        });
        assert.equal(invalidEvent.status, 400);

        console.log('SmartPark smoke test passed.');
    } finally {
        child.kill();
    }
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
