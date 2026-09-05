import dotenv from 'dotenv';
dotenv.config();

import { getTelegramClient } from '../publisher/telegram/api.js';

async function main() {
  const client = getTelegramClient();
  
  console.log('--- Calling getMe ---');
  const me = await client.getMe();
  console.log('BOT USERNAME:', me.username);
  console.log('BOT USER ID:', me.id);
  console.log('BOT IS_BOT:', me.is_bot);

  console.log('\n--- Calling getChat("@elecio_shop") ---');
  const chat = await client.getChat('@elecio_shop');
  console.log('CHANNEL USERNAME:', chat.username);
  console.log('CHANNEL TITLE:', chat.title);
  console.log('CHANNEL CHAT ID:', chat.id);
  console.log('CHAT TYPE:', chat.type);

  console.log('\n--- Calling getChatMember(chat.id, me.id) ---');
  const member = await client.getChatMember(chat.id, me.id);
  console.log('BOT STATUS:', member.status);
  console.log('CAN_POST_MESSAGES:', member.can_post_messages);
  console.log('CAN_EDIT_MESSAGES:', member.can_edit_messages);

  const isChannel = chat.type === 'channel';
  const isAdminOrCreator = member.status === 'administrator' || member.status === 'creator';
  const canPost = member.status === 'creator' || member.can_post_messages === true;

  console.log('\n--- Verification Summary ---');
  console.log('chat.type === "channel":', isChannel);
  console.log('bot status admin/creator:', isAdminOrCreator);
  console.log('can_post_messages === true:', canPost);

  if (!isChannel || !isAdminOrCreator || !canPost) {
    console.error('READ-ONLY CHANNEL VERIFICATION FAILED!');
    process.exit(1);
  }
  console.log('READ-ONLY CHANNEL VERIFICATION PASSED!');
  process.exit(0);
}

main().catch(err => {
  console.error('Error during read-only verification:', err);
  process.exit(1);
});
