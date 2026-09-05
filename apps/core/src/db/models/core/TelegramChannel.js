import DefaultModel from './Default.js';
import Organization from './Organization.js';
import User from './User.js';
import IntegrationConfig from './IntegrationConfig.js';

class TelegramChannel extends DefaultModel {
  static get tableName() {
    return 'telegram_channels';
  }

  static get idColumn() {
    return 'id';
  }

  static get jsonSchema() {
    return {
      type: 'object',
      required: ['organization_id', 'chat_id'],
      properties: {
        id: { type: 'integer' },
        organization_id: { type: 'integer' },
        integration_config_id: { type: ['integer', 'null'] },
        chat_id: { type: 'string', minLength: 1, maxLength: 255 },
        username: { type: ['string', 'null'], maxLength: 255 },
        title: { type: ['string', 'null'], maxLength: 255 },
        owner_user_id: { type: ['string', 'null'], maxLength: 255 },
        is_active: { type: 'boolean' },
        created_at: { type: ['string', 'null'], format: 'date-time' },
        updated_at: { type: ['string', 'null'], format: 'date-time' },
      },
    };
  }

  static get relationMappings() {
    return {
      organization: {
        relation: DefaultModel.BelongsToOneRelation,
        modelClass: () => Organization,
        join: {
          from: 'telegram_channels.organization_id',
          to: 'organizations.id',
        },
      },
      integrationConfig: {
        relation: DefaultModel.BelongsToOneRelation,
        modelClass: () => IntegrationConfig,
        join: {
          from: 'telegram_channels.integration_config_id',
          to: 'integration_configs.id',
        },
      },
      owner: {
        relation: DefaultModel.BelongsToOneRelation,
        modelClass: () => User,
        join: {
          from: 'telegram_channels.owner_user_id',
          to: 'user.id',
        },
      },
    };
  }
}

export default TelegramChannel;
