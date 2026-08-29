import DefaultModel from './Default';

class Account extends DefaultModel {
  static get tableName() {
    return 'account';
  }

  static get relationMappings() {
    const User = require('./User').default
    return {
      user: {
        relation: DefaultModel.BelongsToOneRelation,
        modelClass: ()=> User,
        join: {
          from: 'account.userId',
          to: 'user.id'
        }
      }
    };
  }
}

export default Account