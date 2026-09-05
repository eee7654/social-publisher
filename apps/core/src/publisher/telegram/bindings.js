import getDb from '../../config/database.js';
const db = getDb();
import TelegramUserBinding from '../../db/models/core/TelegramUserBinding.js';
import User from '../../db/models/core/User.js';
import Organization from '../../db/models/core/Organization.js';
import UserOrganizationRole from '../../db/models/core/UserOrganizationRole.js';

/**
 * Resolves the authorized Core User & Organization for a given Telegram user ID.
 */
export async function resolveTelegramUserBinding(telegramUserId) {
  if (!telegramUserId) {
    return { resolved: false, error: 'MISSING_TELEGRAM_USER_ID' };
  }

  const strId = String(telegramUserId);

  const activeBindings = await TelegramUserBinding.query()
    .where({ telegram_user_id: strId, is_active: true })
    .withGraphFetched('[user, organization]');

  if (!activeBindings || activeBindings.length === 0) {
    return { resolved: false, error: 'UNBOUND_USER' };
  }

  if (activeBindings.length === 1) {
    const binding = activeBindings[0];
    if (!binding.user || !binding.organization || !binding.organization.is_active) {
      return { resolved: false, error: 'INACTIVE_USER_OR_ORGANIZATION' };
    }
    return {
      resolved: true,
      binding,
      userId: binding.user_id,
      organizationId: binding.organization_id,
      user: binding.user,
      organization: binding.organization,
    };
  }

  // Multiple active bindings: resolve via is_default
  const defaultBindings = activeBindings.filter(b => b.is_default);

  if (defaultBindings.length === 1) {
    const binding = defaultBindings[0];
    if (!binding.user || !binding.organization || !binding.organization.is_active) {
      return { resolved: false, error: 'INACTIVE_USER_OR_ORGANIZATION' };
    }
    return {
      resolved: true,
      binding,
      userId: binding.user_id,
      organizationId: binding.organization_id,
      user: binding.user,
      organization: binding.organization,
    };
  }

  // Multiple bindings without a single clear default
  return {
    resolved: false,
    error: 'AMBIGUOUS_ORGANIZATION_BINDING',
    availableBindings: activeBindings.map(b => ({
      organizationId: b.organization_id,
      organizationName: b.organization?.name,
      isDefault: b.is_default,
    })),
  };
}

/**
 * Binds a Telegram user ID to a Core User and Organization.
 * Verifies that the Core User actually belongs to the specified Organization.
 */
export async function bindTelegramUser({
  telegramUserId,
  userId,
  organizationId,
  isDefault = true,
  isActive = true,
}) {
  if (!telegramUserId || !userId || !organizationId) {
    throw new Error('telegramUserId, userId, and organizationId are all required to create a binding');
  }

  const strTelegramUserId = String(telegramUserId);

  // 1. Verify User exists
  const user = await User.query().findById(userId);
  if (!user) {
    throw new Error(`Core User '${userId}' not found`);
  }

  // 2. Verify Organization exists
  const org = await Organization.query().findById(organizationId);
  if (!org) {
    throw new Error(`Organization '${organizationId}' not found`);
  }

  // 3. Verify User belongs to Organization
  const membership = await UserOrganizationRole.query()
    .where({ user_id: userId, organization_id: organizationId })
    .first();

  if (!membership) {
    throw new Error(`Core User '${userId}' is not a member of Organization '${organizationId}'`);
  }

  // 4. Transactionally persist binding and handle default flag
  const trx = await db.transaction();
  try {
    if (isDefault) {
      await TelegramUserBinding.query(trx)
        .where({ telegram_user_id: strTelegramUserId })
        .patch({ is_default: false });
    }

    const existing = await TelegramUserBinding.query(trx)
      .where({ telegram_user_id: strTelegramUserId, organization_id: organizationId })
      .first();

    let binding;
    if (existing) {
      await TelegramUserBinding.query(trx)
        .where({ id: existing.id })
        .patch({
          user_id: userId,
          is_default: isDefault,
          is_active: isActive,
        });
      binding = await TelegramUserBinding.query(trx).findById(existing.id);
    } else {
      await TelegramUserBinding.query(trx).insert({
        telegram_user_id: strTelegramUserId,
        user_id: userId,
        organization_id: organizationId,
        is_default: isDefault,
        is_active: isActive,
      });
      binding = await TelegramUserBinding.query(trx)
        .where({ telegram_user_id: strTelegramUserId, organization_id: organizationId })
        .first();
    }

    await trx.commit();
    return binding;
  } catch (err) {
    await trx.rollback();
    throw err;
  }
}
