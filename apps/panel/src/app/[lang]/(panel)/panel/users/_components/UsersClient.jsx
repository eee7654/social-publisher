"use client";

import '../style.css';
import { useState, useEffect, useMemo } from "react";
// 🌟 اضافه کردن useSearchParams برای گرفتن orgId از آدرس
import { useSearchParams } from 'next/navigation'; 
import { Card, Table, Input, Button, Tag, Space, Tooltip, Flex, Popconfirm, App, Result } from "antd";
import { useAtom, useAtomValue } from "jotai";
import { dictAtom, dirAtom, langAtom } from "@/store/i18nAtom";
import { abilityAtom, userAtom } from "@/store/authAtom";
import { Can } from "@casl/react";
import { subject } from "@casl/ability";
// 🌟 ایمپورت سرویس کاربران
import * as UserService from "@/services/users.service";
import { toPascalCase } from '@/utils/converters';
import UserFormDrawer from './UserFormDrawer';
import ErrComp from '@/components/ui/ErrComp';

const UsersClient = () => {
    const dict = useAtomValue(dictAtom);
    const lang = useAtomValue(langAtom);
    const dir = useAtomValue(dirAtom);
    const ability = useAtomValue(abilityAtom);
    const profile = useAtomValue(userAtom)

    const { message } = App.useApp();

    const [isDrawerOpen, setIsDrawerOpen] = useState(false);
    const [drawerMode, setDrawerMode] = useState("create");
    const [selectedUser, setSelectedUser] = useState(null);
    const [activeTab, setActiveTab] = useState("1");
    
    
    const searchParams = useSearchParams();
    const orgId = searchParams.get('orgId');

    const [page, setPage] = useState(1);
    const [limit, setLimit] = useState(10);
    const [search, setSearch] = useState("");
    const [searchText, setSearchText] = useState("");

    const handleOpenCreate = () => {
        setDrawerMode("create");
        setSelectedUser(null);
        setIsDrawerOpen(true);
    };

    const handleOpenEdit = (record, targetTab) => {
        setDrawerMode("edit");
        setSelectedUser(record);
        setActiveTab(targetTab);
        setIsDrawerOpen(true);
    };

    const { data, isLoading, isFetching, error } = UserService.useList({ 
        page, 
        limit, 
        search, 
        ...(orgId && { orgId })
    });

    const isMultiOrg = data?._meta?.isMultiOrg || false;

    // دی‌باونس برای سرچ
    useEffect(() => {
        const handler = setTimeout(() => {
            setSearch(searchText);
            setPage(1); 
        }, 500);
        return () => clearTimeout(handler);
    }, [searchText]);

    const columns = useMemo(() => {
        const baseColumns = [
            {
                title: dict.users?.table?.name,
                dataIndex: 'name',
                key: 'name',
                render: (text, row) => (
                    <div className="flex items-center gap-3">
                        <div className="flex items-center justify-center w-9 h-9 rounded-full bg-primary/10 text-primary">
                            <i className="bi bi-person-fill text-lg"></i>
                        </div>
                        <Flex vertical>
                            <span className="font-semibold text-textBase">
                                {text}
                                {row.id === profile.id && (
                                    <Tag color="green" className="!border-none !rounded-full !px-3 !ms-2">
                                        <i className="bi bi-check-circle-fill me-1" />
                                        {dict.users.form.currentUser}
                                    </Tag>
                                )}
                            </span>
                            <span className="text-textMuted text-xs font-mono mt-1">{row.email}</span>
                        </Flex>
                    </div>
                )
            },
            ...(isMultiOrg ? [{
                title: dict.users?.table?.role,
                key: 'memberships',
                render: (_, row) => (
                    <Flex gap="small" wrap="wrap" className="max-w-[250px]">
                        {row.memberships?.length > 0 ? row.memberships.map(m => (
                            <Tag className="!rounded border border-borderColor !bg-bgBase !text-textMuted m-0">
                                <i className="bi bi-building me-1 opacity-70"></i>
                                {lang === 'en' ? toPascalCase(m.organization?.slug) : m.organization?.name}<i className={`bi bi-chevron-${dir === 'ltr' ? 'right' : 'left'} mx-1 opacity-70`}/>{lang === 'en' ? m.role?.name : m.role?.label}
                            </Tag>
                        )) : <span className="text-textMuted text-xs">-</span>}
                    </Flex>
                )
            }] : [{
                title: dict.users?.table?.role,
                key: 'role',
                render: (_, row) => (
                    <Tag color="purple" className="!rounded-md border-none !bg-purple-50 dark:!bg-purple-900/30 !text-purple-600 dark:!text-purple-400">
                        {lang === 'en' ? row.role?.name : row.role?.label}
                    </Tag>
                )
            }]),
            {
                title: dict.users?.table?.status,
                dataIndex: 'is_active',
                key: 'is_active',
                align: 'center',
                render: (isActive) => (
                    isActive ? 
                    <Tag color="success" className="!rounded-md border-none !bg-green-50 dark:!bg-green-900/30 !text-success m-0">
                        <span className="flex items-center gap-1">
                            <span className="w-1.5 h-1.5 rounded-full bg-success animate-pulse"></span>
                            {dict.users?.status?.active}
                        </span>
                    </Tag>
                    : 
                    <Tag color="error" className="!rounded-md border-none !bg-red-50 dark:!bg-red-900/30 !text-accent m-0">
                        <i className="bi bi-slash-circle me-1" />
                        {dict.users?.status?.suspended}
                    </Tag>
                )
            },
            {
                title: dict.users?.table?.actions,
                key: 'actions',
                align: 'center',
                render: (_, record) => (
                    <Space size="small">
                        <Can I="update" this={subject('User', record)} ability={ability}>
                            <Tooltip title={dict.users?.actions?.edit}>
                                <Button
                                    type="text"
                                    className="!text-borderColor !bg-textBase"
                                    size={'large'}
                                    icon={<i className="bi bi-pencil-square grid"/>}
                                    onClick={() => handleOpenEdit(record, "1")}
                                />
                            </Tooltip>
                        </Can>
                        {isMultiOrg && (
                            <Can I="manage_roles" this={subject('User', record)} ability={ability}>
                                <Tooltip title={dict.users?.actions?.roles}>
                                    <Button
                                        type="text"
                                        size={'large'}
                                        className="!text-borderColor !bg-textBase"
                                        icon={<i className="bi bi-diagram-3 grid"/>}
                                        onClick={() => handleOpenEdit(record, "2")}
                                    />
                                </Tooltip>
                            </Can>
                        )}
                    </Space>
                )
            }
        ];
        return baseColumns;
    }, [dict, ability, isMultiOrg]);

    return (
        <div className="container mx-auto px-4 py-6 z-[1] h-full">
            {!error ? (
                <Card
                    className="w-full h-full flex flex-col !bg-bgSurface !border-borderColor shadow-sm !rounded-xl overflow-hidden"
                    classNames={{
                        header: '!border-b !border-borderColor !px-6 !py-4',
                        body: '!p-0 flex flex-col flex-1 min-h-0' 
                    }}
                    title={
                        <Flex justify="space-between" align="center" className="max-sm:flex-col max-sm:gap-4 max-sm:items-start">
                            <Flex vertical>
                                <span className="text-textBase text-lg font-bold">
                                    {dict.users?.pageTitle}
                                </span>
                                <span className="text-textMuted text-sm mt-1 font-normal">
                                    {dict.users?.header?.desc}
                                </span>
                            </Flex>
                            
                            <Flex gap="middle" align="center" className="max-sm:w-full">
                                <Input
                                    placeholder={dict.users?.header?.searchPlaceholder}
                                    prefix={<i className="bi bi-search text-textMuted" />}
                                    className="!bg-bgBase !border-borderColor !text-textBase hover:!border-primary focus:!border-primary rounded-lg min-w-[250px] max-sm:w-full"
                                    value={searchText}
                                    onChange={(e) => setSearchText(e.target.value)}
                                    allowClear
                                />
                                
                                <Can I="create" a="User" ability={ability}>
                                    <Button 
                                        type="primary" 
                                        className="!bg-primary hover:opacity-[0.85] !shadow-none rounded-lg font-medium"
                                        icon={<i className="bi bi-person-plus-fill" />}
                                        onClick={handleOpenCreate}
                                    >
                                        {dict.users?.header?.addBtn}
                                    </Button>
                                </Can>
                            </Flex>
                        </Flex>
                    }
                >
                    <div className="content-wrap p-4 flex flex-col flex-1 min-h-0">
                        <Table
                            className="custom-table"
                            columns={columns}
                            dataSource={data?.data || []}
                            rowKey="id"
                            loading={isLoading || isFetching} // نمایش لودینگ هنگام فچِ مجددِ ریکوئست‌ها
                            scroll={{ x: 'max-content', y: 'var(--table-scroll-y)' }}
                            pagination={{
                                current: page,
                                pageSize: limit,
                                total: data?.total || 0,
                                showSizeChanger: true,
                                onChange: (newPage, newPageSize) => {
                                    setPage(newPage);
                                    setLimit(newPageSize);
                                },
                            }}
                            locale={{ emptyText: dict.users?.empty }}
                            rowClassName={() => "hover:!bg-bgBase transition-colors !text-textBase"}
                        />
                    </div>
                </Card>
            ) : (
                <ErrComp
                    errorCode={error}
                    className="mt-6" 
                />
            )}
            {isDrawerOpen && <UserFormDrawer
                open={isDrawerOpen}
                onClose={() => setIsDrawerOpen(false)}
                mode={drawerMode}
                initialValues={selectedUser}
                isMultiOrg={isMultiOrg}
                defaultTab={activeTab}
            />}
        </div>
    );
};

export default UsersClient;