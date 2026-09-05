import Asset from '../../../db/models/core/Asset.js';
import { ASSET_STATUS, COMPATIBILITY_STATUS } from '../../media/constants.js';
import { ensureElecioHorizontalVariant, isElecioHorizontalVariant } from '../../media/variants.js';
import { ensureElecioThumbnail16x9Variant, isElecioThumbnail16x9Variant } from '../../media/thumbnailVariants.js';

const isHorizontal = asset => (
  asset?.aspect_ratio === '16:9' ||
  (asset?.width && asset?.height && Math.abs(asset.width / asset.height - 16 / 9) < 0.01)
);

/**
 * Resolves Aparat target video and cover media.
 * Queues elecio_horizontal_v1 for vertical videos and elecio_thumbnail_16x9_v1 for non-16:9 covers.
 * Returns { status: 'READY' | 'WAITING_MEDIA_READY', videoAsset, coverAsset, videoStatus, coverStatus }
 */
export async function resolveAparatTargetMedia({
  target,
  masterAsset,
  coverAsset,
  organizationId,
  trx,
}) {
  const queryTrx = trx || Asset.knex();
  const orgId = organizationId || masterAsset?.organization_id || target?.organization_id;

  // 1. Resolve Video
  let selectedVideo = null;
  let videoStatus = 'WAITING_MEDIA_READY';

  const targetAsset = target?.asset_id
    ? await Asset.query(queryTrx).where({ id: target.asset_id, organization_id: orgId }).first()
    : null;

  const candidateVideo = targetAsset || masterAsset;
  if (!candidateVideo) {
    return { status: 'INVALID_ASSET', error: 'No video asset found for Aparat target' };
  }

  if (isHorizontal(candidateVideo) && candidateVideo.status === ASSET_STATUS.READY) {
    selectedVideo = candidateVideo;
    videoStatus = 'READY';
  } else {
    // Check if ready variant exists
    const variants = await Asset.query(queryTrx).where({
      parent_asset_id: candidateVideo.kind === 'variant' ? candidateVideo.parent_asset_id : candidateVideo.id,
      organization_id: orgId,
      kind: 'variant',
    });
    const readyVariant = variants.find(isElecioHorizontalVariant);

    if (readyVariant && readyVariant.status === ASSET_STATUS.READY) {
      selectedVideo = readyVariant;
      videoStatus = 'READY';
    } else {
      // Ensure variant render request is created
      const rootVideo = candidateVideo.kind === 'variant' && candidateVideo.parent_asset_id
        ? await Asset.query(queryTrx).findById(candidateVideo.parent_asset_id)
        : candidateVideo;

      const request = await ensureElecioHorizontalVariant(rootVideo, { trx });
      selectedVideo = request.asset;
      videoStatus = request.asset?.status === ASSET_STATUS.READY ? 'READY' : 'WAITING_MEDIA_READY';
    }
  }

  // 2. Resolve Cover
  let selectedCover = null;
  let coverStatus = 'READY';

  const targetCover = target?.cover_asset_id
    ? await Asset.query(queryTrx).where({ id: target.cover_asset_id, organization_id: orgId }).first()
    : null;

  const candidateCover = targetCover || coverAsset;
  if (candidateCover) {
    if (isHorizontal(candidateCover) && candidateCover.status === ASSET_STATUS.READY) {
      selectedCover = candidateCover;
      coverStatus = 'READY';
    } else {
      const coverVariants = await Asset.query(queryTrx).where({
        parent_asset_id: candidateCover.kind === 'variant' ? candidateCover.parent_asset_id : candidateCover.id,
        organization_id: orgId,
        kind: 'variant',
      });
      const readyCoverVariant = coverVariants.find(isElecioThumbnail16x9Variant);

      if (readyCoverVariant && readyCoverVariant.status === ASSET_STATUS.READY) {
        selectedCover = readyCoverVariant;
        coverStatus = 'READY';
      } else {
        const rootCover = candidateCover.kind === 'variant' && candidateCover.parent_asset_id
          ? await Asset.query(queryTrx).findById(candidateCover.parent_asset_id)
          : candidateCover;

        const request = await ensureElecioThumbnail16x9Variant(rootCover, { trx });
        selectedCover = request.asset;
        coverStatus = request.asset?.status === ASSET_STATUS.READY ? 'READY' : 'WAITING_MEDIA_READY';
      }
    }
  }

  const allReady = videoStatus === 'READY' && coverStatus === 'READY';
  return {
    status: allReady ? 'READY' : 'WAITING_MEDIA_READY',
    videoAsset: selectedVideo,
    coverAsset: selectedCover,
    videoStatus,
    coverStatus,
  };
}
