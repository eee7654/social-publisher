import getDb from '../../config/database.js';
const db = getDb();
import TelegramComposerSession from '../../db/models/core/TelegramComposerSession.js';
import Campaign from '../../db/models/core/Campaign.js';
import { COMPOSER_STATE, TELEGRAM_SESSION_EXPIRY_MS } from './constants.js';

function toDbDate(date) {
  return date.toISOString().replace('T', ' ').replace('Z', '');
}

/**
 * Safely parses JSON column value whether returned as object or string.
 */
export function parseJsonField(val) {
  if (!val) return {};
  if (typeof val === 'string') {
    try {
      return JSON.parse(val) || {};
    } catch (e) {
      return {};
    }
  }
  return typeof val === 'object' ? val : {};
}

/**
 * Sanitizes context object to ensure sensitive fields (tokens, secrets, signed URLs)
 * are NEVER stored in session state.
 */
export function sanitizeSessionContext(context) {
  if (!context || typeof context !== 'object') return {};
  const forbiddenPatterns = ['token', 'secret', 'password', 'authorization', 'signature', 'x-amz-'];
  const sanitized = {};

  for (const [key, value] of Object.entries(context)) {
    const lowerKey = key.toLowerCase();
    if (forbiddenPatterns.some(pat => lowerKey.includes(pat))) {
      continue;
    }
    if (typeof value === 'string' && (value.includes('X-Amz-Signature') || value.includes('/bot') || value.includes('bot:'))) {
      continue;
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      sanitized[key] = sanitizeSessionContext(value);
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

/**
 * Finds active composer session for a Telegram user, or returns null.
 */
export async function getActiveSession(telegramUserId) {
  const strUserId = String(telegramUserId);
  return TelegramComposerSession.query()
    .where({ telegram_user_id: strUserId })
    .whereNotIn('state', [COMPOSER_STATE.IDLE, COMPOSER_STATE.READY, COMPOSER_STATE.CANCELLED, COMPOSER_STATE.ERROR])
    .where(builder => {
      builder.whereNull('expires_at').orWhere('expires_at', '>', db.fn.now());
    })
    .orderBy('updated_at', 'desc')
    .first();
}

/**
 * Atomically starts a new campaign composition session or resumes if existing.
 */
export async function startOrResumeSession({
  telegramUserId,
  telegramChatId,
  organizationId,
  userId,
  sourceRef = null,
}) {
  const strUserId = String(telegramUserId);
  const strChatId = String(telegramChatId);

  const trx = await db.transaction();
  try {
    // 1. Check for existing active session
    const existing = await TelegramComposerSession.query(trx)
      .where({ telegram_user_id: strUserId })
      .whereNotIn('state', [COMPOSER_STATE.IDLE, COMPOSER_STATE.READY, COMPOSER_STATE.CANCELLED, COMPOSER_STATE.ERROR])
      .where(builder => {
        builder.whereNull('expires_at').orWhere('expires_at', '>', db.fn.now());
      })
      .orderBy('updated_at', 'desc')
      .first();

    if (existing) {
      // Return existing session for deterministic resume / decision
      await trx.commit();
      return { session: existing, isNew: false };
    }

    // 2. Create new draft Campaign
    const campaign = await Campaign.query(trx).insert({
      organization_id: organizationId,
      created_by: userId,
      source_type: 'telegram_private',
      source_ref: sourceRef ? String(sourceRef) : null,
      status: 'draft',
    });

    // 3. Create fresh session
    const expiresAt = toDbDate(new Date(Date.now() + TELEGRAM_SESSION_EXPIRY_MS));
    const session = await TelegramComposerSession.query(trx).insert({
      telegram_user_id: strUserId,
      telegram_chat_id: strChatId,
      user_id: userId,
      organization_id: organizationId,
      campaign_id: campaign.id,
      state: COMPOSER_STATE.WAITING_MEDIA,
      context_json: {
        campaignId: campaign.id,
        startedAt: new Date().toISOString(),
      },
      expires_at: expiresAt,
    });

    await trx.commit();
    return { session, campaign, isNew: true };
  } catch (err) {
    await trx.rollback();
    throw err;
  }
}

/**
 * Updates session state and merges sanitized context.
 */
export async function updateSessionState(sessionId, nextState, contextPatch = {}) {
  const session = await TelegramComposerSession.query().findById(sessionId);
  if (!session) {
    throw new Error(`Composer session ${sessionId} not found`);
  }

  const currentContext = parseJsonField(session.context_json);
  const mergedContext = {
    ...currentContext,
    ...sanitizeSessionContext(contextPatch),
  };

  await TelegramComposerSession.query()
    .where({ id: sessionId })
    .patch({
      state: nextState,
      context_json: mergedContext,
    });

  return TelegramComposerSession.query().findById(sessionId);
}

/**
 * Cancels active session and associated draft campaign.
 */
export async function cancelSession(sessionId) {
  const trx = await db.transaction();
  try {
    const session = await TelegramComposerSession.query(trx).findById(sessionId);
    if (!session) {
      await trx.commit();
      return null;
    }

    if (session.campaign_id) {
      await Campaign.query(trx)
        .where({ id: session.campaign_id, status: 'draft' })
        .patch({ status: 'cancelled' });
    }

    await TelegramComposerSession.query(trx)
      .where({ id: sessionId })
      .patch({
        state: COMPOSER_STATE.CANCELLED,
      });

    const updated = await TelegramComposerSession.query(trx).findById(sessionId);
    await trx.commit();
    return updated;
  } catch (err) {
    await trx.rollback();
    throw err;
  }
}
