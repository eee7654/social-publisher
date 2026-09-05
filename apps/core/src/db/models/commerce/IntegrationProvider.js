import DefaultModel from '../core/Default.js';
import IntegrationConfig from './IntegrationConfig.js';
import IntegrationEvent from './IntegrationEvent.js';

class IntegrationProvider extends DefaultModel {
  static get tableName() {
    return 'integration_providers';
  }

  static get idColumn() {
    return 'id';
  }

  static get jsonSchema() {
    return {
      type: 'object',
      required: ['domain', 'code', 'display_name', 'adapter_key'],
      properties: {
        id: { type: 'integer' },
        domain: { type: 'string', minLength: 1, maxLength: 255 },
        code: { type: 'string', minLength: 1, maxLength: 255 },
        display_name: { type: 'string', minLength: 1, maxLength: 255 },
        adapter_key: { type: 'string', minLength: 1, maxLength: 255 },
        is_enabled: { type: 'boolean' },
        is_system: { type: 'boolean' },
        created_at: { type: ['string', 'null'], format: 'date-time' },
        updated_at: { type: ['string', 'null'], format: 'date-time' },
      },
    };
  }

  static get relationMappings() {
    return {
      configs: {
        relation: DefaultModel.HasManyRelation,
        modelClass: () => IntegrationConfig,
        join: {
          from: 'integration_providers.id',
          to: 'integration_configs.provider_id',
        },
      },
      events: {
        relation: DefaultModel.HasManyRelation,
        modelClass: () => IntegrationEvent,
        join: {
          from: 'integration_providers.id',
          to: 'integration_events.provider_id',
        },
      },
    };
  }
}

export default IntegrationProvider;
