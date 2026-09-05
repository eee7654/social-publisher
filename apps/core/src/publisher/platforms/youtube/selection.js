import Asset from '../../../db/models/core/Asset.js';
import { ASSET_STATUS, COMPATIBILITY_STATUS } from '../../media/constants.js';
import { ensureElecioHorizontalVariant, isElecioHorizontalVariant } from '../../media/variants.js';

export const YOUTUBE_MODE = Object.freeze({ SHORT: 'SHORT', REGULAR: 'REGULAR' });
const vertical = asset => asset?.height > asset?.width;
const horizontal = asset => asset?.aspect_ratio === '16:9' || (asset?.width && asset?.height && Math.abs(asset.width / asset.height - 16 / 9) < 0.01);

/** No creative crop/reframe is ever implied by this resolver. */
export async function resolveYouTubeTargetAsset({ target, masterAsset, trx }) {
  const queryTrx = trx || Asset.knex();
  const mode = target.settings_json?.youtube_mode;
  if (!Object.values(YOUTUBE_MODE).includes(mode)) return { status: 'INVALID_MODE' };
  const targetAsset = target.asset_id ? await Asset.query(queryTrx).where({ id: target.asset_id, organization_id: masterAsset.organization_id }).first() : null;
  if (mode === YOUTUBE_MODE.SHORT) {
    const selected = targetAsset && vertical(targetAsset) ? targetAsset : (vertical(masterAsset) ? masterAsset : null);
    return selected?.status === ASSET_STATUS.READY ? { status: 'READY', asset: selected } : { status: 'NEEDS_CREATIVE_VARIANT' };
  }
  if (targetAsset && horizontal(targetAsset) && targetAsset.status === ASSET_STATUS.READY) return { status: 'READY', asset: targetAsset };
  const variants = await Asset.query(queryTrx).where({ parent_asset_id: masterAsset.id, organization_id: masterAsset.organization_id, kind: 'variant' });
  const ready = variants.find(isElecioHorizontalVariant);
  if (ready) return { status: 'READY', asset: ready };
  if (!vertical(masterAsset)) return { status: 'NEEDS_CREATIVE_VARIANT' };
  const request = await ensureElecioHorizontalVariant(masterAsset, { trx });
  return { status: 'WAITING_MEDIA_READY', asset: request.asset, compatibility: COMPATIBILITY_STATUS.NEEDS_TECHNICAL_NORMALIZATION };
}
