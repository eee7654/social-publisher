import crypto from 'node:crypto';
import getDb from '../../config/database.js';
import Asset from '../../db/models/core/Asset.js';
import { createOutboxEvent } from '../outbox.js';
import { ASSET_KIND, ASSET_STATUS } from './constants.js';
import {
  ELECIO_HORIZONTAL_PROFILE,
  ELECIO_HORIZONTAL_SPEC,
  ELECIO_HORIZONTAL_LAYOUT_REVISION,
  ELECIO_HORIZONTAL_BACKGROUND_SHA256,
  layoutProvenance,
  newElecioHorizontalObjectKey,
} from './technicalLayout.js';

const db = getDb();

function provenanceOf(asset) {
  const value = typeof asset.probe_json === 'string' ? JSON.parse(asset.probe_json || '{}') : (asset.probe_json || {});
  return value?.variant_provenance || null;
}

/** Finds the deterministic READY revision-2 layout, or atomically creates exactly one render request. */
export async function ensureElecioHorizontalVariant(sourceAsset, { trx: externalTrx } = {}) {
  const queryTrx = externalTrx || db;
  const existing = await Asset.query(queryTrx)
    .where({ organization_id: sourceAsset.organization_id, parent_asset_id: sourceAsset.id, kind: ASSET_KIND.VARIANT })
    .where('status', ASSET_STATUS.READY);
  const reusable = existing.find(isElecioHorizontalVariant);
  if (reusable) return { asset: reusable, reused: true };

  const execute = async (trx) => {
    const inProgress = await Asset.query(trx)
      .where({ organization_id: sourceAsset.organization_id, parent_asset_id: sourceAsset.id, kind: ASSET_KIND.VARIANT })
      .whereIn('status', [ASSET_STATUS.STORED, ASSET_STATUS.PROBING])
      .forUpdate();

    const duplicate = inProgress.find((a) => {
      const p = provenanceOf(a);
      return p?.profile === ELECIO_HORIZONTAL_PROFILE && p?.layout_revision === ELECIO_HORIZONTAL_LAYOUT_REVISION;
    });

    if (duplicate) {
      return { asset: duplicate, reused: false, queued: true };
    }

    const asset = await Asset.query(trx).insertAndFetch({
      organization_id: sourceAsset.organization_id,
      campaign_id: sourceAsset.campaign_id,
      parent_asset_id: sourceAsset.id,
      kind: ASSET_KIND.VARIANT,
      status: ASSET_STATUS.STORED,
      object_key: newElecioHorizontalObjectKey(sourceAsset),
      original_filename: `${ELECIO_HORIZONTAL_PROFILE}.mp4`,
      mime_type: 'video/mp4',
      probe_json: { variant_provenance: layoutProvenance(sourceAsset.id) },
    });

    await createOutboxEvent(trx, {
      organizationId: sourceAsset.organization_id,
      eventType: 'media.variant',
      aggregateType: 'Asset',
      aggregateId: String(asset.id),
      payloadJson: {
        assetId: asset.id,
        sourceAssetId: sourceAsset.id,
        organizationId: sourceAsset.organization_id,
        profile: ELECIO_HORIZONTAL_PROFILE,
      },
    });

    return { asset, reused: false, queued: true };
  };

  if (externalTrx) {
    return await execute(externalTrx);
  } else {
    return await db.transaction(execute);
  }
}

export function isElecioHorizontalVariant(asset) {
  const p = provenanceOf(asset);
  return (
    asset?.status === ASSET_STATUS.READY &&
    p?.profile === ELECIO_HORIZONTAL_PROFILE &&
    p?.layout_revision === ELECIO_HORIZONTAL_LAYOUT_REVISION &&
    p?.background_sha256 === ELECIO_HORIZONTAL_BACKGROUND_SHA256 &&
    p?.output_width === ELECIO_HORIZONTAL_SPEC.width &&
    p?.output_height === ELECIO_HORIZONTAL_SPEC.height
  );
}
