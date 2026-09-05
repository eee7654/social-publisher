import crypto from 'node:crypto';
import { IntegrationConfigError } from '../../integrationErrors.js';

/**
 * TripleDES (des-ede3) SignData helper for Sadad (Sepehr) gateway.
 * Key is base64-encoded 24 bytes. No IV (ECB) — matches legacy provider behavior.
 */
export class SadadEncryption {
  /**
   * @param {string} merchantKey base64-encoded 24-byte key
   */
  constructor(merchantKey) {
    if (typeof merchantKey !== 'string' || merchantKey.trim() === '') {
      throw new IntegrationConfigError({
        code: 'INTEGRATION_PAYMENT_SADAD_CONFIG_INVALID',
        message: 'Sadad merchant_key is required',
      });
    }

    let key;
    try {
      key = Buffer.from(merchantKey, 'base64');
    } catch (cause) {
      throw new IntegrationConfigError({
        code: 'INTEGRATION_PAYMENT_SADAD_CONFIG_INVALID',
        message: 'Sadad merchant_key must be valid base64',
        cause,
      });
    }

    if (key.length !== 24) {
      throw new IntegrationConfigError({
        code: 'INTEGRATION_PAYMENT_SADAD_CONFIG_INVALID',
        message: 'Sadad merchant_key must decode to 24 bytes',
      });
    }

    this.key = key;
  }

  /**
   * @param {string} text
   * @returns {string} base64 ciphertext
   */
  encrypt(text) {
    if (typeof text !== 'string' || text === '') {
      throw new IntegrationConfigError({
        code: 'INTEGRATION_PAYMENT_SADAD_SIGN_INVALID',
        message: 'Sadad SignData input must be a non-empty string',
      });
    }

    const cipher = crypto.createCipheriv('des-ede3', this.key, null);
    const hex = cipher.update(text, 'utf8', 'hex') + cipher.final('hex');
    return Buffer.from(hex, 'hex').toString('base64');
  }
}
