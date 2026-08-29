import { createRouter } from "next-connect";


import authRoutes from './auth';
import panelRoutes from './panel';
import { AppError } from "@/lib/AppError";
import { ForbiddenError } from "@casl/ability";
import { ErrorCodes } from "@/constants/responseCodes";

const mainRouter = createRouter();

mainRouter.use('/api/auth', authRoutes)

mainRouter.use('/api/v1/panel', panelRoutes)

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