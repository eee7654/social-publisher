import "./bootstrap.js";
import express from 'ultimate-express';
import path from 'path';
import cluster from 'cluster';
import os from 'os';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

import { routeHandler } from '@/routes';
import { initJetStream } from '@/services/messaging/jetstream.js';

var allowedOrigins = [process.env.DASHBOARD_URL || "http://localhost:3000", "http://localhost:4000", "https://publisher-dev.elecio.co"]

const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 500, 
    message: { status: 'rateLimited', message: 'Your requests exceed the limit. Please try again later.' },
    standardHeaders: true, 
    legacyHeaders: false,
});

const maxCores = os.cpus().length;
let numCPUs = 1;

const envWorkerCount = process.env.WORKER_COUNT;

if (envWorkerCount && envWorkerCount.toLowerCase() !== 'max') {
    const parsedCount = parseInt(envWorkerCount, 10);
    if (!isNaN(parsedCount) && parsedCount > 0) {
        numCPUs = Math.min(parsedCount, maxCores);
    }
}

const BASE_PORT = parseInt(process.env.PORT || 4000, 10);

if (cluster.isPrimary) {
    console.log(`👑 Master process [${process.pid}] is running`);
    console.log(`⚙️ Starting ${numCPUs} workers...`);
    const workers = [];
    for (let i = 0; i < numCPUs; i++) {
        const workerPort = BASE_PORT + i;
        const worker = cluster.fork({ WORKER_PORT: workerPort });
        workers.push({ id: worker.id, port: workerPort });
    }
    cluster.on('exit', (worker, code, signal) => {
        console.log(`💀 Worker [${worker.process.pid}] died (Signal: ${signal || code})`);
        const deadWorker = workers.find(w => w.id === worker.id);
        if (deadWorker) {
            console.log(`🔄 Respawning worker for port ${deadWorker.port}...`);
            const newWorker = cluster.fork({ WORKER_PORT: deadWorker.port });
            deadWorker.id = newWorker.id;
        }
    });

} else {
    const PORT = parseInt(process.env.WORKER_PORT, 10);

    const coreHandler = async (req, res) => {
        try {
            await routeHandler(req, res);
        } catch (err) {
            console.error(`Worker [${process.pid}] Critical Error:`, err);
            if (!res.headersSent) res.status(500).json({ error: "Fatal Server Error" });
        }
    };

    const app = express();

    app.set('trust proxy', 1);

    // Note: This static /storage route is preserved for backward compatibility.
    // New Publisher media MUST NOT use local /storage. They must use the S3-compatible storage abstraction.
    app.use('/storage', express.static(path.join(process.cwd(), "/storage")));

    if (process.env.NODE_ENV !== 'production') {
        app.get('/operator/login', (req, res) => {
            res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self';");
            res.send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <title>Operator Login</title>
                    <style>
                        body { font-family: sans-serif; max-width: 400px; margin: 40px auto; padding: 20px; }
                        input, button { display: block; width: 100%; margin-bottom: 10px; padding: 8px; }
                        #status { margin-top: 20px; padding: 10px; background: #f0f0f0; }
                    </style>
                </head>
                <body>
                    <h2>Operator Login (DEV ONLY)</h2>
                    <input type="email" id="email" placeholder="Email" />
                    <input type="password" id="password" placeholder="Password" />
                    <button onclick="login()">Sign In</button>
                    <button onclick="checkSession()">Check Session</button>
                    <div id="status">Status: Waiting...</div>

                    <script>
                        async function login() {
                            const email = document.getElementById('email').value;
                            const password = document.getElementById('password').value;
                            const statusEl = document.getElementById('status');
                            statusEl.innerText = "Status: Logging in...";
                            try {
                                const res = await fetch('/api/auth/sign-in/email', {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ email, password }),
                                    credentials: 'include'
                                });
                                const data = await res.json();
                                if (res.ok) {
                                    statusEl.innerText = "Status: Login successful! Checking session...";
                                    await checkSession();
                                } else {
                                    statusEl.innerText = "Error: " + JSON.stringify(data);
                                }
                            } catch (e) {
                                statusEl.innerText = "Exception: " + e.message;
                            }
                        }
                        
                        async function checkSession() {
                            const statusEl = document.getElementById('status');
                            try {
                                const res = await fetch('/api/auth/get-session', { credentials: 'include' });
                                const data = await res.json();
                                if (res.ok && data.session) {
                                    statusEl.innerHTML = "Status: Authenticated<br>User: " + data.user.email + "<br>ID: " + data.user.id;
                                } else {
                                    statusEl.innerText = "Status: Not authenticated";
                                }
                            } catch (e) {
                                statusEl.innerText = "Exception: " + e.message;
                            }
                        }
                    </script>
                </body>
                </html>
            `);
        });
    }

    app.use(helmet());

    app.use(apiLimiter);

    /*app.use(cors({
        origin: function(origin, callback) {
            if (origin == undefined) return callback(null, true);
            if (allowedOrigins.indexOf(origin) === -1) {
                var msg = 'The CORS policy for this site does not ' +
                    'allow access from the specified Origin.';
                return callback(new Error(msg), false);
            }
            return callback(null, true);
        },
        credentials: true,
        methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
        allowedHeaders: ["Content-Type", "Authorization", "Cookie","x-org-id"]
    }));*/

    app.use(express.json())

    app.get('/', coreHandler);

    app.all('/*', coreHandler);

    app.listen(PORT, async (token) => {
        if (token) {
            console.log(`🚀 Worker [${process.pid}] is running Esima Core on port ${PORT}`);
            // Initialize messaging after listening
            await initJetStream().catch(err => {
                console.error(`Worker [${process.pid}] JetStream init failed:`, err.message);
            });
        } else {
            console.log(`❌ Worker [${process.pid}] failed to start on port ${PORT}`);
        }
    });
}