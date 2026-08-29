import { auth } from "@/config/auth";
import { ErrorCodes, SuccessCodes } from "@/constants/responseCodes";
import Role from "@/db/models/core/Role";
import User from "@/db/models/core/User";
import Organization from '@/db/models/core/Organization';
import UserOrganizationRole from '@/db/models/core/UserOrganizationRole';
import { AppError } from "@/lib/AppError";
import { permittedFieldsOf } from '@casl/ability/extra';
import { ForbiddenError, subject } from '@casl/ability';

export const updateProfile = async (req, res) => {
    const { name, currentPassword, newPassword, avatar } = req.body;
    let updatedFields = {};
    const authUpdateData = {};
    if (name) authUpdateData.name = name;
    if (avatar) authUpdateData.image = avatar;
    //custom fields if (sheba_id !== undefined) authUpdateData.sheba_id = sheba_id;
    if(Object.keys(authUpdateData).length > 0){
        const { error } = await auth.api.updateUser({
            body: authUpdateData,
            headers: req.headers
        });
        if (error) {
            throw new AppError(400, error.code || ErrorCodes.GEN_UPDATE_FAILED);
        }
        updatedFields = { ...updatedFields, ...authUpdateData };
    }
    if (currentPassword && newPassword) {
        const { error } = await auth.api.changePassword({
            body: {
                currentPassword,
                newPassword,
                revokeOtherSessions: true
            },
            headers: req.headers
        });
        if (error) {
            throw new AppError(400, ErrorCodes.INVALID_PASSWORD || 'INVALID_PASSWORD');
        }
        updatedFields.passwordChanged = true;
    }
    if (Object.keys(updatedFields).length === 0) {
        throw new AppError(400, ErrorCodes.GEN_VALIDATION_FAILED);
    }
    return res.status(200).json({ 
        status: 'ok', 
        code: SuccessCodes.USER_UPDATED_SUCCESSFULLY || 'UPDATE_SUCCESS',
        data: updatedFields
    });
}

export const updateUser = async (req, res) => {
    const { id } = req.params;
    const { memberships, role_id, ...basicData } = req.body; 
    const isMultiOrg = process.env.IS_MULTI_ORG === 'true';
    const targetUser = await User.query()
        .findById(id)
        .withGraphFetched('memberships.organization');
    if (!targetUser) throw new AppError(404, ErrorCodes.USER_NOT_FOUND);
    const trx = await User.startTransaction();
    try {
        if (Object.keys(basicData).length > 0) {
            ForbiddenError.from(req.ability).throwUnlessCan('update', subject('User', targetUser));
            await User.query(trx).patch(basicData).findById(id);
        }
        const hasRoleUpdate = isMultiOrg ? memberships !== undefined : role_id !== undefined;
        if (hasRoleUpdate) {
            ForbiddenError.from(req.ability).throwUnlessCan('manage_roles', subject('User', targetUser));
            if (isMultiOrg && memberships) {
                const newOrgIds = memberships.map(m => m.organization_id);
                if (newOrgIds.length > 0) {
                    const accessibleOrgs = await Organization.query(trx)
                    .whereIn('id', newOrgIds)
                    .accessibleBy(req.ability, 'read');
                    if (accessibleOrgs.length !== newOrgIds.length) {
                        throw new AppError(403, ErrorCodes.ORG_NOT_ENOUGH_ACCESS);
                    }
                    const roleIds = memberships.map(m => m.role_id);
                    const targetRoles = await Role.query(trx).whereIn('id', roleIds);
                    const hasHigherRole = targetRoles.some(r => r.level > req.user.level);
                    if (hasHigherRole) {
                        throw new AppError(403, ErrorCodes.ROLE_INSUFFICIENT_LEVEL);
                    }
                }
                await UserOrganizationRole.query(trx).where('user_id', id).delete();
                if (memberships.length > 0) {
                    const newMemberships = memberships.map(m => ({
                        user_id: id,
                        organization_id: m.organization_id,
                        role_id: m.role_id
                    }));
                    await UserOrganizationRole.query(trx).insertGraph(newMemberships);
                }

            } else if (!isMultiOrg && role_id) {
                const targetRole = await Role.query(trx).findById(role_id);
                if (!targetRole) throw new AppError(404, ErrorCodes.ROLE_NOT_FOUND);
                if (targetRole.level > req.user.level) {
                    throw new AppError(403, ErrorCodes.ROLE_INSUFFICIENT_LEVEL);
                }
                await User.query(trx).patch({ role_id });
            }
        }
        await trx.commit();
        return res.status(200).json({ 
            status: 'ok', 
            code: SuccessCodes.USER_UPDATED_SUCCESSFULLY
        });
    } catch (error) {
        await trx.rollback();
        throw error; 
    }
};

