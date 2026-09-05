import DefaultModel from './Default.js';
import Organization from './Organization.js';
import Campaign from './Campaign.js';

class Asset extends DefaultModel {
  static get tableName() {
    return 'assets';
  }

  static get idColumn() {
    return 'id';
  }

  static get jsonAttributes() {
    return ['probe_json'];
  }

  static get jsonSchema() {
    return {
      type: 'object',
      required: ['organization_id', 'kind', 'object_key'],
      properties: {
        id: { type: 'integer' },
        organization_id: { type: 'integer' },
        campaign_id: { type: ['integer', 'null'] },
        parent_asset_id: { type: ['integer', 'null'] },
        kind: { type: 'string', minLength: 1, maxLength: 255 },
        status: { type: 'string', minLength: 1, maxLength: 50 },
        object_key: { type: 'string', minLength: 1, maxLength: 255 },
        original_filename: { type: ['string', 'null'], maxLength: 255 },
        mime_type: { type: ['string', 'null'], maxLength: 255 },
        size_bytes: { type: ['integer', 'null'] },
        sha256: { type: ['string', 'null'], maxLength: 255 },
        width: { type: ['integer', 'null'] },
        height: { type: ['integer', 'null'] },
        duration_ms: { type: ['integer', 'null'] },
        fps: { type: ['number', 'integer', 'null'] },
        video_codec: { type: ['string', 'null'], maxLength: 255 },
        audio_codec: { type: ['string', 'null'], maxLength: 255 },
        aspect_ratio: { type: ['string', 'null'], maxLength: 255 },
        probe_json: {
          anyOf: [
            { type: 'object' },
            { type: 'array' },
            { type: 'null' },
          ],
        },
        error_message: { type: ['string', 'null'] },
        expires_at: { type: ['string', 'null'], format: 'date-time' },
        locked_at: { type: ['string', 'null'], format: 'date-time' },
        lock_token: { type: ['string', 'null'], maxLength: 255 },
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
          from: 'assets.organization_id',
          to: 'organizations.id',
        },
      },
      campaign: {
        relation: DefaultModel.BelongsToOneRelation,
        modelClass: () => Campaign,
        join: {
          from: 'assets.campaign_id',
          to: 'campaigns.id',
        },
      },
      parentAsset: {
        relation: DefaultModel.BelongsToOneRelation,
        modelClass: () => Asset,
        join: {
          from: 'assets.parent_asset_id',
          to: 'assets.id',
        },
      },
      derivedAssets: {
        relation: DefaultModel.HasManyRelation,
        modelClass: () => Asset,
        join: {
          from: 'assets.id',
          to: 'assets.parent_asset_id',
        },
      },
    };
  }
}

export default Asset;
