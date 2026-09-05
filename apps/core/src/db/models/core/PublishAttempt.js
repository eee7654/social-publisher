import DefaultModel from './Default.js';
import PublishJob from './PublishJob.js';

class PublishAttempt extends DefaultModel {
  static get tableName() {
    return 'publish_attempts';
  }

  static get idColumn() {
    return 'id';
  }

  static get jsonSchema() {
    return {
      type: 'object',
      required: ['job_id', 'attempt_number', 'status'],
      properties: {
        id: { type: 'integer' },
        job_id: { type: 'integer' },
        attempt_number: { type: 'integer' },
        started_at: { type: ['string', 'null'], format: 'date-time' },
        finished_at: { type: ['string', 'null'], format: 'date-time' },
        status: { type: 'string', maxLength: 255 },
        error_category: { type: ['string', 'null'], maxLength: 255 },
        error_code: { type: ['string', 'null'], maxLength: 255 },
        error_message: { type: ['string', 'null'] },
        metadata_json: {
          anyOf: [
            { type: 'object' },
            { type: 'array' },
            { type: 'null' },
          ],
        },
      },
    };
  }

  static get relationMappings() {
    return {
      job: {
        relation: DefaultModel.BelongsToOneRelation,
        modelClass: () => PublishJob,
        join: {
          from: 'publish_attempts.job_id',
          to: 'publish_jobs.id',
        },
      },
    };
  }
}

export default PublishAttempt;
