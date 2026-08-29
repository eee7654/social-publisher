import DefaultModel from './Default';

class Permission extends DefaultModel {
  static get tableName() { return 'permissions'; }
}

export default Permission;