export const fetch = async (req, res) => {
    const { page = 1, limit = 10, search = '', orgId } = req.query;
    const safeLimit = Math.min(Number(limit), 50);
    const safePage = Math.max(Number(page), 1);
    const isMultiOrg = process.env.IS_MULTI_ORG === 'true';
    let allowedFields = permittedFieldsOf(req.ability, 'read', 'User', { 
        fieldsFrom: rule => rule.fields || User.schemaColumns
    });
    if (!allowedFields || allowedFields.length === 0) allowedFields = User.schemaColumns;
    allowedFields = User.attachPrefix(allowedFields);
    const query = User.query()
        .select(allowedFields)
        .accessibleBy(req.ability, 'read')
        .orderBy('user.createdAt', 'desc');
    if (isMultiOrg) {
        const targetOrgId = orgId ? Number(orgId) : req.user.current_org_id;
        if (targetOrgId) {
            if (req.roleName !== 'admin') {
                const targetOrg = await Organization.query().findById(targetOrgId);
                if (!targetOrg) throw new AppError(404, ErrorCodes.ORG_NOT_FOUND);
                ForbiddenError.from(req.ability).throwUnlessCan('read', subject('Organization', targetOrg));
            }
            query.joinRelated('memberships')
            .where('memberships.organization_id', targetOrgId);
            query.withGraphFetched('memberships.[organization, role]');
        }
    } else {
        query.withGraphFetched('role');
    }
    if (search) {
        query.where(builder => {
            builder.where('full_name', 'like', `%${search}%`)
                .orWhere('email', 'like', `%${search}%`)
                .orWhere('username', 'like', `%${search}%`);
        });
    }
    const result = await query.page(safePage - 1, safeLimit);
    res.json({
        data: result.results,
        total: result.total,
        page: safePage,
        limit: safeLimit,
        _meta: { 
            allowedFields,
            isMultiOrg
        }
    });
};

export const create = async (req, res) => {
    const { name, username, email, password, is_active, memberships, role_id } = req.body;
    const isMultiOrg = process.env.IS_MULTI_ORG === 'true';
    if (isMultiOrg && memberships && memberships.length > 0) {
        const newOrgIds = memberships.map(m => m.organization_id);
        const newRoleIds = memberships.map(m => m.role_id);
        const accessibleOrgs = await Organization.query()
        .whereIn('id', newOrgIds)
        .accessibleBy(req.ability, 'read');
        if (accessibleOrgs.length !== newOrgIds.length) {
            throw new AppError(403, ErrorCodes.ORG_NOT_ENOUGH_ACCESS);
        }
        const targetRoles = await Role.query().whereIn('id', newRoleIds);
        const hasHigherRole = targetRoles.some(r => r.level > req.user.level);
        if (hasHigherRole) {
            throw new AppError(403, ErrorCodes.ROLE_INSUFFICIENT_LEVEL);
        }

    } else if (!isMultiOrg && role_id) {
        const targetRole = await Role.query().findById(role_id);
        if (!targetRole) throw new AppError(404, ErrorCodes.ROLE_NOT_FOUND);
        if (targetRole.level > req.user.level) {
            throw new AppError(403, ErrorCodes.ROLE_INSUFFICIENT_LEVEL);
        }
    }
    const authResponse = await auth.api.signUpEmail({
        body: {
            name,
            username,
            displayUsername:username,
            email,
            password,
            is_active,
            ...(!isMultiOrg && { role_id })
        }
    });
    const newUserId = authResponse.user.id;
    const trx = await User.startTransaction();
    try {
        await User.query(trx).patchAndFetchById(newUserId, {
            emailVerified: true,
        });
        if (isMultiOrg && memberships && memberships.length > 0) {
            const newMemberships = memberships.map(m => ({
                user_id: newUserId,
                organization_id: m.organization_id,
                role_id: m.role_id
            }));
            await UserOrganizationRole.query(trx).insert(newMemberships);
        }
        await trx.commit();
        return res.status(201).json({ 
            status: 'ok', 
            code: SuccessCodes.USER_CREATED_SUCCESSFULLY || 'CREATE_SUCCESS',
            data: { id: newUserId, name, email } 
        });

    } catch (error) {
        await trx.rollback();
        await User.query().deleteById(newUserId);
        if (error.name === 'UniqueViolationError' || error.code === '23505' || error.code === 'ER_DUP_ENTRY') {
            throw new AppError(400, ErrorCodes.USER_EXISTS);
        }
        throw error;
    }
};