import IntegrationConfig from '../../db/models/core/IntegrationConfig.js';
import TelegramChannel from '../../db/models/core/TelegramChannel.js';
import Asset from '../../db/models/core/Asset.js';
import { evaluateCompatibility } from '../media/compatibility.js';
import { COMPATIBILITY_STATUS } from '../media/constants.js';
import { isPublisherAvailable, getPublisherCapability } from './capabilities.js';
import { parseJsonField } from './state.js';

/**
 * Discovers and evaluates all potential publishing target candidates for an Organization and Asset.
 */
export async function discoverTargetCandidates(organizationId, assetId) {
  if (!organizationId) {
    throw new Error('organizationId is required for target discovery');
  }

  // 1. Fetch Asset metadata
  const asset = await Asset.query().where({ id: assetId, organization_id: organizationId }).first();
  if (!asset) {
    throw new Error(`Asset ${assetId} not found for Organization ${organizationId}`);
  }

  const probeData = parseJsonField(asset.probe_json);

  const assetMetadata = {
    size_bytes: asset.size_bytes,
    duration_ms: asset.duration_ms,
    width: asset.width,
    height: asset.height,
    fps: asset.fps,
    aspect_ratio: asset.aspect_ratio,
    video_codec: asset.video_codec,
    audio_codec: asset.audio_codec,
    has_video: probeData?.video != null || asset.video_codec != null,
    has_audio: probeData?.audio != null || asset.audio_codec != null,
    format_name: probeData?.format?.format_name,
  };

  const candidates = [];

  // 2. Discover active IntegrationConfigs for publishing
  const configs = await IntegrationConfig.query()
    .where({ organization_id: organizationId, status: 'active' })
    .withGraphFetched('provider')
    .modifyGraph('provider', builder => {
      builder.where({ domain: 'publishing', is_enabled: true });
    });

  for (const config of configs) {
    if (!config.provider) continue;
    const platformKey = config.provider.code.toLowerCase();
    const compatibility = evaluateCompatibility(assetMetadata, platformKey);
    const publisherAvailable = isPublisherAvailable(platformKey);
    const capability = getPublisherCapability(platformKey);

    const isCompatible = compatibility.status === COMPATIBILITY_STATUS.COMPATIBLE;
    const selectedByDefault = isCompatible && publisherAvailable;

    candidates.push({
      candidateId: `ic_${config.id}`,
      type: 'integration_config',
      integrationConfigId: config.id,
      telegramChannelId: null,
      platform: platformKey,
      displayName: config.name || capability.title || platformKey,
      status: compatibility.status,
      eligible: compatibility.eligible,
      reasons: compatibility.reasons || [],
      warnings: compatibility.warnings || [],
      publisherAvailable,
      selectedByDefault,
    });
  }

  // 3. Discover active Telegram Channels
  const channels = await TelegramChannel.query()
    .where({ organization_id: organizationId, is_active: true });

  for (const channel of channels) {
    const platformKey = 'telegram';
    const compatibility = evaluateCompatibility(assetMetadata, 'telegram');
    const publisherAvailable = isPublisherAvailable('telegram') || isPublisherAvailable('telegram_channel');

    const isCompatible = compatibility.status === COMPATIBILITY_STATUS.COMPATIBLE;
    const selectedByDefault = isCompatible && publisherAvailable;

    candidates.push({
      candidateId: `tc_${channel.id}`,
      type: 'telegram_channel',
      integrationConfigId: channel.integration_config_id || null,
      telegramChannelId: channel.id,
      platform: platformKey,
      displayName: channel.title || channel.username || `Channel ${channel.chat_id}`,
      status: compatibility.status,
      eligible: compatibility.eligible,
      reasons: compatibility.reasons || [],
      warnings: compatibility.warnings || [],
      publisherAvailable,
      selectedByDefault,
    });
  }

  return candidates;
}
