// controllers/AuthController.js (یا هر جایی که روت session رو ساختی)
import UserOrganizationRole from '@/db/models/core/UserOrganizationRole';
import { AppError } from '@/lib/AppError';

export const fetch = async (req, res) => {
    const isMultiOrg = process.env.IS_MULTI_ORG === 'true';
    let memberships = null;
    if (isMultiOrg && req.user) {
        memberships = await UserOrganizationRole.query()
            .where('user_id', req.user.id)
            .withGraphFetched('[organization, role]')
            .modifyGraph('organization', builder => builder.select('id', 'name', 'slug', 'is_active'))
            .modifyGraph('role', builder => builder.select('id', 'name', 'label'));

        memberships = memberships.map(m => ({
            org_id: m.organization.id,
            org_name: m.organization.name,
            org_slug: m.organization.slug,
            is_active:m.organization.is_active,
            role_id: m.role.id,
            role_name: m.role.name,
            role_label: m.role.label
        }));
    }
    res.json({
        user: req.user,
        roleName: req.roleName,
        rules: req.ability.rules,
        memberships: memberships
    });
};