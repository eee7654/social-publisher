import DefaultModel from './Default.js';
import Campaign from './Campaign.js';
import IntegrationConfig from './IntegrationConfig.js';
import Asset from './Asset.js';
import PublishJob from './PublishJob.js';

class CampaignTarget extends DefaultModel {
  static get tableName() {
    return 'campaign_targets';
  }

  static get idColumn() {
    return 'id';
  }

  static get jsonSchema() {
    return {
      type: 'object',
      required: ['campaign_id', 'integration_config_id', 'platform', 'status'],
      properties: {
        id: { type: 'integer' },
        campaign_id: { type: 'integer' },
        integration_config_id: { type: 'integer' },
        platform: { type: 'string', minLength: 1, maxLength: 255 },
        status: { type: 'string', maxLength: 255 },
        suggested_by_system: { type: 'boolean' },
        confirmed_by_user: { type: 'boolean' },
        asset_id: { type: ['integer', 'null'] },
        cover_asset_id: { type: ['integer', 'null'] },
        title_override: { type: ['string', 'null'], maxLength: 255 },
        caption_override: { type: ['string', 'null'] },
        settings_json: {
          anyOf: [
            { type: 'object' },
            { type: 'array' },
            { type: 'null' },
          ],
        },
        published_url: { type: ['string', 'null'], maxLength: 255 },
        external_post_id: { type: ['string', 'null'], maxLength: 255 },
        created_at: { type: ['string', 'null'], format: 'date-time' },
        updated_at: { type: ['string', 'null'], format: 'date-time' },
      },
    };
  }

  static get relationMappings() {
    return {
      campaign: {
        relation: DefaultModel.BelongsToOneRelation,
        modelClass: () => Campaign,
        join: {
          from: 'campaign_targets.campaign_id',
          to: 'campaigns.id',
        },
      },
      integrationConfig: {
        relation: DefaultModel.BelongsToOneRelation,
        modelClass: () => IntegrationConfig,
        join: {
          from: 'campaign_targets.integration_config_id',
          to: 'integration_configs.id',
        },
      },
      asset: {
        relation: DefaultModel.BelongsToOneRelation,
        modelClass: () => Asset,
        join: {
          from: 'campaign_targets.asset_id',
          to: 'assets.id',
        },
      },
      coverAsset: {
        relation: DefaultModel.BelongsToOneRelation,
        modelClass: () => Asset,
        join: {
          from: 'campaign_targets.cover_asset_id',
          to: 'assets.id',
        },
      },
      publishJobs: {
        relation: DefaultModel.HasManyRelation,
        modelClass: () => PublishJob,
        join: {
          from: 'campaign_targets.id',
          to: 'publish_jobs.campaign_target_id',
        },
      },
    };
  }
}

export default CampaignTarget;
