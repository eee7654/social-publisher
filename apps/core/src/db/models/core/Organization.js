import DefaultModel from './Default.js';
import UserOrganizationRole from './UserOrganizationRole.js'

class Organization extends DefaultModel {
  
  static get tableName() { 
    return 'organizations'; 
  }

  static get relationMappings() {
    return {
      memberships: {
        relation: DefaultModel.HasManyRelation,
        modelClass: UserOrganizationRole,
        join: {
          from: 'organizations.id',
          to: 'user_organization_roles.organization_id'
        }
      },
      children: {
        relation: DefaultModel.HasManyRelation,
        modelClass: Organization,
        join: {
          from: 'organizations.id',
          to: 'organizations.parent_id'
        }
      },
      parent: {
        relation: DefaultModel.BelongsToOneRelation,
        modelClass: Organization,
        join: {
          from: 'organizations.parent_id',
          to: 'organizations.id'
        }
      }
    };
  }

  static get jsonSchema() {
    return {
      type: 'object',
      required: ['name', 'slug'],
      properties: {
        id: { type: ['integer', 'string'] },
        name: { type: 'string', minLength: 1, maxLength: 255 },
        slug: { type: 'string', minLength: 1, maxLength: 120 },
        path: { type: 'string', minLength: 1, maxLength: 255 },
        is_active: { type: ['boolean', 'integer'] },
        parent_id: { type: ['integer', 'string', 'null'] },
        created_at: { type: 'string' },
        updated_at: { type: 'string' }
      }
    };
  }

}

export default Organization;