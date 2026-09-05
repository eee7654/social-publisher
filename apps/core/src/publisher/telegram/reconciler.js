import getDb from '../../config/database.js';
const db = getDb();
import TelegramComposerSession from '../../db/models/core/TelegramComposerSession.js';
import Asset from '../../db/models/core/Asset.js';
import Campaign from '../../db/models/core/Campaign.js';
import { COMPOSER_STATE } from './constants.js';
import { updateSessionState, parseJsonField } from './state.js';
import { discoverTargetCandidates } from './recommendations.js';
import { getTargetSelectionKeyboard } from './keyboards.js';
import { getTelegramClient } from './api.js';
import { ASSET_STATUS } from '../media/constants.js';

/**
 * Reconciles sessions waiting for asynchronous media / cover probing.
 */
export async function reconcileComposerSessions(options = {}) {
  const telegramClient = options.telegramClient || getTelegramClient();
  const results = { mediaProcessed: 0, coverProcessed: 0, errors: [] };

  // 1. Reconcile WAITING_MEDIA_READY
  const mediaWaitingSessions = await TelegramComposerSession.query()
    .where({ state: COMPOSER_STATE.WAITING_MEDIA_READY });

  for (const session of mediaWaitingSessions) {
    try {
      const context = parseJsonField(session.context_json);
      const assetId = context.assetId;
      if (!assetId) {
        console.warn(`[Reconciler] Session ${session.id} in WAITING_MEDIA_READY has no assetId in context:`, session.context_json);
        continue;
      }

      const asset = await Asset.query().where({ id: assetId, organization_id: session.organization_id }).first();
      if (!asset) {
        console.warn(`[Reconciler] Asset ${assetId} not found for Session ${session.id} in Org ${session.organization_id}`);
        continue;
      }

      if (asset.status === ASSET_STATUS.READY) {
        console.log(`[Reconciler] Master media for session ${session.id} (Asset ${asset.id}) is READY. Advancing to WAITING_COVER.`);
        await updateSessionState(session.id, COMPOSER_STATE.WAITING_COVER, {
          masterAssetReady: true,
          videoWidth: asset.width,
          videoHeight: asset.height,
          durationMs: asset.duration_ms,
        });

        await telegramClient.sendMessage({
          chat_id: session.telegram_chat_id,
          text: `✅ <b>ویدیو با موفقیت تایید شد!</b> (${asset.width}x${asset.height}, ${Math.round((asset.duration_ms || 0) / 1000)} ثانیه)\n\n🖼️ لطفا یک <b>تصویر کاور (Cover Image)</b> برای این ویدیو ارسال کنید:`,
        }).catch((sendErr) => {
          console.error(`[Reconciler] Failed to send Telegram video approval message to chat ${session.telegram_chat_id}:`, sendErr.message);
        });

        results.mediaProcessed += 1;
      } else if (asset.status === ASSET_STATUS.FAILED) {
        console.warn(`[Reconciler] Master media for session ${session.id} (Asset ${asset.id}) FAILED:`, asset.error_message);
        await updateSessionState(session.id, COMPOSER_STATE.WAITING_MEDIA, {
          assetId: null,
          mediaError: asset.error_message,
        });

        const errMsg = asset.error_message ? asset.error_message.slice(0, 150) : 'خطای پردازش فرمت';
        await telegramClient.sendMessage({
          chat_id: session.telegram_chat_id,
          text: `❌ <b>بررسی ویدیو با خطا مواجه شد:</b>\n<code>${errMsg}</code>\n\nلطفا ویدیوی معتبر دیگری ارسال کنید:`,
        }).catch((sendErr) => {
          console.error(`[Reconciler] Failed to send Telegram video failure message to chat ${session.telegram_chat_id}:`, sendErr.message);
        });

        results.mediaProcessed += 1;
      }
    } catch (err) {
      console.error(`[Reconciler] Error reconciling media session ${session.id}:`, err);
      results.errors.push({ sessionId: session.id, error: err.message });
    }
  }

  // 2. Reconcile WAITING_COVER_READY
  const coverWaitingSessions = await TelegramComposerSession.query()
    .where({ state: COMPOSER_STATE.WAITING_COVER_READY });

  for (const session of coverWaitingSessions) {
    try {
      const context = parseJsonField(session.context_json);
      const coverAssetId = context.coverAssetId;
      const masterAssetId = context.assetId;
      if (!coverAssetId) {
        console.warn(`[Reconciler] Session ${session.id} in WAITING_COVER_READY has no coverAssetId in context:`, session.context_json);
        continue;
      }

      const coverAsset = await Asset.query().where({ id: coverAssetId, organization_id: session.organization_id }).first();
      if (!coverAsset) {
        console.warn(`[Reconciler] Cover asset ${coverAssetId} not found for Session ${session.id} in Org ${session.organization_id}`);
        continue;
      }

      if (coverAsset.status === ASSET_STATUS.READY) {
        console.log(`[Reconciler] Cover for session ${session.id} (Asset ${coverAsset.id}) is READY. Advancing to WAITING_TARGET_CONFIRMATION.`);
        // Associate cover with Campaign
        if (session.campaign_id) {
          await Campaign.query()
            .where({ id: session.campaign_id, organization_id: session.organization_id })
            .patch({ cover_asset_id: coverAsset.id });
        }

        // Discover target candidates
        const candidates = await discoverTargetCandidates(session.organization_id, masterAssetId);
        const selectedCandidateIds = candidates.filter(c => c.selectedByDefault).map(c => c.candidateId);

        await updateSessionState(session.id, COMPOSER_STATE.WAITING_TARGET_CONFIRMATION, {
          coverAssetReady: true,
          candidates,
          selectedTargetIds: selectedCandidateIds,
        });

        const keyboard = getTargetSelectionKeyboard(candidates, new Set(selectedCandidateIds));
        await telegramClient.sendMessage({
          chat_id: session.telegram_chat_id,
          text: '🎯 <b>مقصدهای انتشار پیشنهادی (Target Destinations):</b>\n\nمقصدهای سازگار به صورت خودکار انتخاب شده‌اند. می‌توانید با کلیک روی هر گزینه، آن را فعال یا غیرفعال کنید:',
          reply_markup: keyboard,
        }).catch((sendErr) => {
          console.error(`[Reconciler] Failed to send Telegram target selection keyboard to chat ${session.telegram_chat_id}:`, sendErr.message);
        });

        results.coverProcessed += 1;
      } else if (coverAsset.status === ASSET_STATUS.FAILED) {
        console.warn(`[Reconciler] Cover for session ${session.id} (Asset ${coverAsset.id}) FAILED:`, coverAsset.error_message);
        await updateSessionState(session.id, COMPOSER_STATE.WAITING_COVER, {
          coverAssetId: null,
          coverError: coverAsset.error_message,
        });

        const errMsg = coverAsset.error_message ? coverAsset.error_message.slice(0, 150) : 'فرمت تصویر نامعتبر است';
        await telegramClient.sendMessage({
          chat_id: session.telegram_chat_id,
          text: `❌ <b>کاور ارسالی نامعتبر است:</b>\n<code>${errMsg}</code>\n\nلطفا تصویر کاور دیگری (JPEG / PNG / WebP) ارسال کنید:`,
        }).catch((sendErr) => {
          console.error(`[Reconciler] Failed to send Telegram cover failure message to chat ${session.telegram_chat_id}:`, sendErr.message);
        });

        results.coverProcessed += 1;
      }
    } catch (err) {
      console.error(`[Reconciler] Error reconciling cover session ${session.id}:`, err);
      results.errors.push({ sessionId: session.id, error: err.message });
    }
  }

  return results;
}
