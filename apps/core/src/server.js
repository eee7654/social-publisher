import "dotenv/config";
import express from 'ultimate-express';
import path from 'path';
import cluster from 'cluster';
import os from 'os';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

import { routeHandler } from '@/routes';

var allowedOrigins = [process.env.DASHBOARD_URL || "http://localhost:3000"]

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

    app.use('/storage', express.static(path.join(process.cwd(), "/storage")));

    app.use(helmet());

    app.use(apiLimiter);

    app.use(cors({
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
    }));

    app.use(express.json())

    app.get('/', coreHandler);

    app.all('/*', coreHandler);

    app.listen(PORT, (token) => {
        if (token) {
            console.log(`🚀 Worker [${process.pid}] is running Esima Core on port ${PORT}`);
        } else {
            console.log(`❌ Worker [${process.pid}] failed to start on port ${PORT}`);
        }
    });
}