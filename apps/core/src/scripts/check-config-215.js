import '../bootstrap.js';
import getDb from '../config/database.js';
const db = getDb();
import IntegrationConfig from '../db/models/core/IntegrationConfig.js';
import { decryptProviderConfig } from '../integrations/secrets.js';

async function run() {
  try {
    const config = await IntegrationConfig.query().findById(215);
    if (!config) {
      console.log('Config 215 not found!');
      process.exit(1);
    }
    
    const decrypted = decryptProviderConfig(config.config_json);
    
    console.log('--- Decrypted Config 215 ---');
    console.log('has system_user_token:', !!decrypted.system_user_token);
    console.log('matches ENV META_SYSTEM_USER_TOKEN:', decrypted.system_user_token === process.env.META_SYSTEM_USER_TOKEN);
    console.log('instagram_user_id:', decrypted.instagram_user_id);
    console.log('matches ENV META_IG_USER_ID:', decrypted.instagram_user_id === process.env.META_IG_USER_ID);
    console.log('page_id:', decrypted.page_id);
    console.log('matches ENV META_PAGE_ID:', decrypted.page_id === process.env.META_PAGE_ID);
    console.log('username:', decrypted.username);
    console.log('matches ENV META_IG_USERNAME:', decrypted.username === process.env.META_IG_USERNAME);

  } catch(e) {
    console.error(e);
  } finally {
    db.destroy();
  }
}

run();
