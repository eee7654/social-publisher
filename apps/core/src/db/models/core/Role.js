import DefaultModel from './Default.js';
import Permission from './Permission.js';

class Role extends DefaultModel {
  static get tableName() { return 'roles'; }

  static get relationMappings() {
    return {
      permissions: {
        relation: DefaultModel.ManyToManyRelation,
        modelClass: () => Permission,
        join: {
          from: 'roles.id',
          through: {
            from: 'role_permissions.role_id',
            to: 'role_permissions.permission_id',
            extra: ['conditions','fields', 'inverted']
          },
          to: 'permissions.id'
        },
        modify: (builder) => builder.orderBy('role_permissions.inverted', 'asc')
      }
    };
  }
}

export default Role