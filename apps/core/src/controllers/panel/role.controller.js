import { ErrorCodes, SuccessCodes } from "@/constants/responseCodes";
import Permission from "@/db/models/core/Permission";
import Role from "@/db/models/core/Role";
import { AppError } from "@/lib/AppError";
import { clearRoleCache } from "@/middlewares/requireAuth";

export const fetch = async(req, res)=>{
    const roles = await Role.query()
    .whereNot('name', 'admin')
    .where('level', '<', req.user.level)
    .withGraphFetched('permissions');
    const allPermissions = await Permission.query();
    const groupedPermissions = allPermissions.reduce((acc, perm) => {
        if (!acc[perm.resource]) acc[perm.resource] = [];
        acc[perm.resource].push(perm.toJSON());
        return acc;
    }, {});
    res.json({
        initialRoles:roles,
        groupedPermissions
    })
}

export const create = async(req,res)=>{
    const { name, label, level } = req.body;
    if (!name || !label || !level) throw new AppError(400, ErrorCodes.GEN_VALIDATION_FAILED);
    if (level > req.user.level) throw new AppError(403, ErrorCodes.ROLE_INSUFFICIENT_LEVEL);
    const findRole = await Role.query().findOne({name})
    if(findRole) throw new AppError(400, ErrorCodes.ROLE_DUPLICATE_NAME);
    await Role.query().insert({ name, label, level })
    res.json({status:'ok'})
}

export const update = async(req, res)=>{
    const { roleId, rules } = req.body;
    if (!roleId || !Array.isArray(rules)) throw new AppError(400, ErrorCodes.GEN_VALIDATION_FAILED);

    const targetRole = await Role.query().findById(roleId);
    if (!targetRole) throw new AppError(404, ErrorCodes.ROLE_NOT_FOUND);

    const trx = await Role.startTransaction();
    try {
        await trx('role_permissions').where({ role_id: roleId }).delete();
        const pivotInserts = [];
        for (const rule of rules) {
            const resource = rule.resource;
            const conditions = rule.conditions ? JSON.stringify(rule.conditions) : null;
            const fields = rule.fields && rule.fields.length > 0 ? JSON.stringify(rule.fields) : null;
            for (const act of rule.actions || []) {
                const actionSlug = act.action;
                const description = act.description || actionSlug;
                let perm = await Permission.query(trx).findOne({ 
                    resource: resource, 
                    action: actionSlug 
                });
                if (!perm) {
                    perm = await Permission.query(trx).insert({
                        resource: resource,
                        action: actionSlug,
                        description: description
                    });
                }
                pivotInserts.push({
                    role_id: roleId,
                    permission_id: perm.id,
                    conditions: conditions,
                    fields: fields,
                    inverted:rule.inverted ? 1 : 0
                });
            }
        }
        if (pivotInserts.length > 0) {
            await trx('role_permissions').insert(pivotInserts);
        }
        await trx.commit();
        clearRoleCache(roleId)
        return res.status(200).json({ 
            status: 'success',
            code:SuccessCodes.ROLE_CHANGED_SUCCESSFULLY
        });
    } catch (error) {
        await trx.rollback();
        throw error;
    }
}

export const lookup = async (req, res) => {
    const roles = await Role.query()
        .select('id', 'name', 'label')
        .where('level', '<=', req.user.level)
        .orderBy('id', 'asc');
    res.json({ data: roles });
};