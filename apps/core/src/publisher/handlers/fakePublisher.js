import { ERROR_CATEGORY } from '../constants.js';
import getDb from '../../config/database.js';
const db = getDb();

export async function fakePublisherHandler({ jobId, campaignTargetId, attemptNumber, signal }) {
  // Read target settings to determine the test scenario
  const target = await db.raw(`SELECT settings_json FROM campaign_targets WHERE id = ?`, [campaignTargetId]);
  const settings = target[0][0]?.settings_json || {};
  const scenario = settings._testScenario || 'success';

  console.log(`[FakePublisher] Executing job ${jobId}, attempt ${attemptNumber}, scenario: ${scenario}`);

  if (scenario === 'success') {
    return { success: true, published_url: 'https://test.local/fake-post' };
  }

  if (scenario === 'transient_then_success') {
    if (attemptNumber === 1) {
      const err = new Error('Simulated transient network error');
      err.isNormalized = true;
      err.category = ERROR_CATEGORY.TRANSIENT_NETWORK;
      err.code = 'ETIMEDOUT';
      throw err;
    }
    return { success: true, published_url: 'https://test.local/fake-post-transient' };
  }

  if (scenario === 'rate_limit') {
    const err = new Error('Simulated rate limit');
    err.isNormalized = true;
    err.category = ERROR_CATEGORY.RATE_LIMIT;
    err.code = 'HTTP_429';
    err.retryAfterMs = 2000; // 2 seconds
    throw err;
  }

  if (scenario === 'auth_required') {
    const err = new Error('Simulated auth expired');
    err.isNormalized = true;
    err.category = ERROR_CATEGORY.AUTH_REQUIRED;
    err.code = 'OAUTH_EXPIRED';
    throw err;
  }

  if (scenario === 'validation_error') {
    const err = new Error('Simulated validation failure');
    err.isNormalized = true;
    err.category = ERROR_CATEGORY.VALIDATION;
    err.code = 'INVALID_MEDIA_FORMAT';
    throw err;
  }

  if (scenario === 'crash') {
    throw new Error('CRASH_SIMULATION');
  }

  if (scenario === 'ambiguous') {
    const err = new Error('Simulated ambiguous state');
    err.isNormalized = true;
    err.category = ERROR_CATEGORY.AMBIGUOUS_EXTERNAL_STATE;
    err.code = 'TIMEOUT_AFTER_POST';
    throw err;
  }

  if (scenario === 'slow_success') {
    const delayMs = settings._delayMs || 300;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, delayMs);
      if (signal) {
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('Handler aborted during slow execution'));
        }, { once: true });
      }
    });
    return { success: true, published_url: 'https://test.local/slow-success' };
  }

  if (scenario === 'inject_secrets_error') {
    const err = new Error('Failed with Bearer ya29.secret_token and enc:v1:rawcipher at https://s3.local/bucket?X-Amz-Signature=sig123&X-Amz-Credential=cred123');
    err.isNormalized = true;
    err.category = ERROR_CATEGORY.PERMANENT;
    err.code = 'AUTH_TOKEN_LEAK_TEST';
    err.safeMetadata = {
      raw_token: 'secret_token_12345',
      access_token: 'eaab_facebook_token',
      refresh_token: 'refresh_secret_999',
      password: 'mypassword123',
      authorization: 'Bearer auth_header_token',
      s3_url: 'https://s3.local/bucket/video.mp4?X-Amz-Signature=abc12345&X-Amz-Credential=cred999&X-Amz-Security-Token=sectok123',
      nested: {
        client_secret: 'super_client_secret',
        ciphertext: 'enc:v1:some_encrypted_value_that_should_not_leak',
      }
    };
    throw err;
  }

  return { success: true };
}
