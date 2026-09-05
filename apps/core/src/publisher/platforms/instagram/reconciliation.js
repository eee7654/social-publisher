import { INSTAGRAM_STAGE, INSTAGRAM_CONTAINER_STATUS } from './constants.js';

/**
 * Reconciles an ambiguous or interrupted Instagram publication job.
 * 
 * Invariants:
 * 1. Checks persisted external_media_id first.
 * 2. Checks external_container_id status next.
 * 3. Never selects a media item arbitrarily when captions are duplicated.
 * 4. Fails closed (remains unresolved / RECONCILE_REQUIRED) when ambiguity cannot be proven deterministically.
 *
 * @param {Object} params
 * @param {Object} params.job - PublishJob row
 * @param {Object} params.target - CampaignTarget row
 * @param {string} params.igUserId
 * @param {string} params.accessToken
 * @param {import('./api.js').MetaApiClient} params.metaClient
 * @param {string} [params.caption] - expected caption
 * @param {Date} [params.jobWindowStart] - timestamp when publish job started
 * @returns {Promise<{ resolved: boolean, published?: boolean, stillProcessing?: boolean, definitelyFailed?: boolean, mediaId?: string, permalink?: string, timestamp?: string, error?: string }>}
 */
export async function reconcileInstagramJob({
  job,
  target,
  igUserId,
  accessToken,
  metaClient,
  caption = '',
  jobWindowStart = null,
}) {
  if (!igUserId || !accessToken) {
    return { resolved: false, reason: 'MISSING_CREDENTIALS' };
  }

  // 1. If external_media_id is already known, query it directly
  if (job.external_media_id) {
    try {
      const details = await metaClient.getMediaDetails({
        mediaId: job.external_media_id,
        accessToken,
      });

      if (details?.id) {
        return {
          resolved: true,
          published: true,
          mediaId: details.id,
          permalink: details.permalink,
          timestamp: details.timestamp,
        };
      }
    } catch (err) {
      // If error indicates not found or permanent failure
      if (err.category === 'VALIDATION' || err.status === 404) {
        return { resolved: true, definitelyFailed: true, error: 'MEDIA_NOT_FOUND' };
      }
    }
  }

  // 2. If external_container_id is known, check container status
  if (job.external_container_id) {
    try {
      const containerInfo = await metaClient.getContainerStatus({
        containerId: job.external_container_id,
        accessToken,
      });

      if (containerInfo.statusCode === INSTAGRAM_CONTAINER_STATUS.IN_PROGRESS) {
        return {
          resolved: true,
          stillProcessing: true,
          containerId: job.external_container_id,
        };
      }

      if (
        containerInfo.statusCode === INSTAGRAM_CONTAINER_STATUS.ERROR ||
        containerInfo.statusCode === INSTAGRAM_CONTAINER_STATUS.EXPIRED
      ) {
        return {
          resolved: true,
          definitelyFailed: true,
          containerId: job.external_container_id,
          error: containerInfo.status || containerInfo.statusCode,
        };
      }

      // If container is FINISHED and publish was requested before interruption
      if (
        containerInfo.statusCode === INSTAGRAM_CONTAINER_STATUS.FINISHED &&
        job.external_stage === INSTAGRAM_STAGE.PUBLISH_REQUESTED
      ) {
        // Query recent media to see if this container resulted in a published reel
        const recentMedia = await metaClient.findRecentMedia({
          igUserId,
          accessToken,
          limit: 10,
        });

        const cleanExpectedCaption = (caption || '').trim();
        const windowMinTime = jobWindowStart
          ? new Date(jobWindowStart.getTime() - 180000) // 3 minutes buffer before job start
          : new Date(Date.now() - 3600000); // 1 hour buffer

        const candidates = recentMedia.filter(m => {
          const mCaption = (m.caption || '').trim();
          const matchesCaption = mCaption === cleanExpectedCaption;
          const isReel = m.media_type === 'REELS' || m.media_type === 'VIDEO';
          
          let withinWindow = true;
          if (m.timestamp) {
            const mediaTime = new Date(m.timestamp);
            withinWindow = mediaTime >= windowMinTime;
          }

          return matchesCaption && isReel && withinWindow;
        });

        // Strict non-ambiguity rule: Exactly one match must exist
        if (candidates.length === 1) {
          const match = candidates[0];
          return {
            resolved: true,
            published: true,
            mediaId: match.id,
            permalink: match.permalink,
            timestamp: match.timestamp,
          };
        }

        // If candidates.length > 1: Multiple posts with same caption! Must NOT guess.
        if (candidates.length > 1) {
          console.warn(`[InstagramReconciler] Ambiguous match: ${candidates.length} recent reels share the same caption. Fails closed.`);
          return {
            resolved: false,
            reason: 'MULTIPLE_CANDIDATE_MATCHES_AMBIGUOUS',
          };
        }
      }
    } catch (err) {
      console.error('[InstagramReconciler] Error inspecting container for reconciliation:', err.message || err);
    }
  }

  // 3. Could not prove external status with certainty -> remain RECONCILE_REQUIRED
  return { resolved: false, reason: 'UNRESOLVED_AMBIGUITY' };
}
