import DefaultModel from './Default.js';
import Organization from './Organization.js';
import User from './User.js';
import IntegrationProvider from './IntegrationProvider.js';
import IntegrationEvent from './IntegrationEvent.js';
import CampaignTarget from './CampaignTarget.js';

class IntegrationConfig extends DefaultModel {
  static get tableName() {
    return 'integration_configs';
  }

  static get idColumn() {
    return 'id';
  }

  static get jsonSchema() {
    return {
      type: 'object',
      required: ['provider_id', 'name', 'config_json'],
      properties: {
        id: { type: 'integer' },
        provider_id: { type: 'integer' },
        organization_id: { type: ['integer', 'null'] },
        name: { type: 'string', minLength: 1, maxLength: 255 },
        config_json: {
          anyOf: [
            { type: 'object' },
            { type: 'array' },
          ],
        },
        is_default: { type: 'boolean' },
        status: { type: 'string', maxLength: 255 },
        created_by: { type: ['string', 'null'], maxLength: 255 },
        
        external_account_id: { type: ['string', 'null'], maxLength: 255 },
        external_account_name: { type: ['string', 'null'], maxLength: 255 },
        metadata_json: {
          anyOf: [
            { type: 'object' },
            { type: 'array' },
            { type: 'null' },
          ],
        },
        expires_at: { type: ['string', 'null'], format: 'date-time' },
        last_verified_at: { type: ['string', 'null'], format: 'date-time' },
        
        created_at: { type: ['string', 'null'], format: 'date-time' },
        updated_at: { type: ['string', 'null'], format: 'date-time' },
        deleted_at: { type: ['string', 'null'], format: 'date-time' },
      },
    };
  }

  static get relationMappings() {
    return {
      provider: {
        relation: DefaultModel.BelongsToOneRelation,
        modelClass: () => IntegrationProvider,
        join: {
          from: 'integration_configs.provider_id',
          to: 'integration_providers.id',
        },
      },
      organization: {
        relation: DefaultModel.BelongsToOneRelation,
        modelClass: () => Organization,
        join: {
          from: 'integration_configs.organization_id',
          to: 'organizations.id',
        },
      },
      createdBy: {
        relation: DefaultModel.BelongsToOneRelation,
        modelClass: () => User,
        join: {
          from: 'integration_configs.created_by',
          to: 'user.id',
        },
      },
      events: {
        relation: DefaultModel.HasManyRelation,
        modelClass: () => IntegrationEvent,
        join: {
          from: 'integration_configs.id',
          to: 'integration_events.config_id',
        },
      },
      campaignTargets: {
        relation: DefaultModel.HasManyRelation,
        modelClass: () => CampaignTarget,
        join: {
          from: 'integration_configs.id',
          to: 'campaign_targets.integration_config_id',
        },
      },
    };
  }
}

export default IntegrationConfig;
