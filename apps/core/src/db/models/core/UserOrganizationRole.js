import DefaultModel from './Default';
import User from './User';
import Organization from './Organization';
import Role from './Role';

class UserOrganizationRole extends DefaultModel {
  static get tableName() { 
    return 'user_organization_roles'; 
  }

  static get relationMappings() {
    return {
      user: {
        relation: DefaultModel.BelongsToOneRelation,
        modelClass: User,
        join: {
          from: 'user_organization_roles.user_id',
          to: 'user.id'
        }
      },
      organization: {
        relation: DefaultModel.BelongsToOneRelation,
        modelClass: Organization,
        join: {
          from: 'user_organization_roles.organization_id',
          to: 'organizations.id'
        }
      },
      role: {
        relation: DefaultModel.BelongsToOneRelation,
        modelClass: Role,
        join: {
          from: 'user_organization_roles.role_id',
          to: 'roles.id'
        }
      }
    };
  }
}

export default UserOrganizationRole;