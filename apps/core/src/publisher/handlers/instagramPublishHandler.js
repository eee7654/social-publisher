import { instagramPublisherAdapter } from '../platforms/instagram/adapter.js';

/**
 * Worker job handler for Instagram publish jobs.
 *
 * @param {Object} context
 * @param {number} context.jobId
 * @param {number} context.organizationId
 * @param {number} context.campaignTargetId
 * @param {number} context.attemptNumber
 * @param {AbortSignal} [context.signal]
 * @param {Function} [context.transport]
 * @param {Object} [context.options]
 */
export async function instagramPublishHandler(context) {
  const {
    jobId,
    organizationId,
    campaignTargetId,
    signal = null,
    transport = null,
    options = {},
  } = context;

  console.log(`[InstagramWorker] Processing job ${jobId} for Org ${organizationId}...`);

  return await instagramPublisherAdapter.publish({
    jobId,
    organizationId,
    campaignTargetId,
    signal,
    transport,
    options,
  });
}
