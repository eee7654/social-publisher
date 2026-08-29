"use client"
import { App, Button, Flex, List, Popconfirm, Tag, Tooltip, Typography, Skeleton } from "antd";
import { useCallback, useEffect, useState } from "react";
import { useAtomValue } from "jotai";
import { dictAtom, langAtom } from "@/store/i18nAtom";
import moment from "jalali-moment";
import { authClient } from "@/lib/auth-client"; 
import { UAParser } from 'ua-parser-js';

const { Text } = Typography;

const DevicesTab = () => {
    const { message } = App.useApp();
    const dict = useAtomValue(dictAtom);
    const lang = useAtomValue(langAtom)
    const [sessions, setSessions] = useState([]);
    const [loading, setLoading] = useState(true);
    const [revokingId, setRevokingId] = useState(null);

    const { data: currentSessionData } = authClient.useSession();

    const fetchSessions = useCallback(async () => {
        setLoading(true);
        try {
            // دریافت لیست تمام سشن‌های کاربر
            const { data, error } = await authClient.listSessions();
            if (error) throw error;
            setSessions(data || []);
        } catch (error) {
            if(error.status === 401) return window.location.replace(`/${lang}/auth/login?reason=expired`)
            console.error("Error fetching sessions:", error);
            message.error(dict.errors?.GEN_INTERNAL_ERROR || "خطا در دریافت لیست دستگاه‌ها");
        } finally {
            setLoading(false);
        }
    }, [message, dict]);

    useEffect(() => {
        fetchSessions();
    }, [fetchSessions]);

    // 🚀 پیاده‌سازی قانون امنیتی ۲۴ ساعت
    const isNewLogin = () => {
        if (!currentSessionData?.session?.createdAt) return false;
        const now = Date.now();
        const sessionTime = new Date(currentSessionData.session.createdAt).getTime();
        const hoursPassed = (now - sessionTime) / (1000 * 60 * 60);
        return hoursPassed < 24;
    };
    const isSecurityLocked = isNewLogin();
    const onRevokeSession = async (sessionToken, sessionId) => {
        setRevokingId(sessionId);
        try {
            // ابطال سشن از طریق Better Auth
            const { error } = await authClient.revokeSession({ token: sessionToken });
            if (error) throw error;
            
            message.success(dict.settings.devices.revokeSuccess);
            // آپدیت لوکال لیست برای سرعت بیشتر (بدون نیاز به ریکوئست مجدد)
            setSessions(prev => prev.filter(s => s.id !== sessionId));
        } catch (error) {
            console.error("Error revoking session:", error);
            message.error(dict.errors?.GEN_INTERNAL_ERROR || "خطا در خروج از دستگاه");
        } finally {
            setRevokingId(null);
        }
    };
    const getDeviceName = (userAgentStr) => {
        if (!userAgentStr) return dict.settings.devices.deviceUnknown;  
        const parser = new UAParser(userAgentStr);
        const result = parser.getResult();  
        const browser = result.browser.name || dict.settings.devices.browserUnknown;
        const os = result.os.name || dict.settings.devices.osUnknown;
        return `${browser} <> ${os}`;
    };
    const getDeviceIcon = (userAgentStr) => {
        if (!userAgentStr) return "bi-laptop";
        const parser = new UAParser(userAgentStr);
        const deviceType = parser.getDevice().type;
        const osName = parser.getOS().name?.toLowerCase() || '';
        if (deviceType === 'mobile' || osName === 'ios' || osName === 'android') return "bi-phone";
        if (deviceType === 'tablet') return "bi-tablet";
        return "bi-laptop";
    };

    return (
        <Flex vertical justify="start" className="animate-fade-in !w-full !h-full">
            <div className="mt-0">
                <Text className="text-textBase text-[15px]">{dict.settings.devices.desc}</Text>
            </div>

            {loading ? (
                <Skeleton active paragraph={{ rows: 4 }} className="mt-4" />
            ) : (
                <List
                    itemLayout={'horizontal'}
                    split
                    dataSource={sessions}
                    renderItem={(session) => {
                        const isCurrent = session.id === currentSessionData?.session?.id;
                        return (
                            <List.Item className="!py-3 !border-borderColor hover:bg-bgBase/50 transition-colors rounded-xl px-4 my-2">
                                <List.Item.Meta
                                    avatar={
                                        <div className="w-12 h-12 rounded-full bg-primary/10 text-primary flex items-center justify-center text-2xl">
                                            <i className={`bi ${getDeviceIcon(session.userAgent)}`} />
                                        </div>
                                    }
                                    title={
                                        <Flex align="center" gap="small" className="mb-1">
                                            <span className="text-textBase font-bold text-[16px] dir-ltr inline-block">
                                                {getDeviceName(session.userAgent)}
                                            </span>
                                            {isCurrent && (
                                                <Tag color="green" className="!border-none !rounded-full !px-3 ms-2">
                                                    <i className="bi bi-check-circle-fill me-1" />
                                                    {dict.settings.devices.currentSession}
                                                </Tag>
                                            )}
                                        </Flex>
                                    }
                                    description={
                                        <Flex vertical gap="small" className="mt-2 text-textMuted text-[13px]">
                                            <span className="text-start">
                                                <i className="bi bi-globe2 me-2" />
                                                {dict.settings.devices.ip} {session.ipAddress || dict.settings.devices.ipUnknown}
                                            </span>
                                            <span>
                                                <i className="bi bi-calendar3 me-2" />
                                                {dict.settings.devices.createdAt} <span dir="ltr">{moment(session.createdAt).locale(lang).format('YYYY/MM/DD - HH:mm')}</span>
                                            </span>
                                        </Flex>
                                    }
                                />
                                
                                {!isCurrent && (
                                    <Tooltip title={isSecurityLocked ? dict.settings.devices.rule24h : ""}>
                                        <div> {/* این div برای کار کردن Tooltip روی دکمه‌ی Disabled لازمه */}
                                            <Popconfirm
                                                title={<span className="text-textBase">{dict.settings.devices.revokeConfirm}</span>}
                                                onConfirm={() => onRevokeSession(session.token, session.id)}
                                                okText={dict.settings.logout.yes}
                                                cancelText={dict.settings.logout.no}
                                                disabled={isSecurityLocked}
                                                okButtonProps={{ danger: true, className: 'shadow-none' }}
                                            >
                                                <Button 
                                                    danger 
                                                    type="text" 
                                                    loading={revokingId === session.id}
                                                    disabled={isSecurityLocked}
                                                    className={`!bg-red-50 hover:!border-red-500 !text-accent transition-all ${isSecurityLocked ? 'opacity-50 !border-red-500' : ''}`}
                                                    icon={<i className="bi bi-trash3 grid" />}
                                                >
                                                    {dict.settings.devices.revoke}
                                                </Button>
                                            </Popconfirm>
                                        </div>
                                    </Tooltip>
                                )}
                            </List.Item>
                        );
                    }}
                />
            )}
        </Flex>
    );
};

export default DevicesTab;