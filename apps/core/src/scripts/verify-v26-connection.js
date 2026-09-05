import '../bootstrap.js';
import getDb from '../config/database.js';
const db = getDb();
import IntegrationConfig from '../db/models/core/IntegrationConfig.js';
import { getMetaApiClient } from '../publisher/platforms/instagram/api.js';
import { decryptProviderConfig } from '../integrations/secrets.js';

async function run() {
  try {
    const config = await IntegrationConfig.query().findById(215);
    const decrypted = decryptProviderConfig(config.config_json);
    
    console.log('Graph API version: v26.0'); // Our constants.js default was just updated
    
    // We can also instrument to intercept the exact URL
    const mockTransport = async (urlStr, options) => {
      const res = await fetch(urlStr, options);
      console.log('HTTP status:', res.status);
      
      const data = await res.clone().json().catch(()=>({}));
      if (res.status !== 200) {
        console.log('Meta error code/type:', `${data?.error?.code} / ${data?.error?.type} (${data?.error?.message})`);
      }
      return res;
    };
    
    const client = getMetaApiClient({ transport: mockTransport });
    
    const result = await client.verifyConnection({
      igUserId: decrypted.instagram_user_id,
      accessToken: decrypted.system_user_token
    });
    
    console.log('account username:', result.username);
    console.log('PASS / FAIL:', result.valid ? 'PASS' : 'FAIL');
    
  } catch(e) {
    console.log('PASS / FAIL: FAIL');
    console.log('Meta error:', e.message);
  } finally {
    db.destroy();
  }
}

run();
