"use client";

import { useEffect } from "react";
import { Drawer, Form, Input, Button, Switch, Space, Alert, App } from "antd";
import { useAtomValue } from "jotai";
import { dictAtom, dirAtom } from "@/store/i18nAtom";
import * as OrganService from "@/services/organs.service";

const OrgFormDrawer = ({ open, onClose, initialValues, mode = "create" }) => {
    const dict = useAtomValue(dictAtom);
    const dir = useAtomValue(dirAtom)

    const [form] = Form.useForm();
    const { message } = App.useApp()
    const { mutate: createOrg, isPending: isCreating } = OrganService.useCreate();
    const { mutate: updateOrg, isPending: isUpdating } = OrganService.useUpdate();
    useEffect(() => {
        if (open) {
            form.setFieldsValue(initialValues || { is_active: true });
        } else {
            form.resetFields();
        }
    }, [open, initialValues, form]);

    const onFinish = (values) => {
        if (mode === "edit") {
            updateOrg({ id: initialValues.id, ...values }, {
                onSuccess: () => {
                    message.success(dict.common.saveSuccess);
                    onClose();
                }
            });
        } else {
            createOrg(values, {
                onSuccess: () => {
                    message.success(dict.organs.actions.successCreate);
                    onClose();
                }
            });
        }
    };

    return (
        <Drawer
            title={mode === "edit" ? dict.organs.actions.edit : (initialValues?.parent_id ? dict.organs.actions.addSub : dict.organs.header.addBtn)}
            size={424}
            placement={dir === 'rtl' ? 'left' : 'right'}
            onClose={onClose}
            open={open}
            classNames={{
                header: '!border-b !border-borderColor !bg-bgSurface',
                body: '!bg-bgSurface !p-6',
            }}
            extra={
                <Space>
                    <Button 
                        onClick={() => form.submit()} 
                        type="primary"
                        className="!hover:opacity-[0.85]"
                        loading={isCreating || isUpdating}
                    >
                        {dict.settings.profile.save}
                    </Button>
                </Space>
            }
        >
            <Form layout="vertical" form={form} onFinish={onFinish}>
                {initialValues?.parent_name && (
                    <Alert
                        title={`در حال افزودن زیرمجموعه برای: ${initialValues.parent_name}`}
                        type="info"
                        showIcon
                        className="!mb-6"
                    />
                )}
                <Form.Item name="parent_id" hidden>
                    <Input />
                </Form.Item>
                <Form.Item
                    name="name"
                    label={dict.organs.table.name}
                    rules={[{ required: true, message: dict.common.requiredField }]}
                >
                    <Input placeholder="مثلاً: شعبه مرکزی" className="!bg-bgBase"/>
                </Form.Item>
                <Form.Item
                    name="slug"
                    label={dict.organs.table.slug}
                    rules={[{ required: true, message: dict.common.requiredField }]}
                >
                    <Input placeholder="مثلاً: central-branch" className="!bg-bgBase" disabled={mode === "edit"} />
                </Form.Item>
            </Form>
        </Drawer>
    );
};

export default OrgFormDrawer;