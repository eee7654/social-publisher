import { LRUCache } from 'lru-cache';
import { createMongoAbility } from '@casl/ability';
import { auth } from '@/config/auth';
import Role from '@/db/models/core/Role';
import { ErrorCodes } from '@/constants/responseCodes';
import { AppError } from '@/lib/AppError';
import UserOrganizationRole from '@/db/models/core/UserOrganizationRole';

export const roleCache = new LRUCache({
    max: 50, 
    ttl: 1000 * 60 * 60 * 24,
});

export function clearRoleCache(roleId) {
    if (roleId) {
        roleCache.delete(String(roleId));
    } else {
        roleCache.clear();
    }
}

function interpolateRules(rules, user) {
    const exactRegex = /^\$\{user\.([a-zA-Z0-9_]+)\}$/; 
    const inlineRegex = /\$\{user\.([a-zA-Z0-9_]+)\}/g; 
    const parseValue = (value) => {
        if (typeof value === 'string') {
            const exactMatch = value.match(exactRegex);
            if (exactMatch) return user[exactMatch[1]];            
            if (value.includes('${user.')) {
                return value.replace(inlineRegex, (_, key) => user[key]);
            }
        }
        if (Array.isArray(value)) return value.map(item => parseValue(item));
        if (value !== null && typeof value === 'object') {
            const newObj = {};
            for (const key in value) newObj[key] = parseValue(value[key]);
            return newObj;
        }
        return value;
    };
    return parseValue(rules);
}

export const requireAuth = async (req, res, next) => {
    const sessionData = await auth.api.getSession({ headers: req.headers });
    if (!sessionData?.user) throw new AppError(401, ErrorCodes.AUTH_SESSION_EXPIRED);
    const user = sessionData.user;  
    const isMultiOrg = process.env.IS_MULTI_ORG === 'true';
    const orgIdFromHeader = req.headers['x-org-id'];  
    let roleId = null;
    if (isMultiOrg) {
        if (orgIdFromHeader) {
            const membership = await UserOrganizationRole.query()
                .where({ user_id: user.id, organization_id: orgIdFromHeader })
                .joinRelated('organization')
                .where('organization.is_active', true)
                .first();
            if (membership) {
                roleId = membership.role_id;
                user.current_org_id = Number(orgIdFromHeader);
            } else {
                roleId = null; 
            }
        }
    } else {
        roleId = user.role_id;
    }
    if (!roleId) {
        req.user = user;
        req.roleName = 'guest';
        req.ability = createMongoAbility([]);
        return await next();
    }
    const cacheKey = String(roleId);
    let cachedRoleData = roleCache.get(cacheKey);
    if (!cachedRoleData) {
        const role = await Role.query().findById(roleId).withGraphFetched('permissions');                
        if (!role) {
            throw new AppError(403, ErrorCodes.ROLE_NOT_FOUND);
        }
        let rawRules = [];
        if (role.name === 'admin') {
            rawRules = [{ action: 'manage', subject: 'all' }];
        } else if (role.permissions) {
            rawRules = role.permissions.map((perm) => {
                let rule = {
                    action: perm.action,
                    subject: perm.resource,
                    fields: perm.fields,
                    inverted: perm.inverted == 1
                };
                if (perm.conditions) {
                    rule.rawConditions = typeof perm.conditions === 'string' 
                        ? JSON.parse(perm.conditions) 
                        : perm.conditions;
                }    
                return rule;
            });
        }                       
        cachedRoleData = {
            name: role.name,
            level: role.level,
            rawRules: rawRules
        };
        roleCache.set(cacheKey, cachedRoleData);
    }   
    user.level = cachedRoleData.level;
    const finalRules = cachedRoleData.rawRules.map(({ action, subject, inverted, fields, rawConditions }) => ({
        action,
        subject,
        ...(inverted && { inverted }),
        ...(fields && { fields }),
        ...(rawConditions && { conditions: interpolateRules(rawConditions, user) })
    })); 
    req.user = user;
    req.roleName = cachedRoleData.name;
    req.orgId = user.current_org_id || null;
    req.ability = createMongoAbility(finalRules);
    return await next();
};