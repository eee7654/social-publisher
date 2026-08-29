"use client"
import { App, Button, Col, Flex, Input, List, Row, Switch, Select } from "antd";
import { useCallback, useState } from "react";
import apiClient from "@/lib/api-client";
import { useAtomValue, useAtom } from "jotai";
import { dictAtom, langAtom } from "@/store/i18nAtom";
import { themeAtom } from "@/store/themeAtom"; 
import { useRouter } from "next/navigation";

const ProfileTab = ({ profileData }) => {
    const { message } = App.useApp();
    const router = useRouter();
    
    const dict = useAtomValue(dictAtom);
    const [lang, setLang] = useAtom(langAtom);
    const [themeMode, setThemeMode] = useAtom(themeAtom);
    const isDarkMode = themeMode === 'dark';
    
    const [saveLoading, setSaveLoading] = useState(false);
    const [settings, setSettings] = useState(profileData);
    const [formData, setFormData] = useState(profileData);

    const onSaveSetting = useCallback(async () => {
        let backendPayload = {};
        if (formData.name !== settings.name) {
            backendPayload.name = formData.name;
        }
        const isLangChanged = formData.lang !== settings.lang;
        if (Object.keys(backendPayload).length === 0 && !isLangChanged) {
            return message.info(dict.settings.profile.noChanges);
        }
        setSaveLoading(true);
        try {
            if (Object.keys(backendPayload).length > 0) {
                await apiClient.post('/api/v1/panel/users/update', backendPayload);
            }
            message.success(dict.settings.profile.saveSuccess);
            setSettings(formData);
            if (isLangChanged) {
                document.cookie = `NEXT_LOCALE=${formData.lang}; path=/; max-age=31536000`;
                window.location.replace(`/${formData.lang}/panel/settings`);
            }
        } catch (ex) {
            console.error(ex);
            message.error(dict.errors[ex.customCode ?? 'GEN_INTERNAL_ERROR']);
        } finally {
            setSaveLoading(false);
        }
    }, [formData, settings, dict, lang, router, setLang]);

    return (
        <Flex vertical justify="start" className="animate-fade-in">
            <List itemLayout="horizontal" split className="!text-textBase">
                <List.Item className="!py-5 !border-borderColor">
                    <Row className="!w-full" gutter={[16, 16]} align="middle">
                        <Col xs={24} lg={12}>
                            <List.Item.Meta
                                title={<span className="text-textBase font-bold text-[16px]">{dict.settings.profile.username}</span>}
                                description={<span className="text-textMuted text-[13px]">{dict.settings.profile.usernameDesc}</span>}
                            />
                        </Col>
                        <Col xs={24} lg={12}>
                            <Input
                                size="large"
                                className="!bg-bgBase !text-textMuted !border-borderColor !rounded-lg"
                                defaultValue={settings.username}
                                disabled
                            />
                        </Col>
                    </Row>
                </List.Item>
                <List.Item className="!py-5 !border-borderColor">
                    <Row className="!w-full" gutter={[16, 16]} align="middle">
                        <Col xs={24} lg={12}>
                            <List.Item.Meta
                                title={<span className="text-textBase font-bold text-[16px]">{dict.settings.profile.fullName}</span>}
                                description={<span className="text-textMuted text-[13px]">{dict.settings.profile.fullNameDesc}</span>}
                            />
                        </Col>
                        <Col xs={24} lg={12}>
                            <Input
                                size="large"
                                className="!bg-bgBase !text-textBase !border-borderColor hover:!border-primary focus:!border-primary !rounded-lg"
                                defaultValue={settings.name}
                                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                            />
                        </Col>
                    </Row>
                </List.Item>
                <List.Item className="!py-5 !border-borderColor">
                    <Row className="!w-full" gutter={[16, 16]} align="middle">
                        <Col xs={24} lg={12}>
                            <List.Item.Meta
                                title={<span className="text-textBase font-bold text-[16px]">{dict.settings.profile.lang}</span>}
                                description={<span className="text-textMuted text-[13px]">{dict.settings.profile.langDesc}</span>}
                            />
                        </Col>
                        <Col xs={24} lg={12}>
                            <Select 
                                defaultValue={lang}
                                onChange={(value) => setFormData({ ...formData, lang: value })}
                                size="large"
                                className="w-full !bg-bgBase !text-textBase !rounded-lg"
                                popupStyle={{ borderRadius: '8px' }}
                                options={[
                                    {
                                        label: (
                                            <Flex align="center">
                                                <CountryFlagEmoji code="IR" />
                                                <span className="!text-textBase ms-2">{dict.settings.profile.langItems.IR}</span>
                                            </Flex>
                                        ),
                                        value: 'fa'
                                    },
                                    {
                                        label: (
                                            <Flex align="center">
                                                <CountryFlagEmoji code="US" />
                                                <span className="!text-textBase ms-2">{dict.settings.profile.langItems.US}</span>
                                            </Flex>
                                        ),
                                        value: 'en'
                                    }
                                ]}
                            />
                        </Col>
                    </Row>
                </List.Item>
                <List.Item className="!py-5 !border-borderColor">
                    <Row className="!w-full" gutter={[16, 16]} align="middle">
                        <Col xs={24} lg={12}>
                            <List.Item.Meta
                                title={<span className="text-textBase font-bold text-[16px]">{dict.settings.profile.theme}</span>}
                                description={<span className="text-textMuted text-[13px]">{dict.settings.profile.themeDesc}</span>}
                            />
                        </Col>
                        <Col xs={24} lg={12} className="flex justify-start">
                            <Switch 
                                checked={isDarkMode} 
                                onChange={(checked) => setThemeMode(checked ? 'dark' : 'light')} 
                                checkedChildren={<i className="bi bi-moon-stars-fill" />}
                                unCheckedChildren={<i className="bi bi-brightness-high-fill" />}
                                className={isDarkMode ? '!bg-primary' : '!bg-gray-400'}
                            />
                        </Col>
                    </Row>
                </List.Item>
                <List.Item className="!py-5 border-none">
                    <Row className="!w-full" gutter={[16, 16]} align="middle">
                        <Col xs={24} lg={12}></Col>
                        <Col xs={24} lg={12}>
                            <Button
                                loading={saveLoading}
                                onClick={onSaveSetting}
                                type="primary"
                                icon={<i className="bi bi-floppy-fill" />}
                                className="shadow-md h-10 px-8 rounded-lg float-end"
                            >
                                {dict.settings.profile.save}
                            </Button>
                        </Col>
                    </Row>
                </List.Item>
            </List>
        </Flex>
    );
};

export const countryNameRecord = {
    /*CN: "China",*/
    IR: "Iran",
    /*SA: "Saudi Arabia",*/
    US: "United States",
}

export const getCountryFlagEmoji = (countryCode) => {
  const codePoints = countryCode
    .toUpperCase()
    .split("")
    .map((char) => 127397 + char.charCodeAt(0))
  return String.fromCodePoint(...codePoints)
}

export const CountryFlagEmoji = ({ code }) => {
    const title = code ? countryNameRecord[code] || code : undefined
    return (
        <span role="img" aria-labelledby={title} title={title}>
            {code ? getCountryFlagEmoji(code) : "🏳"}
        </span>
    )
}

export default ProfileTab;