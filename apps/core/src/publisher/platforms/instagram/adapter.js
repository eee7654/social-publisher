import getDb from '../../../config/database.js';
const db = getDb();
import PublishJob from '../../../db/models/core/PublishJob.js';
import CampaignTarget from '../../../db/models/core/CampaignTarget.js';
import Campaign from '../../../db/models/core/Campaign.js';
import Asset from '../../../db/models/core/Asset.js';
import IntegrationConfig from '../../../db/models/core/IntegrationConfig.js';
import { decryptProviderConfig } from '../../../integrations/secrets.js';
import { evaluateCompatibility } from '../../media/compatibility.js';
import { COMPATIBILITY_STATUS } from '../../media/constants.js';
import { createSignedReadUrl } from '../../../services/storage/s3.js';
import {
  INSTAGRAM_STAGE,
  INSTAGRAM_CONTAINER_STATUS,
  getMediaUrlTtlSeconds,
  DEFAULT_CONTAINER_POLL_INTERVAL_MS,
  DEFAULT_CONTAINER_MAX_WAIT_MS,
} from './constants.js';
import { getMetaApiClient } from './api.js';
import { classifyMetaError, InstagramAdapterError } from './errors.js';
import { reconcileInstagramJob } from './reconciliation.js';
import { ERROR_CATEGORY } from '../../constants.js';

export class InstagramPublisherAdapter {
  constructor(options = {}) {
    this.options = options;
  }

  /**
   * Verifies account credentials and access permissions against Meta Graph API.
   *
   * @param {IntegrationConfig} integrationConfig
   * @param {Object} [options]
   */
  async verifyConnection(integrationConfig, options = {}) {
    if (!integrationConfig || !integrationConfig.config_json) {
      throw new InstagramAdapterError({
        message: 'Invalid integration config for connection verification',
        category: ERROR_CATEGORY.AUTH_REQUIRED,
      });
    }

    const decrypted = decryptProviderConfig(integrationConfig.config_json);
    const accessToken = decrypted?.system_user_token;
    const igUserId = decrypted?.instagram_user_id;

    if (!accessToken || !igUserId) {
      throw new InstagramAdapterError({
        message: 'Missing system_user_token or instagram_user_id in integration config',
        category: ERROR_CATEGORY.AUTH_REQUIRED,
      });
    }

    const metaClient = getMetaApiClient({ transport: options.transport });
    return await metaClient.verifyConnection({ igUserId, accessToken });
  }

