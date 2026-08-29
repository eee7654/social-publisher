import { apiClient } from './api-client';

/**
 * کلاینت یکپارچه برای تمام درخواست‌های سیستم
 * @param {Object} options 
 * @param {'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'} options.method 
 * @param {string} options.url 
 * @param {Object} [options.data] - برای بادی (POST/PATCH)
 * @param {Object} [options.params] - برای کوئری استرینگ (GET)
 */
export const fetcher = async ({ method = 'GET', url, data = null, params = null, headers = null }) => {
    try {
        const response = await apiClient({
            method,
            url,
            headers,
            params,
            data,
        });
        return response.data;
    } catch (error) {
        throw error.customCode;
    }
};