import { Model } from 'objection';
import db from '@/config/database.js';
import CaslQueryBuilder from '@/lib/CaslQueryBuilder';

class DefaultModel extends Model {

  static get QueryBuilder() {
    return CaslQueryBuilder;
  }

  /**
   * @param {import('objection').TransactionOrKnex} [trxOrKnex]
   * @returns {CaslQueryBuilder}
  */
  static query(trxOrKnex) {
      return super.query(trxOrKnex);
  }

  static get schemaColumns() {
    if (!this.jsonSchema || !this.jsonSchema.properties) {
      return ['*'];
    }
    return Object.keys(this.jsonSchema.properties);
  }

  static attachPrefix(columns) {
    if (!columns || columns.length === 0) return [];
    if (columns.includes('*')) return [`${this.tableName}.*`];
    return columns.map(col => `${this.tableName}.${col}`);
  }
    
}

DefaultModel.knex(db())

export default DefaultModel