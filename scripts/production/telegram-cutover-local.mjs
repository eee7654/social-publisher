#!/usr/bin/env node
import '../../apps/core/src/bootstrap.js';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { TelegramApiClient, checkTelegramHealth, sanitizeTelegramError } from '../../apps/core/src/publisher/telegram/api.js';

const CONFIRMATION = 'LOGOUT_CLOUD_AND_USE_LOCAL';

function requireEnv(name) {
  if (!process.env[name]) throw new Error(`${name} is required`);
}

async function main() {
  if (process.env.TELEGRAM_BOT_API_MODE !== 'local') {
    throw new Error('TELEGRAM_BOT_API_MODE must be local for cutover');
  }
  for (const name of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_BOT_API_BASE_URL', 'TELEGRAM_LOCAL_FILES_DIR']) {
    requireEnv(name);
  }

  const localClient = new TelegramApiClient({
    mode: 'local',
    baseUrl: process.env.TELEGRAM_BOT_API_BASE_URL,
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    localFilesDir: process.env.TELEGRAM_LOCAL_FILES_DIR,
  });
  const cloudClient = new TelegramApiClient({
    mode: 'cloud',
    baseUrl: 'https://api.telegram.org',
    botToken: process.env.TELEGRAM_BOT_TOKEN,
  });

  const localHealth = await checkTelegramHealth({ client: localClient });
  if (localHealth.telegram_local_api !== 'healthy') {
    throw new Error('Local telegram-bot-api is not reachable');
  }

  const cloudMe = await cloudClient.getMe();
  await cloudClient.getWebhookInfo().catch((err) => {
    console.log(`getWebhookInfo unavailable before cutover: ${sanitizeTelegramError(err, process.env.TELEGRAM_BOT_TOKEN)}`);
  });

  console.log('WARNING: This will call Telegram Cloud Bot API logOut exactly once.');
  console.log('After logOut, Cloud Bot API login is unavailable again for approximately 10 minutes.');
  console.log('There is no automatic rollback to cloud mode.');
  console.log(`Expected bot identity: id=${cloudMe.id} username=${cloudMe.username || ''}`);

  const rl = readline.createInterface({ input, output });
  const answer = await rl.question(`Type ${CONFIRMATION} to continue: `);
  rl.close();
  if (answer !== CONFIRMATION) {
    console.log('Cutover cancelled. No logOut call performed.');
    return;
  }

  const logoutResult = await cloudClient.logOut();
  if (logoutResult !== true) {
    throw new Error('Cloud logOut did not return success');
  }

  const localMe = await localClient.getMe();
  if (String(localMe.id) !== String(cloudMe.id)) {
    throw new Error('Local getMe bot id does not match Cloud bot id captured before logOut');
  }
  console.log(`Cutover complete: local bot authenticated as id=${localMe.id} username=${localMe.username || ''}`);
}

main().catch((err) => {
  console.error(`Cutover failed: ${sanitizeTelegramError(err, process.env.TELEGRAM_BOT_TOKEN)}`);
  process.exit(1);
});

