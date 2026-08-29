"use client"
import { useAtomValue } from "jotai";
import { useCallback, useEffect, useMemo, useState } from 'react';
import { 
  Layout, Menu, Form, Row, Col, Select, Space, Tag, 
  Button, Typography, Input, Empty, App, Tooltip, 
  Flex, Modal, Badge, Divider,
  InputNumber,
  Switch
} from 'antd';
import { useRouter } from 'next/navigation';
import apiClient from '@/lib/api-client';
import { Can} from '@casl/react'
import { userAtom } from "@/store/authAtom";
import { abilityAtom } from '@/store/authAtom';
import { dictAtom, langAtom } from "@/store/i18nAtom";
import { EmptyData } from "@/components/ui/utilities";

const { Title, Text, Paragraph } = Typography;
const { Header, Content } = Layout;

const isDevMode = process.env.NODE_ENV === 'development';

const RolesPage = ({ initialRoles = [], groupedPermissions = {} })=>{
    const profile = useAtomValue(userAtom);
    const { message } = App.useApp();
    const [form] = Form.useForm();
    const router = useRouter();
    const ability = useAtomValue(abilityAtom);
    const dict = useAtomValue(dictAtom);
    const lang = useAtomValue(langAtom)
    const [activeRole, setActiveRole] = useState(initialRoles.length > 0 ? initialRoles[0].id : null);
    const [searchText, setSearchText] = useState('');
    const [loading, setLoading] = useState(false);
    const [conditionModal, setConditionModal] = useState({ visible: false, index: null, value: '' });
    const [roleForm] = Form.useForm();
    const [isRoleModalVisible, setIsRoleModalVisible] = useState(false);
    const [creatingRole, setCreatingRole] = useState(false);
    const [customActions, setCustomActions] = useState([]);
    const [dropdownInputs, setDropdownInputs] = useState({});
    const rulesWatch = Form.useWatch('rules', form) || [];
    const filteredRoles = useMemo(() => {
        return initialRoles.filter(role => 
            role.label.toLowerCase().includes(searchText.toLowerCase())
        );
    }, [initialRoles, searchText]);

    const activeRoleData = useMemo(() => {
        return initialRoles.find(r => r.id === activeRole);
    }, [initialRoles, activeRole]);

    useEffect(() => {
        if (!activeRoleData) {
            form.resetFields();
            return;
        }
        const groups = {};
        activeRoleData.permissions?.forEach(p => {
            const cond = p.conditions; 
            const condStr = cond ? (typeof cond === 'string' ? cond : JSON.stringify(cond, null, 2)) : '';
            let parsedFields = [];
            if (p.fields) {
                try {
                    parsedFields = typeof p.fields === 'string' ? JSON.parse(p.fields) : p.fields;
                } catch (e) {
                    console.error('Error parsing fields:', e);
                }
            }
            const fieldsStr = parsedFields.length > 0 ? JSON.stringify(parsedFields) : '';
            const groupKey = `${p.resource}___${condStr}___${fieldsStr}___${p.inverted}`;      
            if (!groups[groupKey]) {
                groups[groupKey] = {
                    resource: [p.resource],
                    actions: [],
                    conditions: condStr,
                    fields: parsedFields,
                    inverted: p.inverted == 1 ? true : false
                };
            }
            groups[groupKey].actions.push(p.action);
        });
        let formRules = Object.values(groups);
        formRules.sort((a, b) => {
            const resA = (a.resource && a.resource[0]) || '';
            const resB = (b.resource && b.resource[0]) || '';
            if (resA < resB) return -1;
            if (resA > resB) return 1;
            if (a.inverted === b.inverted) return 0;
            return a.inverted ? 1 : -1;
        });
        form.setFieldsValue({ 
            rules: formRules.length ? formRules : [{ resource: [], actions: [], conditions: '', fields: [], inverted: false }] 
        });
    }, [activeRoleData, form]);

    const resourceOptions = useMemo(() => {
        return Object.keys(groupedPermissions).map(res => ({
            value: res,
            label: res,
        }));
    }, [groupedPermissions]);

    const tagRender = useCallback(({ label, onClose }) => (
        <Tag color="blue" closable onClose={onClose} className="my-1 mx-0.5 rounded-md border-blue-200">
            {label}
        </Tag>
    ), []);

    const openConditionModal = (index) => {
        const currentCond = form.getFieldValue(['rules', index, 'conditions']) || '';
        setConditionModal({ visible: true, index, value: currentCond });
    };

    const saveConditions = () => {
        const { index, value } = conditionModal;
        const trimmedValue = value.trim();
        if (trimmedValue) {
            try {
                JSON.parse(trimmedValue);
            } catch (error) {
                return message.error(dict.roles.messages.invalidJson);
            }
        }
        const currentRules = [...form.getFieldValue('rules')];
        currentRules[index] = { ...currentRules[index], conditions: trimmedValue };
        form.setFieldsValue({ rules: currentRules });
        setConditionModal({ visible: false, index: null, value: '' });
    };

    const handleAddCustomAction = (nameIndex, selectedResource) => {
        const actionVal = dropdownInputs[nameIndex]?.action;
        const descVal = dropdownInputs[nameIndex]?.desc;
        if (!actionVal) return message.warning(dict.roles.messages.requiredActionCode);
        const newCustomAction = { resource: selectedResource, action: actionVal, description: descVal };
        setCustomActions(prev => [...prev, newCustomAction]);
        const currentRules = form.getFieldValue('rules');
        const currentActions = currentRules[nameIndex].actions || [];
        if (!currentActions.includes(actionVal)) {
            currentRules[nameIndex].actions = [...currentActions, actionVal];
            form.setFieldsValue({ rules: currentRules });
        }
        setDropdownInputs(prev => ({ ...prev, [nameIndex]: { action: '', desc: '' } }));
    };

    const handleCreateRoleSubmit = async (values) => {
        setCreatingRole(true);
        try {
            const data = await apiClient.post('/api/v1/panel/roles/create', values);
            message.success(dict.roles.messages.createSuccess.replace('{name}', lang === 'en' ? values.name :values.label));
            setIsRoleModalVisible(false);
            roleForm.resetFields();
            router.replace(router.asPath); 
        } catch (err) {
            message.error(dict.errors[err.customCode ?? 'GEN_UNKNOWN_ERROR']);
        } finally {
            setCreatingRole(false);
        }
    };

    const onSubmit = async (values) => {
        if (!activeRole) return message.error(dict.roles.messages.noRoleSelected);

        const structuredPayload = (values.rules || [])
        .filter(rule => rule.resource && rule.actions?.length > 0)
        .map(rule => {
            const resourceName = Array.isArray(rule.resource) ? rule.resource[0] : rule.resource;
            let parsedConditions = null;
            if (typeof rule.conditions === 'string' && rule.conditions.trim() !== '') {
                try { 
                    parsedConditions = JSON.parse(rule.conditions); 
                } catch (e) {
                    console.error("Condition parse error", e);
                }
            }
            const enrichedActions = rule.actions.map(actSlug => {
                const dbMatch = groupedPermissions[resourceName]?.find(p => p.action === actSlug);
                if (dbMatch) return { action: dbMatch.action, description: dbMatch.description || '' };
                
                const customMatch = customActions.find(c => c.resource === resourceName && c.action === actSlug);
                return { action: actSlug, description: customMatch?.description || '' };
            });
            return {
                resource: resourceName, 
                actions: enrichedActions,       
                conditions: parsedConditions,
                fields: rule.fields || [],
                inverted: rule.inverted
            };
        });
        setLoading(true);
        try {
            const data = await apiClient.post('/api/v1/panel/roles/update',{roleId:activeRole,rules:structuredPayload})
            message.success(dict.roles.messages.accessSavedSuccess.replace('{name}', lang === 'en' ? activeRoleData?.name : activeRoleData?.label));
            router.replace(router.asPath)
        } catch (err) {
            message.error(dict.errors[err.customCode ?? 'GEN_UNKNOWN_ERROR']);
        } finally {
            setLoading(false);
        }
    };
    return(
        <>
            <Header className="custom-header sticky top-0 w-full flex justify-between items-center !px-5 overflow-x-auto !z-[1]">
                <Paragraph className="text-lg font-bold !mb-0 me-2 text-textBase">{dict.roles.pageTitle}</Paragraph>
                <Can ability={ability} I="create" a="Role">
                    <Button type="primary" icon={<i className="bi bi-plus-lg"/>} className="shadow-md" onClick={() => setIsRoleModalVisible(true)}>
                        {dict.roles.buttons.newRole}
                    </Button>
                </Can>
            </Header>
            <Layout className="w-full overflow-hidden shadow-sm px-5 z-0 !bg-transparent" style={{ minHeight: '600px' }}>
                <div className="flex flex-col md:flex-row w-full h-full gap-2">
                    <div className="w-full md:w-[200px] flex-shrink-0 flex flex-col">
                        <div className="mt-4">
                            <Input 
                                placeholder={dict.roles.placeholders.searchRole} 
                                prefix={<i className="bi bi-search text-gray-400" />}
                                value={searchText}
                                onChange={e => setSearchText(e.target.value)}
                                className="rounded-lg !border-borderColor"
                            />
                        </div>
                        <div className="roleMenu max-h-[200px] md:max-h-[calc(100vh-250px)] overflow-y-auto mt-3 py-1 rounded-lg !bg-bgSurface !border !border-borderColor z-10">
                            {filteredRoles.length > 0 ? (
                                <Menu
                                    mode="inline"
                                    selectedKeys={[activeRole?.toString()]}
                                    onClick={({ key }) => setActiveRole(Number(key))}
                                    className="!bg-transparent border-none"
                                    items={filteredRoles.map(role => ({
                                        key: role.id.toString(),
                                        icon: <i className="bi bi-person-fill-gear"/>,
                                        label: lang === 'en' ? role.name : role.label,
                                    }))}
                                />
                            ) : (
                                <EmptyData title={<span className="!text-[14px]">{dict.roles.messages.noRuleDefined}</span>}/>
                            )}
                        </div>
                    </div>
                    <Content className="py-4 flex-1 w-full overflow-x-hidden !z-10">
                        {activeRole ? (
                            <div className="bg-bgSurface p-4 md:p-6 rounded-lg !border !border-borderColor shadow-sm min-h-full">
                                <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-6 pb-4 border-b border-borderColor gap-4">
                                    <div>
                                        <Title level={5} className="!mb-1 !text-textBase">{dict.roles.form.configTitle.replace('{name}', lang === 'en' ? activeRoleData.name : activeRoleData?.label)}</Title>
                                        <Text type="secondary" className="text-sm !text-textMuted">{dict.roles.form.configDesc}</Text>
                                    </div>
                                    <Can I={'update'} a={'Role'} ability={ability}>
                                        <Button 
                                            type="primary" 
                                            icon={<i className="bi bi-floppy" />} 
                                            onClick={() => form.submit()}
                                            loading={loading}
                                            className="w-full sm:w-auto"
                                        >
                                            {dict.roles.buttons.saveChanges}
                                        </Button>
                                    </Can>
                                </div>
                                <Form form={form} layout="vertical" onFinish={onSubmit}>
                                    <Form.List name="rules">
                                        {(fields, { add, remove }) => (
                                            <>
                                                {fields.length === 0 && (
                                                    <Empty description={dict.roles.emptyStates.noResourceAssigned} className="my-10" />
                                                )}
                                                {fields.map(({ key, name, ...rest }) => {
                                                    const selectedResourceArray = rulesWatch?.[name]?.resource;
                                                    const selectedResource = Array.isArray(selectedResourceArray) ? selectedResourceArray[0] : selectedResourceArray;
                                                    const currentConditions = form.getFieldValue(['rules', name, 'conditions']);
                                                    const hasConditions = !!currentConditions && currentConditions.trim() !== '';
                                                    const isInverted = rulesWatch?.[name]?.inverted;
                                                    const dbActions = selectedResource && groupedPermissions[selectedResource]
                                                        ? groupedPermissions[selectedResource].map(p => ({
                                                            value: p.action,
                                                            label: p.description ? `${p.description} (${p.action})` : p.action,
                                                        }))
                                                        : [];
                                                    const localActions = customActions
                                                        .filter(c => c.resource === selectedResource)
                                                        .map(c => ({
                                                        value: c.action,
                                                        label: c.description ? `${c.description} (${c.action})` : c.action,
                                                        }));
                                                    const actionOptions = [...dbActions, ...localActions].reduce((acc, current) => {
                                                        if (!acc.find(item => item.value === current.value)) acc.push(current);
                                                        return acc;
                                                    }, []);
                                                    const cardBgClass = isInverted 
                                                        ? 'bg-red-50/40 border-red-300 hover:border-red-400' 
                                                        : hasConditions 
                                                            ? 'bg-blue-50/30 border-blue-300 hover:border-blue-400' 
                                                            : 'bg-gray-50/50 border-borderColor hover:border-primary/50';

                                                    return (
                                                        <div key={key} className={`p-4 mb-4 border border-dashed rounded-xl transition-all ${cardBgClass}`}>
                                                            <Form.Item {...rest} name={[name, 'conditions']} hidden>
                                                                <Input />
                                                            </Form.Item>
                                                            <Row gutter={[8, 8]} align={'middle'}>
                                                                <Col xs={24} md={8} lg={4} xl={3} xxl={2}>
                                                                    <Form.Item
                                                                        {...rest}
                                                                        name={[name, 'inverted']}
                                                                        label={<span className="font-semibold text-gray-700">{dict.roles.form.accessLabel}</span>}
                                                                        className="mb-0"
                                                                        valuePropName="checked"
                                                                        initialValue={false}
                                                                    >
                                                                        <Switch
                                                                            checkedChildren={dict.roles.form.forbidden}
                                                                            unCheckedChildren={dict.roles.form.allowed}
                                                                            className={`${isInverted ? '!bg-accent' : '!bg-success'}`}
                                                                            disabled={ability.cannot('update', 'Role')}
                                                                            classNames={{content:'!text-[12px] font-bold'}}
                                                                        />
                                                                    </Form.Item>
                                                                </Col>
                                                                <Col xs={24} md={16} lg={8} xl={5} xxl={4}>
                                                                <Form.Item
                                                                    {...rest}
                                                                    name={[name, 'resource']}
                                                                    label={<span className="font-semibold text-gray-700">{dict.roles.form.resourceLabel}</span>}
                                                                    rules={[{ required: true, message: dict.roles.placeholders.selectOrAdd }]}
                                                                    className="mb-0"
                                                                >
                                                                    <Select
                                                                        mode={isDevMode ? "tags" : undefined}
                                                                        maxCount={1}
                                                                        placeholder={dict.roles.placeholders.projectExample}
                                                                        options={resourceOptions}
                                                                        className="!bg-bgBase"
                                                                        disabled={ability.cannot('update', 'Role')}
                                                                    />
                                                                </Form.Item>
                                                                </Col>

                                                                {/* ۳. عملیات */}
                                                                <Col xs={24} md={12} lg={12} xl={9} xxl={11}>
                                                                    <Form.Item
                                                                        {...rest}
                                                                        name={[name, 'actions']}
                                                                        className="mb-0"
                                                                        label={
                                                                            <Flex className='!mt-[-2px]' align='center'>
                                                                                <span className="font-semibold text-gray-700 me-1">{dict.roles.form.actionsLabel}</span>
                                                                                <Tooltip title={dict.roles.tooltips.actionInfo}>
                                                                                    <i className="bi bi-info-circle text-gray-400" />
                                                                                </Tooltip>
                                                                            </Flex>
                                                                        }
                                                                    >
                                                                        <Select
                                                                            mode="multiple"
                                                                            allowClear
                                                                            placeholder={selectedResource ? dict.roles.placeholders.selectOrAdd : dict.roles.placeholders.selectFirst}
                                                                            options={actionOptions}
                                                                            disabled={ability.cannot('update', 'Role') || !selectedResource}
                                                                            tagRender={tagRender}
                                                                            maxTagCount="responsive"
                                                                            className='w-full !bg-bgBase'
                                                                            classNames={{root:'!h-[32px]'}}
                                                                            popupRender={isDevMode ? (menu) => (
                                                                                <>
                                                                                    {menu}
                                                                                    <Divider style={{ margin: '4px 0' }} />
                                                                                    <Space orientation="vertical" className="w-full px-2 pb-2 pt-1" onKeyDown={(e) => e.stopPropagation()}>
                                                                                        <Text type="secondary" className="text-xs">{dict.roles.form.defineNewAction}</Text>
                                                                                        <Space.Compact className="w-full">
                                                                                        <Input
                                                                                            placeholder={dict.roles.placeholders.actionCode}
                                                                                            value={dropdownInputs[name]?.action || ''}
                                                                                            onChange={e => setDropdownInputs(prev => ({...prev, [name]: {...prev[name], action: e.target.value}}))}
                                                                                            className="text-xs w-[50%]"
                                                                                        />
                                                                                        <Input
                                                                                            placeholder={dict.roles.placeholders.actionDesc}
                                                                                            value={dropdownInputs[name]?.desc || ''}
                                                                                            onChange={e => setDropdownInputs(prev => ({...prev, [name]: {...prev[name], desc: e.target.value}}))}
                                                                                            className="text-xs"
                                                                                        />
                                                                                        <Button 
                                                                                            type="primary" 
                                                                                            icon={<i className="bi bi-plus-lg"/>} 
                                                                                            onClick={() => handleAddCustomAction(name, selectedResource)} 
                                                                                        />
                                                                                        </Space.Compact>
                                                                                    </Space>
                                                                                </>
                                                                            ) : undefined}
                                                                        />
                                                                    </Form.Item>
                                                                </Col>
                                                                <Col xs={24} md={12} lg={5} xl={5} xxl={5}>
                                                                    <Form.Item
                                                                        {...rest}
                                                                        name={[name, 'fields']}
                                                                        className="mb-0"
                                                                        label={
                                                                            <Flex className='mt-[2px]' align='center'>
                                                                                <span className="font-semibold text-gray-700 me-1">{dict.roles.form.fieldsLabel}</span>
                                                                                <Tooltip title={dict.roles.tooltips.fieldsInfo}>
                                                                                    <i className="bi bi-info-circle text-gray-400" />
                                                                                </Tooltip>
                                                                            </Flex>
                                                                        }
                                                                    >
                                                                        <Select
                                                                            mode="tags"
                                                                            allowClear
                                                                            placeholder={dict.roles.placeholders.salaryExample}
                                                                            className="w-full !bg-bgBase"
                                                                            tokenSeparators={[',', ' ']}
                                                                            maxTagCount="responsive"
                                                                            disabled={ability.cannot('update', 'Role')}
                                                                            options={[
                                                                                { value: '*', label: dict.roles.form.allFields, disabled:true },
                                                                            ]}
                                                                        />
                                                                    </Form.Item>
                                                                </Col>
                                                                <Col className="flex justify-center items-center lg:mt-[10px] xl:mt-0 2xl:mt-[9px] gap-2">
                                                                    <Tooltip title={hasConditions ? dict.roles.tooltips.editDynamicCondition : dict.roles.tooltips.addDynamicCondition}>
                                                                        <Badge dot={hasConditions} color={'var(--color-primary-active)'} offset={[-2, 3]}>
                                                                            <Button 
                                                                                type="default" 
                                                                                className={`roleActions flex items-center justify-center shadow-sm !ps-[1px] ${hasConditions ? 'bg-blue-100 text-blue-600' : 'bg-white text-gray-500'}`}
                                                                                icon={<i className="bi bi-braces text-[18px] !h-[18px] grid" />} 
                                                                                onClick={() => openConditionModal(name)}
                                                                            />
                                                                        </Badge>
                                                                    </Tooltip>
                                                                    <Can I={'update'} a={'Role'} ability={ability}>
                                                                        <Tooltip title={dict.roles.tooltips.deleteRule}>
                                                                            <Button 
                                                                                danger 
                                                                                type="text" 
                                                                                icon={<i className="bi bi-trash3 text-[18px] text-white grid" />} 
                                                                                onClick={() => remove(name)}
                                                                                className="flex items-center justify-center !bg-accent shadow-sm !w-[32px] shrink-0"
                                                                            />
                                                                        </Tooltip>
                                                                    </Can>
                                                                </Col>
                                                            </Row>
                                                        </div>
                                                    );
                                                })}
                                                <Can I={'update'} a={'Role'} ability={ability}>
                                                    <Button
                                                        type="dashed"
                                                        onClick={() => add({ resource: [], actions: [], conditions: '', inverted: false })}
                                                        block
                                                        icon={<i className="bi bi-plus-lg"/>}
                                                        className="h-12 border-primary/40 text-primary hover:bg-primary/5 rounded-xl mt-2"
                                                    >
                                                        {dict.roles.buttons.addResource}
                                                    </Button>
                                                </Can>
                                            </>
                                        )}
                                    </Form.List>
                                </Form>
                            </div>
                        ) : (
                            <div className="h-full flex flex-col justify-center items-center py-10">
                                <Empty description={dict.roles.emptyStates.selectRole} />
                            </div>
                        )}
                    </Content>
                </div>
            </Layout>
            <Modal
                title={
                    <Space>
                        <i className="bi bi-braces text-primary text-xl" />
                        <span>{dict.roles.modals.abacTitle}</span>
                    </Space>
                }
                open={conditionModal.visible}
                onOk={saveConditions}
                onCancel={() => setConditionModal({ visible: false, index: null, value: '' })}
                okText={dict.roles.buttons.submitCondition}
                cancelText={dict.roles.buttons.cancel}
                okButtonProps={{disabled:ability.cannot('update','Role')}}
                destroyOnHidden
                width={600}
                classNames={{
                    container:'!bg-bgSurface',
                    header: '!border-b !border-borderColor !bg-bgSurface',
                    body: '!bg-bgSurface !p-3',
                }}
            >
                <div className="bg-gray-50 p-3 rounded-lg border border-gray-200 mb-4 text-sm leading-6">
                    <p className="mb-2 text-gray-600">
                        {dict.roles.modals.abacHelpText}
                    </p>
                    <ul className="list-disc ps-5 text-gray-500 mb-0 space-y-1">
                        <li>{dict.roles.modals.simpleConditionExample}<Text code dir="ltr">{`{ "status": { "$ne": "archived" } }`}</Text></li>
                        <li>{dict.roles.modals.dynamicConditionExample}<Text code dir="ltr">{`{ "owner_id": "\${user.id}" }`}</Text></li>
                    </ul>
                </div>
                <Input.TextArea
                    rows={8}
                    dir="ltr"
                    className="font-mono text-[14px] !bg-bgBase !text-textBase rounded-lg"
                    placeholder={`{\n  "status": 1\n}`}
                    value={conditionModal.value}
                    onChange={(e) => setConditionModal(prev => ({ ...prev, value: e.target.value }))}
                    disabled={ability.cannot('update', 'Role')}
                />
            </Modal>
            <Modal
                title={
                    <Space>
                        <i className="bi bi-shield-lock text-primary text-xl" />
                        <span>{dict.roles.modals.newRoleTitle}</span>
                    </Space>
                }
                open={isRoleModalVisible}
                onCancel={() => {
                    setIsRoleModalVisible(false);
                    roleForm.resetFields();
                }}
                okText={dict.roles.buttons.createRole}
                cancelText={dict.roles.buttons.cancel}
                confirmLoading={creatingRole}
                onOk={() => roleForm.submit()}
                destroyOnHidden
                classNames={{
                    container:'!bg-bgSurface',
                    header: '!bg-bgSurface',
                    body: '!bg-bgSurface !p-3',
                }}
            >
                <div className="bg-blue-50/50 p-3 rounded-lg border border-blue-100 mb-5 mt-2 text-sm text-blue-800 leading-6">
                    <i className="bi bi-info-circle me-2"></i>
                    <Text strong className="text-blue-900">{dict.roles.form.slugLabel}:</Text> {dict.roles.modals.slugHelpText}<br/>
                    <i className="bi bi-dot me-2"></i>
                    <Text strong className="text-blue-900">{dict.roles.form.displayTitleLabel}:</Text> {dict.roles.modals.titleHelpText}
                </div>
                
                <Form form={roleForm} layout="vertical" onFinish={handleCreateRoleSubmit}>
                <Form.Item
                    name="name"
                    label={dict.roles.form.slugLabel}
                    rules={[
                    { required: true, message: dict.roles.validation.slugRequired },
                    { pattern: /^[a-zA-Z0-9_]+$/, message: dict.roles.validation.slugPattern }
                    ]}
                >
                    <Input placeholder={dict.roles.placeholders.slugExample} dir="ltr" className="!bg-bgBase font-mono" />
                </Form.Item>
                
                <Form.Item
                    name="label"
                    label={dict.roles.form.displayTitleLabel}
                    rules={[{ required: true, message: dict.roles.validation.titleRequired }]}
                >
                    <Input placeholder={dict.roles.placeholders.titleExample}  className="!bg-bgBase"/>
                </Form.Item>
                <Form.Item
                    name="level"
                    label={dict.roles.form.levelLabel}
                    initialValue={10}
                    rules={[
                        { required: true, message: dict.roles.validation.levelRequired },
                        { type: 'number', min:1, max: profile?.level || 100, message: dict.roles.validation.levelMaxError}
                    ]}
                >
                    <InputNumber
                        min={1}
                        max={100}
                        className="!w-full !bg-bgBase " 
                        placeholder={dict.roles.placeholders.levelExample}
                        
                    />
                </Form.Item>
                </Form>
            </Modal>
        </>
    )
}

export default RolesPage