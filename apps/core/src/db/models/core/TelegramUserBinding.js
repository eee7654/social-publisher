import DefaultModel from './Default.js';
import Organization from './Organization.js';
import User from './User.js';

class TelegramUserBinding extends DefaultModel {
  static get tableName() {
    return 'telegram_user_bindings';
  }

  static get idColumn() {
    return 'id';
  }

  static get jsonSchema() {
    return {
      type: 'object',
      required: ['telegram_user_id', 'user_id', 'organization_id'],
      properties: {
        id: { type: 'integer' },
        telegram_user_id: { type: 'string', minLength: 1, maxLength: 255 },
        user_id: { type: 'string', minLength: 1, maxLength: 255 },
        organization_id: { type: 'integer' },
        is_default: { type: 'boolean' },
        is_active: { type: 'boolean' },
        created_at: { type: ['string', 'null'], format: 'date-time' },
        updated_at: { type: ['string', 'null'], format: 'date-time' },
      },
    };
  }

  static get relationMappings() {
    return {
      user: {
        relation: DefaultModel.BelongsToOneRelation,
        modelClass: () => User,
        join: {
          from: 'telegram_user_bindings.user_id',
          to: 'user.id',
        },
      },
      organization: {
        relation: DefaultModel.BelongsToOneRelation,
        modelClass: () => Organization,
        join: {
          from: 'telegram_user_bindings.organization_id',
          to: 'organizations.id',
        },
      },
    };
  }
}

export default TelegramUserBinding;
