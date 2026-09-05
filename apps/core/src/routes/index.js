import { createRouter } from "next-connect";


import authRoutes from './auth';
import panelRoutes from './panel';
import publisherRoutes from './publisher/index.js';
import youtubeRoutes from './youtube.js';
import linkedinRoutes from './linkedin.js';
import aparatRoutes from './aparat.js';
import { AppError } from "@/lib/AppError";
import { ForbiddenError } from "@casl/ability";
import { ErrorCodes } from "@/constants/responseCodes";

import db from "@/config/database.js";
import { getNatsConnection } from "@/services/messaging/nats.js";
import { checkBucketAccess } from "@/services/storage/s3.js";
import { checkTelegramHealth } from "@/publisher/telegram/api.js";

const mainRouter = createRouter();

mainRouter.use('/api/auth', authRoutes)

mainRouter.use('/api/v1/panel', panelRoutes)

mainRouter.use('/api/v1/publisher', publisherRoutes)

mainRouter.use('/api/youtube', youtubeRoutes)

mainRouter.use('/api/linkedin', linkedinRoutes)

mainRouter.use('/api/aparat', aparatRoutes)

mainRouter.get('/api/v1/health', async (req, res) => {
    let dbOk = false;
    try {
        await db().raw('SELECT 1');
        dbOk = true;
    } catch (err) {
        console.error('Health check DB error:', err);
    }

    // Check NATS (just verifying if the singleton connection exists and isn't closed)
    const nc = getNatsConnection();
    const natsOk = nc !== null && !nc.isClosed();

    // Check S3
    const s3Ok = await checkBucketAccess();

    const telegramHealth = await checkTelegramHealth().catch((err) => ({
        mode: process.env.TELEGRAM_BOT_API_MODE || 'cloud',
        telegram_local_api: 'unhealthy',
        telegram_bot: 'unavailable',
        error: err.message,
    }));

    const telegramReady = telegramHealth.mode === 'local'
        ? telegramHealth.telegram_local_api === 'healthy' && telegramHealth.telegram_bot === 'authenticated'
        : true;
    const overallOk = dbOk && natsOk && s3Ok && telegramReady;

    res.status(overallOk ? 200 : 503).json({
        status: overallOk ? 'ok' : 'error',
        liveness: true,
        readiness: overallOk,
        mysql: dbOk,
        nats: natsOk,
        objectStorage: s3Ok,
        telegram_local_api: telegramHealth.telegram_local_api,
        telegram_bot: telegramHealth.telegram_bot,
        telegram: telegramHealth,
        timestamp: new Date().toISOString()
    });
});

mainRouter.get('/api/loadtest', (req, res) => {
    res.status(200).json({
        status: 'success',
        message: 'Hello from Esima Core!',
        worker_pid: process.pid,
        timestamp: Date.now()
    });
});

mainRouter.get('/', (req, res) => {
    res.json({ status: "Esima Core is Running 🚀" });
});

/*mainRouter.all((req, res) => {
    if (!res.headersSent) {
        res.status(404).json({ error: "can't find this route." });
    }
});*/

export const routeHandler = mainRouter.handler({
    onError: (err, req, res) => {
        if (err instanceof AppError) {
            return res.status(err.statusCode).json({
                status: 'error',
                code: err.errorCode
            });
        }
        if (err.name === 'APIError') {
            return res.status(400).json({
                status: 'error',
                code: err.body?.code || 'AUTH_API_ERROR'
            });
        }
        if (err instanceof ForbiddenError) {
            return res.status(403).json({
                status: 'error',
                code: ErrorCodes.GEN_FORBIDDEN_ACCESS, 
            });
        }
        if (err.code === 'ER_DUP_ENTRY' || err.nativeError?.code === '23505') {
            return res.status(400).json({
                status: 'error',
                code: ErrorCodes.DB_DUPLICATE_ENTRY
            });
        }
        console.error(`🔥 [FATAL ERROR] ${req.url}:`, err);
        return res.status(500).json({ 
            status: 'error', 
            code: 'GEN_INTERNAL_ERROR' 
        });
    },
    onNoMatch: (req, res) => {
        if (!res.headersSent) {
            res.status(405).json({ 
                status: 'error', 
                message: `Methid ${req.method} is not allowed for this route.` 
            });
        }
    }
});
