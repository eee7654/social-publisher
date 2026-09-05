import DefaultModel from './Default.js';
import Organization from './Organization.js';
import User from './User.js';
import Asset from './Asset.js';
import CampaignTarget from './CampaignTarget.js';

class Campaign extends DefaultModel {
  static get tableName() {
    return 'campaigns';
  }

  static get idColumn() {
    return 'id';
  }

  static get jsonSchema() {
    return {
      type: 'object',
      required: ['organization_id', 'source_type', 'status'],
      properties: {
        id: { type: 'integer' },
        organization_id: { type: 'integer' },
        created_by: { type: ['string', 'null'], maxLength: 255 },
        source_type: { type: 'string', minLength: 1, maxLength: 255 },
        source_ref: { type: ['string', 'null'], maxLength: 255 },
        status: { type: 'string', maxLength: 255 },
        base_title: { type: ['string', 'null'], maxLength: 255 },
        base_caption: { type: ['string', 'null'] },
        cover_asset_id: { type: ['integer', 'null'] },
        created_at: { type: ['string', 'null'], format: 'date-time' },
        updated_at: { type: ['string', 'null'], format: 'date-time' },
        published_at: { type: ['string', 'null'], format: 'date-time' },
      },
    };
  }

  static get relationMappings() {
    return {
      organization: {
        relation: DefaultModel.BelongsToOneRelation,
        modelClass: () => Organization,
        join: {
          from: 'campaigns.organization_id',
          to: 'organizations.id',
        },
      },
      createdBy: {
        relation: DefaultModel.BelongsToOneRelation,
        modelClass: () => User,
        join: {
          from: 'campaigns.created_by',
          to: 'user.id',
        },
      },
      coverAsset: {
        relation: DefaultModel.BelongsToOneRelation,
        modelClass: () => Asset,
        join: {
          from: 'campaigns.cover_asset_id',
          to: 'assets.id',
        },
      },
      assets: {
        relation: DefaultModel.HasManyRelation,
        modelClass: () => Asset,
        join: {
          from: 'campaigns.id',
          to: 'assets.campaign_id',
        },
      },
      targets: {
        relation: DefaultModel.HasManyRelation,
        modelClass: () => CampaignTarget,
        join: {
          from: 'campaigns.id',
          to: 'campaign_targets.campaign_id',
        },
      },
    };
  }
}

export default Campaign;
