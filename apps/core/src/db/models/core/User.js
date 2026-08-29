import DefaultModel from './Default';
import Session from './Session';
import Account from './Account';
import Role from './Role';
import UserOrganizationRole from './UserOrganizationRole';

class User extends DefaultModel {
  static get tableName() {
    return 'user';
  }

  static get idColumn() {
    return 'id';
  }

  static get jsonSchema() {
    return {
      type: 'object',
      required: ['name'],
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        email: { type: 'string' },
        emailVerified: { type: 'boolean' },
        image: { type: ['string', 'null'] },
        role_id: { type: 'integer' },
        username: { type: 'string' },
        displayUsername: { type: 'string' },
        is_active: { type: 'boolean', default: true },
        createdAt: { type: 'string', format: 'date-time' },
        updatedAt: { type: 'string', format: 'date-time' }
      }
    };
  }

  static get relationMappings() {
    return {
      sessions: {
        relation: DefaultModel.HasManyRelation,
        modelClass: () => Session,
        join: {
          from: 'user.id',
          to: 'session.userId'
        }
      },
      accounts: {
        relation: DefaultModel.HasManyRelation,
        modelClass: () => Account,
        join: {
          from: 'user.id',
          to: 'account.userId'
        }
      },
      role: {
        relation: DefaultModel.BelongsToOneRelation,
        modelClass: () => Role,
        join: {
          from: 'user.role_id',
          to: 'roles.id'
        }
      },
      memberships: {
        relation: DefaultModel.HasManyRelation,
        modelClass: () => UserOrganizationRole,
        join: {
          from: 'user.id',
          to: 'user_organization_roles.user_id'
        }
      }
    };
  }
}

export default User