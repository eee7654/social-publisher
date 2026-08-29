"use client";

import { useEffect } from 'react';
import { App } from 'antd';
import { useAtomValue } from 'jotai';
import { dictAtom } from '@/store/i18nAtom';

export default function GlobalErrorHandler() {
    const { message } = App.useApp();
    const dict = useAtomValue(dictAtom);
    useEffect(() => {
        const handleApiError = (event) => {
            const { code, status } = event.detail;
            const errorMessage = dict.errors?.[code];
            if (status === 403) {
                message.warning(errorMessage);
            } else {
                message.error(errorMessage);
            }
        };
        window.addEventListener('api_error', handleApiError);
        return () => window.removeEventListener('api_error', handleApiError);
    }, [message, dict]);
    return null;
}