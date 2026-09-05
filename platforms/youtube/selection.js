import Asset from '../../../db/models/core/Asset.js';
import { ASSET_STATUS, COMPATIBILITY_STATUS } from '../../media/constants.js';
import { ensureElecioHorizontalVariant, isElecioHorizontalVariant } from '../../media/variants.js';

export const YOUTUBE_MODE = Object.freeze({ SHORT: 'SHORT', REGULAR: 'REGULAR' });
const vertical = asset => asset?.height > asset?.width;
const horizontal = asset => asset?.width * 9 === asset?.height * 16 || asset?.aspect_ratio === '16:9';

/** Resolves without creative crop/reframe. A pending variant intentionally keeps the target out of READY. */
export async function resolveYouTubeTargetAsset({ target, masterAsset }) {
  const mode = target.settings_json?.youtube_mode;
  if (!Object.values(YOUTUBE_MODE).includes(mode)) return { status: 'INVALID_MODE' };
  const targetAsset = target.asset_id ? await Asset.query().where({ id: target.asset_id, organization_id: masterAsset.organization_id }).first() : null;
  if (mode === YOUTUBE_MODE.SHORT) {
    const selected = targetAsset && vertical(targetAsset) ? targetAsset : (vertical(masterAsset) ? masterAsset : null);
    return selected?.status === ASSET_STATUS.READY ? { status: 'READY', asset: selected } : { status: 'NEEDS_CREATIVE_VARIANT' };
  }
  if (targetAsset && horizontal(targetAsset) && targetAsset.status === ASSET_STATUS.READY) return { status: 'READY', asset: targetAsset };
  const variants = await Asset.query().where({ parent_asset_id: masterAsset.id, organization_id: masterAsset.organization_id, kind: 'variant' });
  const ready = variants.find(isElecioHorizontalVariant);
  if (ready) return { status: 'READY', asset: ready };
  if (!vertical(masterAsset)) return { status: 'NEEDS_CREATIVE_VARIANT' };
  const request = await ensureElecioHorizontalVariant(masterAsset, { title: target.title_override });
  return { status: 'WAITING_MEDIA_READY', asset: request.asset, compatibility: COMPATIBILITY_STATUS.NEEDS_TECHNICAL_NORMALIZATION };
}
