import OutboxEvent from '../db/models/core/OutboxEvent.js';
import { OUTBOX_STATUS } from './constants.js';

const ALLOWED_PUBLISH_JOB_KEYS = new Set([
  'jobId',
  'organizationId',
  'campaignTargetId',
  'routingKey',
]);

const ALLOWED_MEDIA_JOB_KEYS = new Set([
  'assetId',
  'organizationId',
  'campaignId',
  'variantName',
  'sourceAssetId',
  'profile',
  'routingKey',
]);

const ALLOWED_CLEANUP_JOB_KEYS = new Set([
  'assetId',
  'organizationId',
  'campaignId',
  'routingKey',
]);

const FORBIDDEN_PATTERNS = [
  'access_token',
  'refresh_token',
  'password',
  'client_secret',
  'secret',
  'authorization',
  'cookie',
  'system_user_token',
  'token',
  'enc:v1',
  'x-amz-signature',
  'x-amz-credential',
  'x-amz-security-token',
  'signature=',
  'awsaccesskeyid=',
];

/**
 * Validates outbox payload for security, preventing leak of credentials or unvalidated fields.
 */
export function validateOutboxPayload(eventType, payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Outbox payload must be a non-null plain object');
  }

  // Strict allowlist per event domain
  if (eventType) {
    if (eventType === 'media.normalize' || eventType === 'jobs.media.normalize') {
      throw new Error('Outbox payload rejected: media normalization is deferred; no transform worker is available.');
    }
    if (eventType === 'media.probe' || eventType === 'jobs.media.probe') {
      const exactKeys = new Set(['assetId', 'organizationId', 'campaignId']);
      for (const key of Object.keys(payload)) {
        if (!exactKeys.has(key)) throw new Error(`Outbox payload rejected: unauthorized field '${key}' for media probe.`);
      }
      if (!Number.isInteger(payload.assetId) || payload.assetId <= 0 ||
          !Number.isInteger(payload.organizationId) || payload.organizationId <= 0 ||
          (payload.campaignId != null && (!Number.isInteger(payload.campaignId) || payload.campaignId <= 0))) {
        throw new Error('Outbox payload rejected: media probe identifiers must be positive integers (campaignId may be null).');
      }
    }
    if (eventType === 'media.variant' || eventType === 'jobs.media.variant') {
      const exactKeys = new Set(['assetId', 'sourceAssetId', 'organizationId', 'profile']);
      for (const key of Object.keys(payload)) if (!exactKeys.has(key)) throw new Error(`Outbox payload rejected: unauthorized field '${key}' for media variant.`);
      if (!Number.isInteger(payload.assetId) || !Number.isInteger(payload.sourceAssetId) || !Number.isInteger(payload.organizationId) || typeof payload.profile !== 'string') throw new Error('Outbox payload rejected: invalid media variant identifiers.');
    }
    let allowedSet = null;
    if (eventType.startsWith('publish.') || eventType.startsWith('jobs.publish.')) {
      allowedSet = ALLOWED_PUBLISH_JOB_KEYS;
    } else if (eventType.startsWith('media.') || eventType.startsWith('jobs.media.')) {
      allowedSet = ALLOWED_MEDIA_JOB_KEYS;
    } else if (eventType.startsWith('cleanup.') || eventType.startsWith('jobs.cleanup.')) {
      allowedSet = ALLOWED_CLEANUP_JOB_KEYS;
    }

    if (allowedSet) {
      for (const key of Object.keys(payload)) {
        if (!allowedSet.has(key)) {
          throw new Error(
            `Outbox payload rejected: unauthorized field '${key}'. Only [${Array.from(allowedSet).join(', ')}] are permitted for '${eventType}'.`
          );
        }
      }
    }
  }

  // Check for forbidden credential/signature patterns in keys and values
  const payloadStr = JSON.stringify(payload).toLowerCase();
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (payloadStr.includes(pattern)) {
      throw new Error(`Outbox payload rejected: contains forbidden sensitive pattern '${pattern}'.`);
    }
  }
}

/**
 * Creates an outbox event in the same transaction as business logic.
 *
 * @param {import("knex").Knex.Transaction} trx
 * @param {Object} params
 * @param {number} params.organizationId
 * @param {string} params.eventType - e.g., 'publish.instagram', 'cleanup.assets'
 * @param {string} params.aggregateType - e.g., 'PublishJob'
 * @param {string} params.aggregateId - e.g., String(job.id)
 * @param {Object} params.payloadJson - safe IDs / routing metadata only
 */
export async function createOutboxEvent(trx, {
  organizationId,
  eventType,
  aggregateType,
  aggregateId,
  payloadJson,
}) {
  if (!trx) {
    throw new Error('createOutboxEvent requires a Knex transaction (trx)');
  }

  // Strictly validate payload before persisting
  validateOutboxPayload(eventType, payloadJson);

  return await OutboxEvent.query(trx).insertAndFetch({
    organization_id: organizationId,
    event_type: eventType,
    aggregate_type: aggregateType,
    aggregate_id: aggregateId,
    payload_json: payloadJson,
    status: OUTBOX_STATUS.PENDING,
    attempt_count: 0,
  });
}
