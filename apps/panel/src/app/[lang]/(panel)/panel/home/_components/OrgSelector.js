// app/[lang]/(panel)/panel/home/_components/OrgSelector.js
'use client';

import { useEffect, useState } from 'react';
import Cookies from 'js-cookie';
import { useAtomValue } from 'jotai';
import { dictAtom } from '@/store/i18nAtom';
import { App, Col, Row } from 'antd';

export default function OrgSelector({ lang, memberships }) {
    const [isSelecting, setIsSelecting] = useState(true);
    const dict = useAtomValue(dictAtom);
    const { message } = App.useApp()
    useEffect(() => {
        const currentOrg = Cookies.get('active_org_id');
        const membership = memberships.find(m => m.org_id == currentOrg)
        if (currentOrg && membership) {
            if(membership.is_active){
                return window.location.replace(`/${lang}/panel/home/${membership.role_name}`);
            }
            return setSuspendState(lang === 'en' ? membership.org_slug : membership.org_name)
        }
        if (memberships.length === 1) {
            handleSelectOrg(memberships[0]);
        } else {
            setIsSelecting(false); 
        }
        //setIsSelecting(false); 
    }, [lang, memberships]);

    const setSuspendState = (org_name)=>{
        setIsSelecting(false)
        return message.error(dict.home.orgSelector.inactive_org.replace('{name}', org_name))
    }

    const handleSelectOrg = (membership) => {
        if(!membership.is_active){
            return setSuspendState(lang === 'en' ? membership.org_slug : membership.org_name)
        }
        Cookies.set('active_org_id', membership.org_id, { path: '/' });
        window.location.replace(`/${lang}/panel/home/${membership.role_name}`);
    };

    if (isSelecting) {
        return (
            <div className="flex h-screen w-full flex-col items-center justify-center bg-bgBase">
                <i className="bi bi-arrow-repeat animate-spin text-4xl text-primary mb-4" />
                <span className="text-textBase font-medium">{dict.home.orgSelector.redirecting}</span>
            </div>
        );
    }

    return (
        <Row justify={'center'} align={'middle'} className='!w-full'>
            <Col xs={24} md={18} lg={12}>
                <div className="w-full w-full bg-bgSurface border border-borderColor rounded-xl shadow-[0_8px_30px_rgb(0,0,0,0.04)] dark:shadow-[0_8px_30px_rgb(0,0,0,0.1)] p-6 md:p-8 z-10">
                    <div className="text-center mb-8">
                        <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-primary/10 text-primary mb-4">
                            <i className="bi bi-buildings-fill text-3xl" />
                        </div>
                        <h1 className="text-xl md:text-2xl font-bold text-textBase mb-3">
                            {dict.home.orgSelector.title}
                        </h1>
                        <p className="text-textMuted text-sm md:text-base leading-relaxed max-w-sm mx-auto">
                            {dict.home.orgSelector.description}
                        </p>
                    </div>
                    <div className="space-y-3 max-h-[50vh] overflow-y-auto hide-scrollbar pe-1">
                        {memberships.map((item) => (
                            <div 
                                key={item.org_id}
                                onClick={() => handleSelectOrg(item)}
                                className={`group flex flex-col sm:flex-row sm:items-center justify-between p-4 rounded-xl border border-borderColor bg-bgBase  cursor-pointer transition-all duration-300 hover:shadow-sm ${item.is_active ? 'hover:border-primary' : 'hover:border-accent opacity-[0.85]'}`}
                            >
                                <div className="flex items-center gap-4 mb-3 sm:mb-0">
                                    <div className={`flex items-center justify-center w-10 h-10 rounded-full bg-bgSurface border border-borderColor text-textMuted ${item.is_active ? 'group-hover:text-primary' : 'group-hover:text-accent'} group-hover:bg-primary/5 transition-colors`}>
                                        <i className="bi bi-building text-lg" />
                                    </div>
                                    <div className="flex flex-col">
                                        <span className={`font-bold text-textBase ${item.is_active ? 'group-hover:text-primary' : 'group-hover:text-accent'} transition-colors`}>
                                            {lang === 'en' ? item.org_slug : item.org_name}
                                        </span>
                                        {/*<span className="text-xs text-textMuted mt-0.5">
                                            {lang === 'en' ? `${item.org_slug}.domain.com` : 'پورتال اختصاصی'}
                                        </span>*/}
                                    </div>
                                </div>
                                <div className="flex items-center bg-bgSurface border border-borderColor px-3 py-1.5 rounded-lg">
                                    <span className="text-xs text-textMuted me-2">
                                        {dict.home.orgSelector.rolePrefix}
                                    </span>
                                    <span className="text-sm font-semibold text-textBase">
                                        {lang === 'en' ? item.role_name : item.role_label}
                                    </span>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            </Col>
        </Row>
    );
}