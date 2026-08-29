import { createRouter } from 'next-connect';
import { requireAuth } from '@/middlewares/requireAuth';

/**
 * سازنده روتر پایه با پشتیبانی از تنظیمات داینامیک
 * @param {Object} options تنظیمات روتر
 * @param {boolean} options.auth آیا این مسیر نیاز به احراز هویت دارد؟ (پیش‌فرض: false)
 */
export function createBaseRouter(options = { auth: false }) {
    const router = createRouter();
    if (options.auth) {
        router.use(requireAuth);
    }
    return router;
}