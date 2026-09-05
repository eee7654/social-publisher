import DefaultModel from './Default.js';
import IntegrationProvider from './IntegrationProvider.js';
import IntegrationConfig from './IntegrationConfig.js';

class IntegrationEvent extends DefaultModel {
  static get tableName() {
    return 'integration_events';
  }

  static get idColumn() {
    return 'id';
  }

  static get jsonSchema() {
    return {
      type: 'object',
      required: ['provider_id', 'event_type', 'direction', 'status'],
      properties: {
        id: { type: 'integer' },
        provider_id: { type: 'integer' },
        config_id: { type: ['integer', 'null'] },
        event_type: { type: 'string', minLength: 1, maxLength: 255 },
        direction: { type: 'string', maxLength: 255 },
        status: { type: 'string', maxLength: 255 },
        request_json: {
          anyOf: [
            { type: 'object' },
            { type: 'array' },
            { type: 'null' },
          ],
        },
        response_json: {
          anyOf: [
            { type: 'object' },
            { type: 'array' },
            { type: 'null' },
          ],
        },
        error_code: { type: ['string', 'null'], maxLength: 255 },
        error_message: { type: ['string', 'null'] },
        reference_type: { type: ['string', 'null'], maxLength: 255 },
        reference_id: { type: ['integer', 'null'] },
        created_at: { type: ['string', 'null'], format: 'date-time' },
      },
    };
  }

  static get relationMappings() {
    return {
      provider: {
        relation: DefaultModel.BelongsToOneRelation,
        modelClass: () => IntegrationProvider,
        join: {
          from: 'integration_events.provider_id',
          to: 'integration_providers.id',
        },
      },
      config: {
        relation: DefaultModel.BelongsToOneRelation,
        modelClass: () => IntegrationConfig,
        join: {
          from: 'integration_events.config_id',
          to: 'integration_configs.id',
        },
      },
    };
  }
}

export default IntegrationEvent;
