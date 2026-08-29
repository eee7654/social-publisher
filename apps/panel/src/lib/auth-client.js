// lib/auth-client.ts
import { createAuthClient } from "better-auth/react";
import { phoneNumberClient, usernameClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
    baseURL: process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000", 
    plugins: [
        phoneNumberClient(),
        usernameClient(),
    ],
    fetchOptions: {
        credentials: "include", 
        onError: async (context) => {
            const { response } = context;
            if (response.status === 429) {
                console.warn("🚨 Too many auth requests!");
            }
        }
    }
});