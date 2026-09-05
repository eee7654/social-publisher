import DefaultModel from './Default.js';

class Permission extends DefaultModel {
  static get tableName() { return 'permissions'; }
}

export default Permission;