"use client";

import '../style.css'
import { useState, useEffect, useMemo } from "react";
import { Card, Table, Input, Button, Tag, Space, Tooltip, Flex, Popconfirm } from "antd";
import { useAtom, useAtomValue } from "jotai";
import { dictAtom, langAtom } from "@/store/i18nAtom";
import { organsPageAtom, organsLimitAtom, organsSearchAtom } from "@/store/organsAtom";
import * as OrganService from "@/services/organs.service";
import { Can } from "@casl/react";
import { abilityAtom } from "@/store/authAtom";
import OrgFormDrawer from './OrgFormDrawer';
import { subject } from '@casl/ability';
import { toPascalCase } from '@/utils/converters';
import { useRouter } from 'next/navigation';
import NProgress from 'nprogress'

const OrgansClient = () => {
    const router = useRouter()
    const dict = useAtomValue(dictAtom);
    const lang = useAtomValue(langAtom)
    const ability = useAtomValue(abilityAtom)
    const [page, setPage] = useAtom(organsPageAtom);
    const [limit, setLimit] = useAtom(organsLimitAtom);
    const [search, setSearch] = useAtom(organsSearchAtom);
    const [searchText, setSearchText] = useState(search);
    const [drawerState, setDrawerState] = useState({
        open: false,
        mode: "create",
        initialValues: null
    });

    // 🔥 فراخوانی متدها
    const { data, isLoading, isFetching } = OrganService.useList({ page, limit, search });
    const { mutate: suspendOrg, isPending: isSuspending } = OrganService.useSuspend();

    const openCreateDrawer = () => setDrawerState({ open: true, mode: "create", initialValues: { is_active: true } });
    const openAddSubDrawer = (record) => setDrawerState({ 
        open: true, 
        mode: "create", 
        initialValues: { parent_id: record.id, parent_name: record.name, is_active: true } 
    });
    const openEditDrawer = (record) => setDrawerState({ 
        open: true, 
        mode: "edit", 
        initialValues: record 
    });
    const closeDrawer = () => setDrawerState(prev => ({ ...prev, open: false }));

    // هندل کردن سرچ با دی‌باونس
    useEffect(() => {
        const handler = setTimeout(() => {
            setSearch(searchText);
            setPage(1); 
        }, 500);
        return () => clearTimeout(handler);
    }, [searchText, setSearch, setPage]);

    // 🚀 جادوی useMemo: ستون‌ها فقط زمانی بازسازی میشن که زبان (dict) یا وضعیت لودینگِ تعلیق تغییر کنه
    const columns = useMemo(() => [
        {
            title: dict.organs.table.name,
            dataIndex: 'name',
            key: 'name',
            render: (text, row) => (
                <div className="flex items-center gap-2">
                    <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-bgBase border border-borderColor text-textMuted">
                        <i className="bi bi-building"></i>
                    </div>
                    <span className="font-semibold text-textBase">{lang === 'en' ? toPascalCase(row.slug) : text}</span>
                </div>
            )
        },
        {
            title: dict.organs.table.slug,
            dataIndex: 'slug',
            key: 'slug',
            render: (text) => <span className="text-textMuted font-mono text-sm">{text}</span>
        },
        {
            title: dict.organs.table.members,
            dataIndex: 'members_count',
            key: 'members_count',
            render: (count) => (
                <Tag color="blue" className="!rounded-md border-none !bg-blue-50 dark:!bg-blue-900/30 !text-blue-600 dark:!text-blue-400">
                    <i className="bi bi-people-fill me-1" />
                    {count || 0}
                </Tag>
            )
        },
        {
            title: dict.organs.table.status,
            dataIndex: 'is_active',
            key: 'is_active',
            render: (isActive) => (
                isActive ? 
                <Tag color="success" className="!rounded-md border-none !bg-green-50 dark:!bg-green-900/30 !text-success">
                    <span className="flex items-center gap-1">
                        <span className="w-1.5 h-1.5 rounded-full bg-success animate-pulse"></span>
                        {dict.organs.status.active}
                    </span>
                </Tag>
                : 
                <Tag color="error" className="!rounded-md border-none !bg-red-50 dark:!bg-red-900/30 !text-accent !w-[64px] !flex">
                    <i className="bi bi-slash-circle me-1 grid items-center" />
                    <span className='shrink-0'>{dict.organs.status.suspended}</span>
                </Tag>
            )
        },
        {
            title: dict.organs.table.actions,
            key: 'actions',
            align: 'center',
            render: (_, record) => (
                <Space size="middle">
                    <Can I="update" a="Organization" ability={ability}>
                        <Tooltip title={dict.organs.actions.edit}>
                            <Button
                                size={'large'}
                                type="text"
                                className="!text-borderColor !bg-textBase transition-colors"
                                icon={<i className="bi bi-pencil-square grid" />}
                                onClick={()=>openEditDrawer(record)}
                            />
                        </Tooltip>
                    </Can>
                    <Can I="create" a="Organization" ability={ability}>
                        <Tooltip title={dict.organs.actions.addSub}>
                            <Button
                                size={'large'}
                                type="text"
                                className="!text-borderColor !bg-textBase transition-colors"
                                icon={<i className="bi bi-node-plus grid" />}
                                onClick={()=>openAddSubDrawer(record)}
                            />
                        </Tooltip>
                    </Can>
                    <Can I="manage_members" this={subject('Organization', record)} ability={ability}>
                        <Tooltip title="مدیریت اعضا">
                            <Button
                                size={'large'}
                                type="text"
                                className="!text-borderColor !bg-textBase transition-colors"
                                icon={<i className="bi bi-people grid" />}
                                onClick={() => {
                                    NProgress.start()
                                    router.push(`/${lang}/panel/users?orgId=${record.id}`)
                                }}
                            />
                        </Tooltip>
                    </Can>
                    {record.slug !== 'main' && (
                        <Can I="suspend" this={subject('Organization', record)} ability={ability}>
                            <Popconfirm
                                title={record.is_active ? dict.organs.actions.suspend : dict.organs.actions.activate}
                                description={dict.organs.actions.changeStatus.replace('{status}',record.is_active ? dict.organs.actions.suspend : dict.organs.actions.activate)}
                                onConfirm={() => suspendOrg({ id: record.id, is_active: !record.is_active })}
                                okText={dict.common.yes}
                                cancelText={dict.common.no}
                                okButtonProps={{ danger: record.is_active, loading: isSuspending }}
                            >
                                <Tooltip title={record.is_active ? dict.organs.actions.suspend : dict.organs.actions.activate}>
                                    <Button
                                        size={'large'}
                                        type="text" 
                                        className={`transition-colors !text-textBase ${record.is_active ? '!bg-accent' : '!bg-success'}`} 
                                        icon={<i className={`bi ${record.is_active ? 'bi-lock' : 'bi-unlock'} grid`} />} 
                                    />
                                </Tooltip>
                            </Popconfirm>
                        </Can>
                    )}
                </Space>
            )
        }
    ], [dict, suspendOrg, isSuspending]); // وابستگی‌های useMemo

    return (
        <div className="container mx-auto px-4 py-6 z-[1] h-full">
            <Card
                className="w-full h-full flex flex-col !bg-bgSurface !border-borderColor shadow-sm !rounded-xl overflow-hidden"
                classNames={{
                    header: '!border-b !border-borderColor !px-6 !py-4',
                    body: '!p-0 flex flex-col flex-1 min-h-0' 
                }}
                title={
                    <Flex justify="space-between" align="center" className="w-full max-sm:flex-col max-sm:gap-4 max-sm:items-start">
                        <Flex vertical>
                            <span className="text-textBase text-lg font-bold">
                                {dict.organs.header.title}
                            </span>
                            <span className="text-textMuted text-sm mt-1 font-normal">
                                {dict.organs.header.desc}
                            </span>
                        </Flex>
                        
                        <Flex gap="middle" align="center" className="max-sm:w-full">
                            <Input
                                placeholder={dict.organs.header.searchPlaceholder}
                                prefix={<i className="bi bi-search text-textMuted" />}
                                className="!bg-bgBase !border-borderColor !text-textBase hover:!border-primary focus:!border-primary rounded-lg min-w-[250px] max-sm:w-full"
                                value={searchText}
                                onChange={(e) => setSearchText(e.target.value)}
                                allowClear
                            />
                            
                            {/* 🛡️ مخفی کردن دکمه "افزودن شعبه" در صورت نداشتن پرمیشن */}
                            <Can I="create" a="Organization" ability={ability}>
                                <Button 
                                    type="primary" 
                                    className="!bg-primary !shadow-none rounded-lg font-medium"
                                    icon={<i className="bi bi-plus-lg" />}
                                    onClick={openCreateDrawer}
                                >
                                    {dict.organs.header.addBtn}
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
                        loading={isLoading || isFetching}
                        scroll={{
                            x: 'max-content',
                            y:'var(--table-scroll-y)'
                        }}
                        pagination={{
                            current: page,
                            pageSize: limit,
                            total: data?.total || 0,
                            showSizeChanger: true,
                            showTotal: (total, range) => <span className="text-textMuted text-sm font-iransans">{`${range[0]}-${range[1]} از ${total} شعبه`}</span>,
                            onChange: (newPage, newPageSize) => {
                                setPage(newPage);
                                setLimit(newPageSize);
                            },
                        }}
                        locale={{ emptyText: dict.organs.empty }}
                        rowClassName={() => "hover:!bg-bgBase transition-colors !text-textBase"}
                    />
                </div>
            </Card>
            <OrgFormDrawer
                open={drawerState.open} 
                onClose={closeDrawer} 
                mode={drawerState.mode}
                initialValues={drawerState.initialValues}
            />
        </div>
    );
};



export default OrgansClient;