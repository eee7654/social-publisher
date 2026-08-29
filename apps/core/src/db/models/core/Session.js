import DefaultModel from './Default.js';
import User from './User.js';

class Session extends DefaultModel {
  static get tableName() {
    return 'session';
  }

  static get relationMappings() {
    return {
      user: {
        relation: DefaultModel.BelongsToOneRelation,
        modelClass: ()=> User,
        join: {
          from: 'session.userId',
          to: 'user.id'
        }
      }
    };
  }
}

export default Session