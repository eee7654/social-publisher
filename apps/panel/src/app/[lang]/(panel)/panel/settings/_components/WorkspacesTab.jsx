"use client";

import { useAtomValue } from 'jotai';
import { dictAtom, langAtom } from '@/store/i18nAtom';
import { App, Tag } from 'antd';
import Cookies from 'js-cookie';

export default function WorkspacesTab({ memberships }) {
    const dict = useAtomValue(dictAtom);
    const lang = useAtomValue(langAtom);
    const { message } = App.useApp();
    
    const currentOrgId = Cookies.get('active_org_id');

    const handleSelectOrg = (membership) => {
        const orgName = lang === 'en' ? membership.org_slug : membership.org_name;
        if (!membership.is_active) {
            const errorMsg = dict.settings?.workspaces?.inactiveToast?.replace('{name}', orgName);
            return message.error(errorMsg);
        }
        if (membership.org_id == currentOrgId) {
            return message.info(dict.settings?.workspaces?.alreadyActiveToast);
        }
        Cookies.set('active_org_id', membership.org_id, { path: '/' });
        message.loading(dict.settings?.workspaces?.redirectingToast, 1);
        setTimeout(() => {
            window.location.replace(`/${lang}/panel/home/${membership.role_name}`);
        }, 500);
    };
    if (!memberships || memberships.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center py-12 text-textMuted">
                <i className="bi bi-inboxes text-4xl mb-3 opacity-50"></i>
                <p>{dict.settings?.workspaces?.emptyDesc}</p>
            </div>
        );
    }

    return (
        <div className="space-y-3 max-w-3xl mx-auto py-2">
            {memberships.map((item) => {
                const isActiveWorkspace = item.org_id == currentOrgId;

                return (
                    <div 
                        key={item.org_id}
                        onClick={() => handleSelectOrg(item)}
                        className={`group flex flex-col sm:flex-row sm:items-center justify-between p-4 rounded-xl border bg-bgBase transition-all duration-300 ${
                            isActiveWorkspace 
                                ? 'border-primary shadow-sm bg-primary/5 cursor-default' 
                                : item.is_active 
                                    ? 'border-borderColor cursor-pointer hover:border-primary hover:shadow-sm' 
                                    : 'border-borderColor cursor-not-allowed opacity-[0.7]'
                        }`}
                    >
                        <div className="flex items-center gap-4 mb-3 sm:mb-0">
                            <div className={`flex items-center justify-center w-12 h-12 rounded-full border transition-colors ${
                                isActiveWorkspace 
                                    ? 'bg-primary text-white border-primary' 
                                    : item.is_active 
                                        ? 'bg-bgSurface border-borderColor text-textMuted group-hover:text-primary group-hover:bg-primary/10' 
                                        : 'bg-bgSurface border-borderColor text-textMuted'
                            }`}>
                                <i className="bi bi-building text-xl" />
                            </div>
                            <div className="flex flex-col">
                                <span className={`font-bold text-base transition-colors ${
                                    isActiveWorkspace 
                                        ? 'text-primary' 
                                        : item.is_active 
                                            ? 'text-textBase group-hover:text-primary' 
                                            : 'text-textMuted'
                                }`}>
                                    {lang === 'en' ? item.org_slug : item.org_name}
                                </span>
                                {isActiveWorkspace && (
                                    <span className="text-xs text-primary font-medium mt-0.5">
                                        <i className="bi bi-check-circle-fill me-1"></i>
                                        {dict.settings?.workspaces?.activeLabel}
                                    </span>
                                )}
                            </div>
                        </div>

                        <div className="flex items-center gap-3">
                            <div className="flex items-center bg-bgSurface border border-borderColor px-3 py-1.5 rounded-lg">
                                <span className="text-xs text-textMuted me-2">
                                    {dict.settings?.workspaces?.rolePrefix}
                                </span>
                                <span className="text-sm font-semibold text-textBase">
                                    {lang === 'en' ? item.role_name : item.role_label}
                                </span>
                            </div>
                            {!item.is_active && (
                                <Tag color="error" className="m-0 border-none">
                                    {dict.settings?.workspaces?.inactiveTag}
                                </Tag>
                            )}
                        </div>
                    </div>
                );
            })}
        </div>
    );
}