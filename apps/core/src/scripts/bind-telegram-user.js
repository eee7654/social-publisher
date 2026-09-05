import '../bootstrap.js';
import getDb from '../config/database.js';
const db = getDb();
import { bindTelegramUser } from '../publisher/telegram/bindings.js';

async function main() {
  const args = process.argv.slice(2);
  const getArg = (name) => {
    const idx = args.indexOf(`--${name}`);
    if (idx !== -1 && args[idx + 1]) return args[idx + 1];
    return null;
  };

  const telegramUserId = getArg('telegram-user-id') || args[0] || process.env.BIND_TELEGRAM_USER_ID;
  const userId = getArg('user-id') || args[1] || process.env.BIND_USER_ID;
  const organizationId = parseInt(getArg('org-id') || args[2] || process.env.BIND_ORG_ID, 10);
  const isDefault = args.includes('--default') || true;

  if (!telegramUserId || !userId || isNaN(organizationId)) {
    console.log(`
Usage:
  tsx src/scripts/bind-telegram-user.js --telegram-user-id <ID> --user-id <UUID> --org-id <ID> [--default]

Parameters:
  --telegram-user-id   Telegram User ID (numeric string)
  --user-id            Core User ID (UUID)
  --org-id             Organization ID (Integer)
  --default            Mark as default organization for this Telegram user (default: true)
`);
    process.exit(1);
  }

  try {
    console.log(`🔗 Binding Telegram User '${telegramUserId}' -> Core User '${userId}' in Org ${organizationId}...`);
    const binding = await bindTelegramUser({
      telegramUserId,
      userId,
      organizationId,
      isDefault,
    });

    console.log('✅ Telegram user binding successfully created/updated:');
    console.log({
      id: binding.id,
      telegram_user_id: binding.telegram_user_id,
      user_id: binding.user_id,
      organization_id: binding.organization_id,
      is_default: binding.is_default,
      is_active: binding.is_active,
    });
  } catch (err) {
    console.error('❌ Failed to bind Telegram user:', err.message);
    process.exit(1);
  } finally {
    await db.destroy();
  }
}

if (process.argv[1]?.endsWith('bind-telegram-user.js')) {
  main();
}
