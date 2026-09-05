import DefaultModel from './Default.js';
import User from './User.js';
import Organization from './Organization.js';
import IntegrationProvider from './IntegrationProvider.js';

class IntegrationConnectionIntent extends DefaultModel {
  static get tableName() { return 'integration_connection_intents'; }
  static get idColumn() { return 'id'; }

  static get jsonSchema() {
    return {
      type: 'object',
      required: ['id', 'nonce_hash', 'user_id', 'organization_id', 'provider_id', 'purpose', 'status', 'expires_at'],
      properties: {
        id: { type: 'string', minLength: 1, maxLength: 36 },
        nonce_hash: { type: 'string', minLength: 64, maxLength: 64 },
        browser_ticket_hash: { type: ['string', 'null'], minLength: 64, maxLength: 64 },
        user_id: { type: 'string', minLength: 1, maxLength: 255 },
        organization_id: { type: 'integer' }, provider_id: { type: 'integer' },
        telegram_user_id: { type: ['string', 'null'], maxLength: 255 },
        telegram_chat_id: { type: ['string', 'null'], maxLength: 255 },
        purpose: { type: 'string', minLength: 1, maxLength: 80 },
        source: { type: 'string', minLength: 1, maxLength: 32 },
        status: { type: 'string', minLength: 1, maxLength: 32 },
        pkce_verifier_encrypted: { type: ['string', 'null'] }, pending_secret_json: { type: ['object', 'null'] },
        verified_channel_id: { type: ['string', 'null'], maxLength: 255 }, verified_channel_title: { type: ['string', 'null'], maxLength: 512 },
        expires_at: { type: 'string', format: 'date-time' },
        reserved_at: { type: ['string', 'null'], format: 'date-time' },
        browser_ticket_reserved_at: { type: ['string', 'null'], format: 'date-time' },
        consumed_at: { type: ['string', 'null'], format: 'date-time' },
        callback_stage: { type: ['string', 'null'], maxLength: 64 },
        failure_stage: { type: ['string', 'null'], maxLength: 64 },
        failure_http_status: { type: ['integer', 'null'] },
        failure_error_code: { type: ['string', 'null'], maxLength: 120 },
        failure_error_reason: { type: ['string', 'null'], maxLength: 120 },
        failure_message: { type: ['string', 'null'], maxLength: 512 },
        granted_scopes_json: { type: ['array', 'null'] },
        token_access_present: { type: ['boolean', 'null'] },
        token_refresh_present: { type: ['boolean', 'null'] },
        token_expiry_present: { type: ['boolean', 'null'] },
        channel_items_count: { type: ['integer', 'null'] },
      },
    };
  }

  static get relationMappings() {
    return {
      user: { relation: DefaultModel.BelongsToOneRelation, modelClass: () => User, join: { from: 'integration_connection_intents.user_id', to: 'user.id' } },
      organization: { relation: DefaultModel.BelongsToOneRelation, modelClass: () => Organization, join: { from: 'integration_connection_intents.organization_id', to: 'organizations.id' } },
      provider: { relation: DefaultModel.BelongsToOneRelation, modelClass: () => IntegrationProvider, join: { from: 'integration_connection_intents.provider_id', to: 'integration_providers.id' } },
    };
  }
}

export default IntegrationConnectionIntent;
