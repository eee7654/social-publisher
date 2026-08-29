import Organization from '@/db/models/core/Organization';
import { permittedFieldsOf } from '@casl/ability/extra';
import { subject, ForbiddenError } from '@casl/ability';
import { ErrorCodes, SuccessCodes } from '@/constants/responseCodes';
import { AppError } from '@/lib/AppError';

export const fetch = async (req, res) => {
    const { page = 1, search = '' } = req.query;
    const MAX_LIMIT = 50;
    const safeLimit = Math.min(Number(req.query.limit) || 10, MAX_LIMIT); 
    const safePage = Math.max(Number(page) || 1, 1);
    let allowedFields = permittedFieldsOf(req.ability, 'read', 'Organization', { 
        fieldsFrom: rule => rule.fields || Organization.schemaColumns
    });
    if (!allowedFields || allowedFields.length === 0) {
        allowedFields = Organization.schemaColumns;
    }
    allowedFields = Organization.attachPrefix(allowedFields);
    if (search) {
        const result = await Organization.query()
            .select(allowedFields)
            .select(Organization.relatedQuery('memberships').count().as('members_count'))
            .accessibleBy(req.ability, 'read')
            .where(builder => {
                builder.where('name', 'like', `%${search}%`)
                .orWhere('slug', 'like', `%${search}%`);
            })
            .orderBy('created_at', 'desc')
            .page(safePage - 1, safeLimit);
        return res.json({
            data: result.results,
            total: result.total,
            page: safePage,
            limit: safeLimit,
            _meta: { allowedFields, isTree: false }
        });
    }
    const query = Organization.query()
        .select(allowedFields)
        .select(Organization.relatedQuery('memberships').count().as('members_count'))
        .accessibleBy(req.ability, 'read')
        .orderBy('created_at', 'desc')
        .withGraphFetched('children.^')
        .modifyGraph('children', builder => {
            builder.select(allowedFields)
            .select(Organization.relatedQuery('memberships').count().as('members_count'))
            .accessibleBy(req.ability, 'read')
            .orderBy('created_at', 'desc');
        })
    if (req.roleName === 'admin') {
        query.whereNull('parent_id');
    } else {
        query.where('id', req.user.current_org_id);
    }
    const result = await query.page(safePage - 1, safeLimit);
    res.json({
        data: cleanTree(result.results),
        total: result.total,
        page: safePage,
        limit: safeLimit,
        _meta: { allowedFields, isTree: true }
    });
};

export const create = async (req, res) => {
    const orgData = req.body;
    ForbiddenError.from(req.ability).throwUnlessCan('create', subject('Organization', orgData));
    const trx = await Organization.startTransaction();
    try {
        let parentOrg = null;
        if (orgData.parent_id) {
            parentOrg = await Organization.query(trx).findById(orgData.parent_id);
            if (!parentOrg) {
                throw new AppError(ErrorCodes.ORG_NOT_FOUND);
            }
        }
        const newOrg = await Organization.query(trx).insert({
            name: orgData.name,
            slug: orgData.slug,
            parent_id: orgData.parent_id || null,
            description: orgData.description,
            is_active: orgData.is_active ?? true
        });
        const calculatedPath = parentOrg 
            ? `${parentOrg.path}${newOrg.id}/` 
            : `/${newOrg.id}/`;
        const finalOrg = await Organization.query(trx).patchAndFetchById(newOrg.id, {
            path: calculatedPath
        });
        await trx.commit();
        res.status(201).json({
            message: 'سازمان با موفقیت ایجاد شد',
            data: finalOrg
        });
    } catch (error) {
        await trx.rollback();
        
        if (error.name === 'ForbiddenError') {
            return res.status(403).json({ message: 'شما دسترسی ایجاد سازمان در این زیرمجموعه را ندارید' });
        }
        res.status(500).json({ message: error.message });
    }
};

export const update = async (req, res) => {
    const { id } = req.params;
    const updateData = req.body;
    const org = await Organization.query().findById(id);
    if (!org) {
        throw new AppError(404, ErrorCodes.ORG_NOT_FOUND); 
    }
    ForbiddenError.from(req.ability).throwUnlessCan('update', subject('Organization', org));
    delete updateData.id; 
    delete updateData.created_at;
    const updatedOrg = await Organization.query().patchAndFetchById(id, updateData);
    res.json({
        message: SuccessCodes.ORG_UPDATED_SUCCESSFULLY,
        data: updatedOrg
    });
};

export const lookup = async (req, res) => {
    const organs = await Organization.query()
        .select('id', 'name', 'parent_id', 'slug') 
        .where('is_active', true)
        .accessibleBy(req.ability, 'read')
        .orderBy('created_at', 'asc');
    res.json({
        data: organs
    });
};


const cleanTree = (nodes) => {
    if (!nodes) return [];
    
    return nodes.map(node => {
        const plainNode = typeof node.toJSON === 'function' ? node.toJSON() : { ...node };
        if (plainNode.children) {
            if (plainNode.children.length === 0) {
                delete plainNode.children;
            } else {
                plainNode.children = cleanTree(plainNode.children);
            }
        }
        
        return plainNode;
    });
};