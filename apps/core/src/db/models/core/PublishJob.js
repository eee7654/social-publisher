import DefaultModel from './Default.js';
import Organization from './Organization.js';
import CampaignTarget from './CampaignTarget.js';
import PublishAttempt from './PublishAttempt.js';

class PublishJob extends DefaultModel {
  static get tableName() {
    return 'publish_jobs';
  }

  static get idColumn() {
    return 'id';
  }

  static get jsonSchema() {
    return {
      type: 'object',
      required: ['organization_id', 'campaign_target_id', 'idempotency_key', 'status'],
      properties: {
        id: { type: 'integer' },
        organization_id: { type: 'integer' },
        campaign_target_id: { type: 'integer' },
        idempotency_key: { type: 'string', minLength: 1, maxLength: 255 },
        status: { type: 'string', maxLength: 255 },
        attempt_count: { type: 'integer' },
        max_attempts: { type: 'integer' },
        next_attempt_at: { type: ['string', 'null'], format: 'date-time' },
        locked_at: { type: ['string', 'null'], format: 'date-time' },
        lock_token: { type: ['string', 'null'], maxLength: 64 },
        last_error_code: { type: ['string', 'null'], maxLength: 255 },
        last_error_message: { type: ['string', 'null'] },
        external_stage: { type: ['string', 'null'], maxLength: 255 },
        sensitive_external_state_json: { type: ['object', 'null'] },
        external_container_id: { type: ['string', 'null'], maxLength: 255 },
        external_media_id: { type: ['string', 'null'], maxLength: 255 },
        created_at: { type: ['string', 'null'], format: 'date-time' },
        updated_at: { type: ['string', 'null'], format: 'date-time' },
        completed_at: { type: ['string', 'null'], format: 'date-time' },
      },
    };
  }

  static get relationMappings() {
    return {
      organization: {
        relation: DefaultModel.BelongsToOneRelation,
        modelClass: () => Organization,
        join: {
          from: 'publish_jobs.organization_id',
          to: 'organizations.id',
        },
      },
      campaignTarget: {
        relation: DefaultModel.BelongsToOneRelation,
        modelClass: () => CampaignTarget,
        join: {
          from: 'publish_jobs.campaign_target_id',
          to: 'campaign_targets.id',
        },
      },
      attempts: {
        relation: DefaultModel.HasManyRelation,
        modelClass: () => PublishAttempt,
        join: {
          from: 'publish_jobs.id',
          to: 'publish_attempts.job_id',
        },
      },
    };
  }
}

export default PublishJob;
