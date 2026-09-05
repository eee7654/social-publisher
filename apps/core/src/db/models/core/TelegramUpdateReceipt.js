import DefaultModel from './Default.js';

class TelegramUpdateReceipt extends DefaultModel {
  static get tableName() {
    return 'telegram_update_receipts';
  }

  static get idColumn() {
    return 'id';
  }

  static get jsonAttributes() {
    return ['result_json'];
  }

  static get jsonSchema() {
    return {
      type: 'object',
      required: ['telegram_update_id', 'status'],
      properties: {
        id: { type: 'integer' },
        telegram_update_id: { type: 'string', minLength: 1, maxLength: 255 },
        telegram_user_id: { type: ['string', 'null'], maxLength: 255 },
        status: { type: 'string', maxLength: 50 },
        locked_at: { type: ['string', 'null'], format: 'date-time' },
        lock_token: { type: ['string', 'null'], maxLength: 255 },
        result_json: {
          anyOf: [
            { type: 'object' },
            { type: 'null' },
          ],
        },
        processed_at: { type: ['string', 'null'], format: 'date-time' },
        created_at: { type: ['string', 'null'], format: 'date-time' },
        updated_at: { type: ['string', 'null'], format: 'date-time' },
      },
    };
  }
}

export default TelegramUpdateReceipt;
