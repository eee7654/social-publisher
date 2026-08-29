"use client";

import { useEffect, useMemo, useState } from 'react';
import { Drawer, Form, Input, Button, Switch, Select, Tabs, Flex, App, TreeSelect } from 'antd';
import { useAtomValue } from 'jotai';
import { dictAtom, dirAtom, langAtom } from '@/store/i18nAtom';
import * as UserService from '@/services/users.service';
import * as OrganService from '@/services/organs.service';
import * as RoleService from '@/services/roles.service';
import { toPascalCase } from '@/utils/converters';

const UserFormDrawer = ({ 
    open, 
    onClose, 
    initialValues, 
    mode = "create", 
    isMultiOrg = false, 
    defaultTab = "1"
}) => {
    const dict = useAtomValue(dictAtom)
    const dir = useAtomValue(dirAtom)
    const lang = useAtomValue(langAtom)

    const [form] = Form.useForm();
    const { message } = App.useApp();

    const [currentTab, setCurrentTab] = useState(defaultTab);

    const { mutate: createUser, isPending: isCreating } = UserService.useCreate();
    const { mutate: updateUser, isPending: isUpdating } = UserService.useUpdate();

    const { data: organsData, isLoading: isOrgLoading } = OrganService.useLookup();
    const { data: rolesData, isLoading: isRoleLoading } = RoleService.useLookup();

    // تبدیل دیتای فلت به ساختار درختی برای TreeSelect سازمان‌ها (UI فوق‌حرفه‌ای)
    const orgTreeData = useMemo(() => {
        const buildTree = (orgs, parentId = null) => {
            return orgs
                .filter(org => org.parent_id === parentId)
                .map(org => ({
                    value: org.id,
                    title: lang === 'en' ? toPascalCase(org.slug) : org.name,
                    children: buildTree(orgs, org.id)
                }));
        };
        return buildTree(organsData?.data || []);
    }, [organsData]);

    const roleList = useMemo(() => {
        return rolesData?.data?.map(role => ({ label: lang === 'en' ? role.name : role.label, value: role.id })) || [];
    }, [rolesData]);

    const isEditMode = mode === "edit";

    useEffect(() => {
        if (open) {
            setCurrentTab(defaultTab);
            if (isEditMode && initialValues) {
                const { password, ...safeValues } = initialValues;
                form.setFieldsValue(safeValues);
            } else {
                form.resetFields();
                form.setFieldsValue({ is_active: true }); 
            }
        }
    }, [open, initialValues, isEditMode, form, defaultTab]);

    const onFinish = (values) => {
        if (isEditMode) {
            const updateBody = {
                name:values.name,
                is_active: values.is_active === 1
            }
            updateUser({ id: initialValues.id, ...updateBody }, {
                onSuccess: () => {
                    message.success(dict.users.actions.successEdit);
                    onClose();
                }
            });
        } else {
            createUser(values, {
                onSuccess: () => {
                    message.success(dict.users.actions.successCreate);
                    onClose();
                }
            });
        }
    };

    const BasicInfoTab = (
        <div className="flex flex-col gap-5 mt-5">
            <Form.Item 
                name="name" 
                label={dict.users.form.fullName} 
                rules={[{ required: true, message: dict.users.form.validation.required }]}
                className="m-0"
            >
                <Input  className="rounded-lg !bg-bgBase" />
            </Form.Item>

            <Flex gap="middle" className="max-sm:flex-col">
                <Form.Item 
                    name="username" 
                    label={dict.users.form.username} 
                    className="flex-1 m-0"
                    rules={[{ required: true, message: dict.users.form.validation.required }]}
                >
                    <Input  className="rounded-lg !bg-bgBase" disabled={isEditMode} />
                </Form.Item>
                <Form.Item 
                    name="email" 
                    label={dict.users.form.email} 
                    className="flex-1 m-0"
                    rules={[
                        { required: true, message: dict.users.form.validation.required },
                        { type: 'email', message: dict.users.form.validation.email }
                    ]}
                >
                    <Input  className="rounded-lg !bg-bgBase" dir="ltr" disabled={isEditMode} />
                </Form.Item>
            </Flex>

            {!isEditMode && (
                <Form.Item 
                    name="password" 
                    label={dict.users.form.password} 
                    rules={[{ required: true, message: dict.users.form.validation.required }]}
                    className="m-0"
                >
                    <Input.Password className="rounded-lg !bg-bgBase" dir="ltr" />
                </Form.Item>
            )}

            <Form.Item 
                name="is_active" 
                label={dict.users.form.isActive} 
                valuePropName="checked" 
                className="m-0 mt-2"
            >
                <Switch className="bg-textMuted [&.ant-switch-checked]:bg-success" />
            </Form.Item>
        </div>
    );

    const AccessTab = (
        <div className="mt-5">
            {!isMultiOrg ? (
                <Form.Item 
                    name="role_id" 
                    label={dict.users.form.singleRole} 
                    rules={[{ required: true, message: dict.users.form.validation.roleRequired }]}
                >
                    <Select 
                        size="large"
                        options={roleList} 
                        loading={isRoleLoading}
                        placeholder={dict.users.form.selectRole}
                        className="w-full"
                    />
                </Form.Item>
            ) : (
                <div>
                    <div className="mb-4 text-sm font-medium text-textBase">
                        {dict.users.form.multiRoleTitle}
                    </div>
                    <Form.List name="memberships">
                        {(fields, { add, remove }) => (
                            <div className="flex flex-col gap-4">
                                {fields.map(({ key, name, ...restField }) => (
                                    <Flex key={key} gap="small" align="flex-start" className="bg-bgBase/50 !p-4 rounded-xl border border-borderColor">
                                        <Form.Item
                                            {...restField}
                                            name={[name, 'organization_id']}
                                            rules={[{ required: true, message: dict.users.form.validation.orgRequired }]}
                                            className="!m-0 flex-[3]"
                                        >
                                            <TreeSelect 
                                                treeData={orgTreeData} 
                                                loading={isOrgLoading} 
                                                placeholder={dict.users.form.selectOrg}
                                                showSearch={{treeNodeFilterProp: 'title'}}
                                                treeDefaultExpandAll
                                                className="w-full !bg-bgBase"
                                            />
                                        </Form.Item>

                                        <Form.Item
                                            {...restField}
                                            name={[name, 'role_id']}
                                            rules={[{ required: true, message: dict.users.form.validation.roleRequired }]}
                                            className="!m-0 flex-[2]"
                                        >
                                            <Select 
                                                options={roleList} 
                                                placeholder={dict.users.form.selectRole}
                                                className="w-full !bg-bgBase"
                                            />
                                        </Form.Item>

                                        <Button 
                                            type="text" 
                                            danger 
                                            icon={<i className="bi bi-trash3 text-lg grid" />} 
                                            onClick={() => remove(name)}
                                            className="!bg-accent !text-textBase"
                                        />
                                    </Flex>
                                ))}
                                <Button 
                                    type="dashed" 
                                    onClick={() => add()} 
                                    block 
                                    icon={<i className="bi bi-plus-lg" />}
                                    className="!text-primary !border-primary/50 hover:!border-primary !bg-transparent h-10 mt-2 rounded-lg"
                                >
                                    {dict.users.form.addMembership}
                                </Button>
                            </div>
                        )}
                    </Form.List>
                </div>
            )}
        </div>
    );

    return (
        <Drawer
            title={isEditMode ? dict.users.form.titleEdit : dict.users.form.titleCreate}
            size={580}
            placement={dir === 'rtl' ? 'left' : 'right'}
            onClose={onClose}
            open={open}
            destroyOnHidden
            classNames={{
                header: '!border-b !border-borderColor !bg-bgSurface',
                body: '!bg-bgSurface !p-6',
            }}
            extra={
                <Flex justify="flex-end" gap="small">
                    <Button onClick={onClose} className="rounded-lg">
                        {dict.users.form.cancel}
                    </Button>
                    <Button 
                        type="primary"
                        onClick={() => form.submit()} 
                        loading={isCreating || isUpdating}
                        className="!bg-primary hover:opacity-[0.85] rounded-lg !shadow-none"
                    >
                        {dict.users.form.submit}
                    </Button>
                </Flex>
            }
        >
            <Form form={form} layout="vertical" onFinish={onFinish} className="h-full">
                <Tabs 
                    activeKey={currentTab}
                    onChange={(key) => setCurrentTab(key)}
                    items={[
                        { key: '1', label: dict.users.form.tabs.basicInfo, children: BasicInfoTab },
                        { key: '2', label: dict.users.form.tabs.access, children: AccessTab },
                    ]} 
                    className="custom-tabs [&_.ant-tabs-nav]:!mb-0"
                    classNames={{header:'!border-b !border-borderColor'}}
                />
            </Form>
        </Drawer>
    );
};

export default UserFormDrawer;