  /**
   * Executes the full publish lifecycle for an Instagram PublishJob.
   */
  async publish({ jobId, organizationId, campaignTargetId, signal = null, transport = null, options = {} }) {
    const metaClient = getMetaApiClient({ transport });
    const ttlSeconds = getMediaUrlTtlSeconds();
    const pollIntervalMs = options.pollIntervalMs || DEFAULT_CONTAINER_POLL_INTERVAL_MS;
    const maxWaitMs = options.maxWaitMs || DEFAULT_CONTAINER_MAX_WAIT_MS;

    // 1. Fetch and validate DB models
    const job = await PublishJob.query().where({ id: jobId, organization_id: organizationId }).first();
    if (!job) {
      throw new InstagramAdapterError({
        message: `PublishJob ${jobId} not found for Organization ${organizationId}`,
        category: ERROR_CATEGORY.VALIDATION,
      });
    }

    const target = await CampaignTarget.query().findById(campaignTargetId || job.campaign_target_id);
    if (!target) {
      throw new InstagramAdapterError({
        message: `CampaignTarget ${campaignTargetId || job.campaign_target_id} not found`,
        category: ERROR_CATEGORY.VALIDATION,
      });
    }

    const campaign = await Campaign.query().where({ id: target.campaign_id, organization_id: organizationId }).first();
    if (!campaign) {
      throw new InstagramAdapterError({
        message: `Campaign ${target.campaign_id} does not belong to Organization ${organizationId}`,
        category: ERROR_CATEGORY.VALIDATION,
      });
    }

    const masterAssetId = target.asset_id || campaign.asset_id;
    const masterAsset = await Asset.query().where({ id: masterAssetId, organization_id: organizationId }).first();
    if (!masterAsset) {
      throw new InstagramAdapterError({
        message: `Master Asset ${masterAssetId} not found or tenant mismatch`,
        category: ERROR_CATEGORY.VALIDATION,
      });
    }

    const coverAssetId = target.cover_asset_id || campaign.cover_asset_id;
    let coverAsset = null;
    if (coverAssetId) {
      coverAsset = await Asset.query().where({ id: coverAssetId, organization_id: organizationId }).first();
      if (!coverAsset) {
        throw new InstagramAdapterError({
          message: `Cover Asset ${coverAssetId} not found or tenant mismatch`,
          category: ERROR_CATEGORY.VALIDATION,
        });
      }
    }

    const config = await IntegrationConfig.query().where({ id: target.integration_config_id, organization_id: organizationId }).first();
    if (!config) {
      throw new InstagramAdapterError({
        message: `IntegrationConfig ${target.integration_config_id} does not belong to Organization ${organizationId}`,
        category: ERROR_CATEGORY.VALIDATION,
      });
    }

    // 2. Compatibility check
    const assetMetadata = {
      size_bytes: masterAsset.size_bytes,
      duration_ms: masterAsset.duration_ms,
      width: masterAsset.width,
      height: masterAsset.height,
      fps: masterAsset.fps,
      aspect_ratio: masterAsset.aspect_ratio,
      video_codec: masterAsset.video_codec,
      audio_codec: masterAsset.audio_codec,
      has_video: masterAsset.probe_json?.video !== null,
      has_audio: masterAsset.probe_json?.audio !== null,
      format_name: masterAsset.probe_json?.format?.format_name,
    };

    const compatibility = evaluateCompatibility(assetMetadata, 'instagram');
    if (compatibility.status === COMPATIBILITY_STATUS.INCOMPATIBLE) {
      throw new InstagramAdapterError({
        message: `Asset is incompatible with Instagram: ${(compatibility.reasons || []).join('; ')}`,
        category: ERROR_CATEGORY.VALIDATION,
        code: 'MEDIA_INCOMPATIBLE',
      });
    }

    if (compatibility.status === COMPATIBILITY_STATUS.NEEDS_CREATIVE_VARIANT) {
      throw new InstagramAdapterError({
        message: `Asset requires creative framing variant for Instagram: ${(compatibility.reasons || []).join('; ')}`,
        category: ERROR_CATEGORY.VALIDATION,
        code: 'NEEDS_CREATIVE_VARIANT',
      });
    }

    if (compatibility.status === COMPATIBILITY_STATUS.NEEDS_TECHNICAL_NORMALIZATION) {
      throw new InstagramAdapterError({
        message: `Asset requires technical normalization for Instagram: ${(compatibility.reasons || []).join('; ')}`,
        category: ERROR_CATEGORY.VALIDATION,
        code: 'NEEDS_TECHNICAL_NORMALIZATION',
      });
    }

    // 3. Decrypt credentials strictly inside execution boundary
    const decryptedConfig = decryptProviderConfig(config.config_json);
    const accessToken = decryptedConfig?.system_user_token;
    const igUserId = decryptedConfig?.instagram_user_id;

    if (!accessToken || !igUserId) {
      throw new InstagramAdapterError({
        message: 'Instagram IntegrationConfig is missing system_user_token or instagram_user_id',
        category: ERROR_CATEGORY.AUTH_REQUIRED,
        code: 'INSTAGRAM_CREDENTIALS_MISSING',
      });
    }

    const caption = target.caption_override || campaign.base_caption || '';

    // 4. Container Creation (Idempotent: Reuse if already persisted on job)
    let containerId = job.external_container_id;

    if (!containerId) {
      const videoUrl = await createSignedReadUrl(masterAsset.object_key, ttlSeconds);
      const coverUrl = coverAsset ? await createSignedReadUrl(coverAsset.object_key, ttlSeconds) : null;

      containerId = await metaClient.createReelContainer({
        igUserId,
        accessToken,
        videoUrl,
        coverUrl,
        caption,
        shareToFeed: true,
        signal,
      });

      // Persist external_container_id immediately
      await PublishJob.query().findById(job.id).patch({
        external_container_id: containerId,
        external_stage: INSTAGRAM_STAGE.CONTAINER_CREATED,
      });
    }

    // 5. Container Status Polling
    await PublishJob.query().findById(job.id).patch({
      external_stage: INSTAGRAM_STAGE.PROCESSING,
    });

    const startTime = Date.now();
    let containerStatus = null;

    while (true) {
      if (signal?.aborted) {
        throw new InstagramAdapterError({
          message: 'Publish execution cancelled during container polling',
          category: ERROR_CATEGORY.TRANSIENT_NETWORK,
        });
      }

      containerStatus = await metaClient.getContainerStatus({
        containerId,
        accessToken,
        signal,
      });

      if (containerStatus.statusCode === INSTAGRAM_CONTAINER_STATUS.FINISHED) {
        break;
      }

      if (
        containerStatus.statusCode === INSTAGRAM_CONTAINER_STATUS.ERROR ||
        containerStatus.statusCode === INSTAGRAM_CONTAINER_STATUS.EXPIRED
      ) {
        throw classifyMetaError({
          message: `Container processing failed with status: ${containerStatus.statusCode} (${containerStatus.status || 'unknown'})`,
          error: { message: containerStatus.status || containerStatus.statusCode },
        });
      }

      if (Date.now() - startTime >= maxWaitMs) {
        throw new InstagramAdapterError({
          message: `Container processing timed out after ${Math.round(maxWaitMs / 1000)}s`,
          category: ERROR_CATEGORY.TRANSIENT_NETWORK,
          code: 'CONTAINER_PROCESSING_TIMEOUT',
        });
      }

      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }

    await PublishJob.query().findById(job.id).patch({
      external_stage: INSTAGRAM_STAGE.READY_TO_PUBLISH,
    });

    // 6. Media Publish Request (Ambiguous Window Protected)
    await PublishJob.query().findById(job.id).patch({
      external_stage: INSTAGRAM_STAGE.PUBLISH_REQUESTED,
    });

    let publishedMediaId = null;
    try {
      publishedMediaId = await metaClient.publishMedia({
        igUserId,
        containerId,
        accessToken,
        signal,
      });
    } catch (err) {
      // Re-classify error with context stage 'publish_requested'
      throw classifyMetaError(err, { stage: INSTAGRAM_STAGE.PUBLISH_REQUESTED });
    }

    // 7. Success: Persist external_media_id and fetch details
    await PublishJob.query().findById(job.id).patch({
      external_media_id: publishedMediaId,
      external_stage: INSTAGRAM_STAGE.PUBLISHED,
    });

    let permalink = null;
    try {
      const details = await metaClient.getMediaDetails({
        mediaId: publishedMediaId,
        accessToken,
        signal,
      });
      permalink = details.permalink || null;
    } catch (detErr) {
      console.warn(`[InstagramAdapter] Could not retrieve permalink for published media ${publishedMediaId}:`, detErr.message);
    }

    // 8. Update CampaignTarget
    await CampaignTarget.query().findById(target.id).patch({
      status: 'published',
      published_url: permalink,
      external_post_id: publishedMediaId,
    });

    return {
      external_container_id: containerId,
      external_media_id: publishedMediaId,
      permalink,
    };
  }

