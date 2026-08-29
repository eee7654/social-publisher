import axios from "axios";
import { authClient } from "./auth-client";
import Cookies from "js-cookie";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

export const apiClient = axios.create({
  baseURL: API_URL,
  withCredentials: true,
});

apiClient.interceptors.request.use(
    (config) => {
        const activeOrgId = Cookies.get('active_org_id');
        if (activeOrgId) {
            config.headers['x-org-id'] = activeOrgId;
        }
        return config;
    },
    (error) => Promise.reject(error)
);

apiClient.interceptors.response.use(
    (response) => response,
    async (error) => {
        const originalRequest = error.config;
        const backendError = error.response?.data;
        error.customCode = backendError?.code || 'GEN_UNKNOWN_ERROR';  
        if (error.response?.status === 401 && !originalRequest._retry) {
            originalRequest._retry = true;
            try {
                console.log("🔄 Attempting to refresh session...");
                const { data: session, error: sessionError } = await authClient.getSession();        
                if (session && !sessionError) {
                    return apiClient(originalRequest);
                }
                throw new Error("Session expired or invalid");
            } catch (err) {
                if (typeof window !== "undefined") {
                    Cookies.remove('active_org_id', { path: '/' });
                    const pathParts = window.location.pathname.split('/');
                    const currentLang = (pathParts[1] === 'en' || pathParts[1] === 'fa') ? pathParts[1] : 'fa'; 
                    const callback = encodeURIComponent(window.location.pathname + window.location.search);
                    const redirectUrl = `/${currentLang}/auth/login?reason=expired&callbackURL=${callback}`;
                    window.location.replace(redirectUrl);
                }
                return Promise.reject(err);
            }
        }
        if (typeof window !== "undefined" && error.response) {
            if (!originalRequest.silent) {
                const event = new CustomEvent('api_error', { 
                    detail: { 
                        code: error.customCode,
                        status: error.response.status
                    } 
                });
                window.dispatchEvent(event);
            }
        }
        return Promise.reject(error);
    }
);

export default apiClient;