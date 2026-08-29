"use client";

import { Result, Button } from 'antd';
import { useAtomValue } from 'jotai';
import { dictAtom } from '@/store/i18nAtom';

const ErrComp = ({ errorCode, onBack, className }) => {
    const dict = useAtomValue(dictAtom);
    const statusMap = {
        GEN_FORBIDDEN_ACCESS: '403',
        ORG_NOT_ENOUGH_ACCESS: '403',
        ROLE_INSUFFICIENT_LEVEL: '403',
        
        USER_NOT_FOUND: '404',
        ORG_NOT_FOUND: '404',
        ROLE_NOT_FOUND: '404',
        
        GEN_INTERNAL_ERROR: '500',
    };
    const resultStatus = statusMap[errorCode] || 'error';
    const resultTitle = ['403', '404', '500'].includes(resultStatus) ? resultStatus : 'خطا';
    const resultSubTitle = dict.errors?.[errorCode] || dict.errors?.GEN_UNKNOWN_ERROR;
    return (
        <Result
            status={resultStatus}
            title={resultTitle}
            subTitle={resultSubTitle}
            extra={
                <Button 
                    type="primary" 
                    onClick={onBack || (() => window.history.back())}
                    className="!bg-primary hover:opacity-[0.85] shadow-none rounded-lg"
                >
                    {dict.common?.back}
                </Button>
            }
            className={`bg-bgSurface rounded-2xl shadow-sm border border-borderColor ${className || ''}`}
        />
    );
};

export default ErrComp;