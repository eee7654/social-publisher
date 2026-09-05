import DefaultModel from '../core/Default.js';
import Organization from '../core/Organization.js';
import User from '../core/User.js';
import IntegrationProvider from './IntegrationProvider.js';
import IntegrationEvent from './IntegrationEvent.js';
import Vendor from './Vendor.js';
import PaymentAttempt from './PaymentAttempt.js';
import Payment from './Payment.js';
import PaymentTransaction from './PaymentTransaction.js';
import NotificationDelivery from './NotificationDelivery.js';
import ExternalImportJob from './ExternalImportJob.js';

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
        vendor_id: { type: ['integer', 'null'] },
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
      vendor: {
        relation: DefaultModel.BelongsToOneRelation,
        modelClass: () => Vendor,
        join: {
          from: 'integration_configs.vendor_id',
          to: 'vendors.id',
        },
      },
      paymentAttempts: {
        relation: DefaultModel.HasManyRelation,
        modelClass: () => PaymentAttempt,
        join: {
          from: 'integration_configs.id',
          to: 'payment_attempts.gateway_config_id',
        },
      },
      payments: {
        relation: DefaultModel.HasManyRelation,
        modelClass: () => Payment,
        join: {
          from: 'integration_configs.id',
          to: 'payments.gateway_config_id',
        },
      },
      paymentTransactions: {
        relation: DefaultModel.HasManyRelation,
        modelClass: () => PaymentTransaction,
        join: {
          from: 'integration_configs.id',
          to: 'payment_transactions.gateway_config_id',
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
      notificationDeliveries: {
        relation: DefaultModel.HasManyRelation,
        modelClass: () => NotificationDelivery,
        join: {
          from: 'integration_configs.id',
          to: 'notification_deliveries.provider_config_id',
        },
      },
      externalImportJobs: {
        relation: DefaultModel.HasManyRelation,
        modelClass: () => ExternalImportJob,
        join: {
          from: 'integration_configs.id',
          to: 'external_import_jobs.provider_config_id',
        },
      },
    };
  }
}

export default IntegrationConfig;
