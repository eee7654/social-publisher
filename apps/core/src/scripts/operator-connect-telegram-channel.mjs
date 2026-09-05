import dotenv from 'dotenv';
dotenv.config();

import { getTelegramClient } from '../publisher/telegram/api.js';
import { processTelegramUpdate } from '../publisher/telegram/composer.js';
import IntegrationConnectionIntent from '../db/models/core/IntegrationConnectionIntent.js';
import IntegrationConfig from '../db/models/core/IntegrationConfig.js';
import TelegramChannel from '../db/models/core/TelegramChannel.js';
import { Model } from 'objection';
import knex from 'knex';
import knexConfig from '../../knexfile.js';

async function main() {
  const db = knex(knexConfig.development || knexConfig);
  Model.knex(db);

  const telegramUserId = '290250674';
  const realTelegramClient = getTelegramClient();

  console.log('=== REAL TELEGRAM CHANNEL /connections UX FLOW ===\n');

  // Step 1: Operator triggers /connections
  console.log('--- Step 1: Operator sends /connections ---');
  const update1 = {
    update_id: Date.now() + 1,
    message: {
      message_id: 1001,
      from: { id: Number(telegramUserId), first_name: 'Operator' },
      chat: { id: Number(telegramUserId), type: 'private' },
      text: '/connections',
    },
  };
  const res1 = await processTelegramUpdate(update1, { telegramClient: realTelegramClient });
  console.log('Step 1 result:', res1);

  // Step 1.5: Operator selects organization (conn_org:1)
  console.log('\n--- Step 1.5: Operator selects Organization 1 ---');
  const update1_5 = {
    update_id: Date.now() + 2,
    callback_query: {
      id: String(Date.now() + 2),
      from: { id: Number(telegramUserId), first_name: 'Operator' },
      message: {
        message_id: 1002,
        chat: { id: Number(telegramUserId), type: 'private' },
      },
      data: 'conn_org:1',
    },
  };
  const res1_5 = await processTelegramUpdate(update1_5, { telegramClient: realTelegramClient });
  console.log('Step 1.5 result:', res1_5);

  // Step 2: Operator clicks "Connect Telegram Channel" (conn_tg:1)
  console.log('\n--- Step 2: Operator clicks Connect Telegram Channel ---');
  const update2 = {
    update_id: Date.now() + 3,
    callback_query: {
      id: String(Date.now() + 3),
      from: { id: Number(telegramUserId), first_name: 'Operator' },
      message: {
        message_id: 1003,
        chat: { id: Number(telegramUserId), type: 'private' },
      },
      data: 'conn_tg:1',
    },
  };
  const res2 = await processTelegramUpdate(update2, { telegramClient: realTelegramClient });
  console.log('Step 2 result:', res2);

  // Find the created pending intent
  const pendingIntent = await IntegrationConnectionIntent.query()
    .where({
      telegram_user_id: telegramUserId,
      purpose: 'channel_publishing',
      status: 'pending',
    })
    .orderBy('created_at', 'desc')
    .first();
  console.log('Pending intent created in DB:', pendingIntent?.id);
  if (!pendingIntent) {
    throw new Error('Pending connection intent was not created in DB');
  }

  // Step 3: Operator sends channel identifier "@elecio_shop"
  console.log('\n--- Step 3: Operator sends "@elecio_shop" ---');
  const update3 = {
    update_id: Date.now() + 3,
    message: {
      message_id: 1003,
      from: { id: Number(telegramUserId), first_name: 'Operator' },
      chat: { id: Number(telegramUserId), type: 'private' },
      text: '@elecio_shop',
    },
  };
  const res3 = await processTelegramUpdate(update3, { telegramClient: realTelegramClient });
  console.log('Step 3 result:', res3);

  // Verify intent advanced to verified_pending_confirmation
  const verifiedIntent = await IntegrationConnectionIntent.query().findById(pendingIntent.id);
  console.log('Intent status after candidate verification:', verifiedIntent.status);
  console.log('Verified channel ID:', verifiedIntent.verified_channel_id);
  console.log('Verified channel title:', verifiedIntent.verified_channel_title);
  if (verifiedIntent.status !== 'verified_pending_confirmation') {
    throw new Error(`Intent status is ${verifiedIntent.status}, expected verified_pending_confirmation`);
  }

  // Step 4: Operator clicks Confirm (conn_tg_ok:<intentId>)
  console.log(`\n--- Step 4: Operator clicks Confirm (conn_tg_ok:${pendingIntent.id}) ---`);
  const update4 = {
    update_id: Date.now() + 4,
    callback_query: {
      id: String(Date.now() + 4),
      from: { id: Number(telegramUserId), first_name: 'Operator' },
      message: {
        message_id: 1004,
        chat: { id: Number(telegramUserId), type: 'private' },
      },
      data: `conn_tg_ok:${pendingIntent.id}`,
    },
  };
  const res4 = await processTelegramUpdate(update4, { telegramClient: realTelegramClient });
  console.log('Step 4 result:', res4);

  // Step 5: Verify DB records
  console.log('\n--- Step 5: Verify Database Records ---');
  const consumedIntent = await IntegrationConnectionIntent.query().findById(pendingIntent.id);
  console.log('Final Intent Status:', consumedIntent.status); // should be consumed

  const configs = await IntegrationConfig.query()
    .where({ organization_id: 1, status: 'active' })
    .withGraphFetched('provider')
    .modifyGraph('provider', b => b.where({ domain: 'publishing' }));
  
  const tgConfig = configs.find(c => c.provider?.code === 'telegram');
  console.log('Active Telegram IntegrationConfig in DB:', !!tgConfig);
  if (!tgConfig) {
    throw new Error('Active Telegram IntegrationConfig not found for Organization 1');
  }

  console.log('IntegrationConfig ID:', tgConfig.id);
  console.log('IntegrationConfig Organization ID:', tgConfig.organization_id);
  console.log('IntegrationConfig config_json:', tgConfig.config_json);

  const configJson = typeof tgConfig.config_json === 'string' ? JSON.parse(tgConfig.config_json) : tgConfig.config_json;
  console.log('Stored chat_id:', configJson.chat_id);
  console.log('Stored chat_username:', configJson.chat_username);
  console.log('Stored chat_title:', configJson.chat_title);
  console.log('Bot token present in config_json (MUST BE FALSE):', !!configJson.bot_token || !!configJson.token);

  const channelRow = await TelegramChannel.query()
    .where({ organization_id: 1, is_active: true })
    .first();
  console.log('\nTelegramChannel row in DB:');
  console.log('Channel ID:', channelRow?.id);
  console.log('Channel Chat ID:', channelRow?.chat_id);
  console.log('Channel Username:', channelRow?.username);
  console.log('Channel Title:', channelRow?.title);
  console.log('Channel Is Active:', channelRow?.is_active);
  console.log('Channel Integration Config ID:', channelRow?.integration_config_id);

  if (channelRow?.chat_id !== '-1002289635128') {
    throw new Error(`Expected chat_id -1002289635128, got ${channelRow?.chat_id}`);
  }

  console.log('\n=== TELEGRAM CHANNEL CONNECTION FLOW COMPLETED SUCCESSFULLY ===');
  await db.destroy();
  process.exit(0);
}

main().catch(async err => {
  console.error('Error during connection flow:', err);
  process.exit(1);
});
