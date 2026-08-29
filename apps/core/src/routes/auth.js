import { createRouter } from 'next-connect';
import { toNodeHandler } from 'better-auth/node';
import { auth } from '@/config/auth';

const router = createRouter();

router.all('/*', async (req, res) => {
    const handler = toNodeHandler(auth);
    return await handler(req, res);
});

export default router;