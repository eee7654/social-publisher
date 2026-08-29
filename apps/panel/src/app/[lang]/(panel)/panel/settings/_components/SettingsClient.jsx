"use client"
import '../style.css'
import { Flex, Card, Col, Row, Button, Tabs, App, Popconfirm } from "antd";
import { useState } from "react";
import { useAtomValue } from "jotai";
import { dictAtom, langAtom } from "@/store/i18nAtom";
import { userAtom } from "@/store/authAtom";
import { authClient } from '@/lib/auth-client';
import NProgress from 'nprogress';
import Cookies from 'js-cookie';
import DevicesTab from './DeviceTab';
import ProfileTab from "./ProfileTab";
import WorkspacesTab from './WorkspacesTab';


const SettingsPage = () => { 
    const { message } = App.useApp();
    const dict = useAtomValue(dictAtom);
    const lang = useAtomValue(langAtom);
    const profileData = useAtomValue(userAtom)
    const [activeTab, setActiveTab] = useState("1");

    const onLogout = async () => {
        try {
            await authClient.signOut();
            Cookies.remove('active_org_id', { path: '/' });
            message.success(dict.settings.logout.success);
            NProgress.start()
            window.location.replace(`/${lang}/auth/login`);
        } catch (error) {
            console.error(error);
            message.error(dict.errors[error.customCode ?? 'GEN_INTERNAL_ERROR']);
        }
    };

    return (
        <div className="container px-3 py-3 md:py-6 max-[640px]:h-[100%]">
            <Row align="middle" gutter={[16,16]} justify="center">
                <Col xs={24} sm={24} md={24} lg={20} xl={18} xxl={16}>
                    <Card
                        className="w-full !bg-bgSurface !border-borderColor shadow-sm !rounded-xl overflow-hidden"
                        classNames={{
                            header: '!border-none !py-2',
                            body: '!h-[calc(100vh-92px-4rem)] !py-[8px]'
                        }}
                        title={
                            <Flex justify="start" align="center" className="text-textBase text-lg font-bold">
                                <i className="bi bi-gear me-2 grid" />
                                {dict.settings.pageTitle}
                            </Flex>
                        }
                        extra={
                            <Popconfirm
                                title={<span className="text-textBase">{dict.settings.logout.confirmTitle}</span>}
                                description={<span className="text-textMuted">{dict.settings.logout.confirmDesc}</span>}
                                okText={dict.settings.logout.yes}
                                cancelText={dict.settings.logout.no}
                                onConfirm={onLogout}
                                okButtonProps={{ danger: true, type: 'primary', className: 'shadow-none' }}
                                cancelButtonProps={{ className: 'shadow-none' }}
                                placement="bottomRight"
                                styles={{ container: { borderRadius: '8px' } }}
                            >
                                <Button
                                    danger
                                    type={'default'}
                                    className="!bg-accent rounded-lg !text-textBase !shadow-none"
                                    icon={<i className="bi bi-box-arrow-left grid" />}
                                >
                                    {dict.settings.logout.button}
                                </Button>
                            </Popconfirm>
                        }
                    >
                        <Tabs
                            tabPlacement="top"
                            type="line"
                            activeKey={activeTab}
                            onChange={(key) => setActiveTab(key)}
                            className="custom-settings-tabs !h-full flex flex-col"
                            items={[
                                {
                                    key: "1",
                                    label: (
                                        <Flex justify="center" align="center" className="min-w-[120px] py-2">
                                            <i className="bi bi-person-lines-fill !me-2 text-lg" />
                                            {dict.settings.tabs.profile}
                                        </Flex>
                                    ),
                                    children: (
                                        <div className="p-4">
                                            <ProfileTab profileData={profileData} />
                                        </div>
                                    )
                                },
                                {
                                    key: "2",
                                    label: (
                                        <Flex justify="center" align="center" className="min-w-[120px] py-2">
                                            <i className="bi bi-buildings-fill !me-2 text-lg" />
                                            {dict.settings.tabs.workspaces}
                                        </Flex>
                                    ),
                                    children: (
                                        <div className="p-2 sm:p-4">
                                            <WorkspacesTab memberships={profileData?.memberships || []} />
                                        </div>
                                    )
                                },
                                {
                                    key: "3",
                                    label: (
                                        <Flex justify="center" align="center" className="min-w-[120px] py-2">
                                            <i className="bi bi-phone-vibrate !me-2 text-lg" />
                                            {dict.settings.tabs.devices}
                                        </Flex>
                                    ),
                                    children: (
                                        <div className="p-2 sm:p-4">
                                            <DevicesTab />
                                        </div>
                                    )
                                }
                            ]}
                        />
                    </Card>
                </Col>
            </Row>

            <style jsx global>{`
                
            `}</style>
        </div>
    );
};

export default SettingsPage;