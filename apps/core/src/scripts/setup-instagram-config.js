import '../bootstrap.js';
import readline from 'readline';
import getDb from '../config/database.js';
const db = getDb();
import Organization from '../db/models/core/Organization.js';
import IntegrationProvider from '../db/models/core/IntegrationProvider.js';
import IntegrationConfig from '../db/models/core/IntegrationConfig.js';
import { seedIntegrationProviders } from '../integrations/seeder.js';
import { buildProviderConfig } from '../integrations/configSerializer.js';

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        parsed[key] = next;
        i++;
      } else {
        parsed[key] = true;
      }
    }
  }
  return parsed;
}

async function promptSecret(promptText) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(promptText, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main() {
  const args = parseArgs();

  console.log('🔧 [Setup] Instagram IntegrationConfig Configuration Utility');

  // 1. Ensure providers are seeded
  await seedIntegrationProviders();
  const provider = await IntegrationProvider.query()
    .where({ domain: 'publishing', code: 'instagram' })
    .first();

  if (!provider) {
    console.error('❌ Provider "publishing.instagram" not found in catalog.');
    process.exit(1);
  }

  // 2. Resolve Organization
  let org = null;
  if (args['org-id']) {
    org = await Organization.query().findById(Number(args['org-id']));
  } else if (args['org-slug']) {
    org = await Organization.query().where({ slug: args['org-slug'] }).first();
  } else {
    org = await Organization.query().where({ slug: 'main' }).first() || (await Organization.query().first());
  }

  if (!org) {
    console.error('❌ Organization not found. Specify --org-id or --org-slug.');
    process.exit(1);
  }

  console.log(`📌 Target Organization: [ID: ${org.id}] ${org.name || org.slug}`);

  // 3. Resolve parameters
  const igUserId = args['ig-user-id'] || process.env.META_IG_USER_ID || null;
  const pageId = args['page-id'] || process.env.META_PAGE_ID || null;
  const username = args['username'] || process.env.META_IG_USERNAME || null;
  const name = args['name'] || (username ? `Instagram - @${username}` : 'Instagram Professional');

  // 4. Securely read token from ENV or prompt (NEVER as CLI argument)
  let token = process.env.META_SYSTEM_USER_TOKEN || process.env.INSTAGRAM_SYSTEM_USER_TOKEN;
  if (!token) {
    token = await promptSecret('🔒 Enter Meta System User Access Token: ');
  }

  if (!token || token.length < 10) {
    console.error('❌ Invalid or missing access token.');
    process.exit(1);
  }

  // 5. Look for existing IntegrationConfig for this org and provider
  const existingConfig = await IntegrationConfig.query()
    .where({
      organization_id: org.id,
      provider_id: provider.id,
    })
    .first();

  const submittedPayload = {
    system_user_token: token,
    instagram_user_id: igUserId || (existingConfig?.config_json?.instagram_user_id) || null,
    page_id: pageId || (existingConfig?.config_json?.page_id) || null,
    username: username || (existingConfig?.config_json?.username) || null,
  };

  const encryptedConfigJson = buildProviderConfig({
    adapterKey: 'publishing.instagram',
    submitted: submittedPayload,
    stored: existingConfig?.config_json || {},
    isCreate: !existingConfig,
  });

  if (existingConfig) {
    await IntegrationConfig.query().findById(existingConfig.id).patch({
      name,
      config_json: encryptedConfigJson,
      status: 'active',
    });
    console.log(`✅ Updated existing Instagram IntegrationConfig [ID: ${existingConfig.id}] for Org ${org.id}.`);
  } else {
    const created = await IntegrationConfig.query().insertAndFetch({
      provider_id: provider.id,
      organization_id: org.id,
      name,
      status: 'active',
      config_json: encryptedConfigJson,
    });
    console.log(`✅ Created new Instagram IntegrationConfig [ID: ${created.id}] for Org ${org.id}.`);
  }

  console.log('✨ Instagram connection successfully configured with encrypted credentials.');
  process.exit(0);
}

main().catch(err => {
  console.error('❌ Fatal error configuring Instagram integration:', err.message || err);
  process.exit(1);
});
