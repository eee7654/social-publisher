import DefaultModel from './Default.js';
import Organization from './Organization.js';

class OutboxEvent extends DefaultModel {
  static get tableName() {
    return 'outbox_events';
  }

  static get idColumn() {
    return 'id';
  }

  static get jsonSchema() {
    return {
      type: 'object',
      required: ['organization_id', 'event_type', 'aggregate_type', 'aggregate_id', 'payload_json', 'status'],
      properties: {
        id: { type: 'integer' },
        organization_id: { type: 'integer' },
        event_type: { type: 'string', minLength: 1, maxLength: 255 },
        aggregate_type: { type: 'string', minLength: 1, maxLength: 255 },
        aggregate_id: { type: 'string', minLength: 1, maxLength: 255 },
        payload_json: {
          anyOf: [
            { type: 'object' },
            { type: 'array' },
          ],
        },
        status: { type: 'string', maxLength: 255 },
        attempt_count: { type: 'integer' },
        available_at: { type: ['string', 'null'], format: 'date-time' },
        dispatched_at: { type: ['string', 'null'], format: 'date-time' },
        created_at: { type: ['string', 'null'], format: 'date-time' },
      },
    };
  }

  static get relationMappings() {
    return {
      organization: {
        relation: DefaultModel.BelongsToOneRelation,
        modelClass: () => Organization,
        join: {
          from: 'outbox_events.organization_id',
          to: 'organizations.id',
        },
      },
    };
  }
}

export default OutboxEvent;
