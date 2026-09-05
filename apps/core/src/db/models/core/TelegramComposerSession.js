import DefaultModel from './Default.js';
import Organization from './Organization.js';
import User from './User.js';
import Campaign from './Campaign.js';

class TelegramComposerSession extends DefaultModel {
  static get tableName() {
    return 'telegram_composer_sessions';
  }

  static get idColumn() {
    return 'id';
  }

  static get jsonAttributes() {
    return ['context_json'];
  }

  static get jsonSchema() {
    return {
      type: 'object',
      required: ['telegram_user_id', 'telegram_chat_id', 'organization_id', 'state'],
      properties: {
        id: { type: 'integer' },
        telegram_user_id: { type: 'string', minLength: 1, maxLength: 255 },
        telegram_chat_id: { type: 'string', minLength: 1, maxLength: 255 },
        user_id: { type: ['string', 'null'], maxLength: 255 },
        organization_id: { type: 'integer' },
        campaign_id: { type: ['integer', 'null'] },
        state: { type: 'string', minLength: 1, maxLength: 50 },
        context_json: {
          anyOf: [
            { type: 'object' },
            { type: 'null' },
          ],
        },
        expires_at: { type: ['string', 'null'], format: 'date-time' },
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
          from: 'telegram_composer_sessions.user_id',
          to: 'user.id',
        },
      },
      organization: {
        relation: DefaultModel.BelongsToOneRelation,
        modelClass: () => Organization,
        join: {
          from: 'telegram_composer_sessions.organization_id',
          to: 'organizations.id',
        },
      },
      campaign: {
        relation: DefaultModel.BelongsToOneRelation,
        modelClass: () => Campaign,
        join: {
          from: 'telegram_composer_sessions.campaign_id',
          to: 'campaigns.id',
        },
      },
    };
  }
}

export default TelegramComposerSession;