  /**
   * Reconciles an ambiguous publish job.
   */
  async reconcile({ jobId, organizationId, transport = null }) {
    const metaClient = getMetaApiClient({ transport });

    const job = await PublishJob.query().where({ id: jobId, organization_id: organizationId }).first();
    if (!job) return { resolved: false, reason: 'JOB_NOT_FOUND' };

    const target = await CampaignTarget.query().findById(job.campaign_target_id);
    if (!target) return { resolved: false, reason: 'TARGET_NOT_FOUND' };

    const campaign = await Campaign.query().findById(target.campaign_id);
    const config = await IntegrationConfig.query().findById(target.integration_config_id);
    if (!config) return { resolved: false, reason: 'CONFIG_NOT_FOUND' };

    const decrypted = decryptProviderConfig(config.config_json);
    const accessToken = decrypted?.system_user_token;
    const igUserId = decrypted?.instagram_user_id;

    const caption = target.caption_override || campaign?.base_caption || '';

    const recResult = await reconcileInstagramJob({
      job,
      target,
      igUserId,
      accessToken,
      metaClient,
      caption,
      jobWindowStart: job.locked_at ? new Date(job.locked_at) : null,
    });

    if (recResult.resolved && recResult.published) {
      await PublishJob.query().findById(job.id).patch({
        external_media_id: recResult.mediaId,
        external_stage: INSTAGRAM_STAGE.PUBLISHED,
      });

      await CampaignTarget.query().findById(target.id).patch({
        status: 'published',
        published_url: recResult.permalink,
        external_post_id: recResult.mediaId,
      });

      return { resolved: true, published: true, mediaId: recResult.mediaId, permalink: recResult.permalink };
    }

    return recResult;
  }
}

export const instagramPublisherAdapter = new InstagramPublisherAdapter();
