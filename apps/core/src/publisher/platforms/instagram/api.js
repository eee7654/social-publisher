import { getMetaGraphBaseUrl } from './constants.js';
import { classifyMetaError, InstagramAdapterError } from './errors.js';
import { ERROR_CATEGORY } from '../../constants.js';

/**
 * Sanitizes URLs by removing signature and access token query params.
 */
export function sanitizeMetaUrl(urlStr) {
  if (typeof urlStr !== 'string') return urlStr;
  return urlStr
    .replace(/access_token=[^&\s]+/gi, 'access_token=[REDACTED]')
    .replace(/X-Amz-Signature=[^&\s]+/gi, 'X-Amz-Signature=[REDACTED]')
    .replace(/Signature=[^&\s]+/gi, 'Signature=[REDACTED]');
}

/**
 * Meta Graph API client for Instagram publishing.
 */
export class MetaApiClient {
  /**
   * @param {Object} [options]
   * @param {string} [options.baseUrl]
   * @param {Function} [options.transport] - custom fetch implementation for testing
   * @param {number} [options.timeoutMs]
   */
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || getMetaGraphBaseUrl();
    this.transport = options.transport || globalThis.fetch;
    this.timeoutMs = options.timeoutMs || 30000;
  }

  /**
   * Core HTTP request method with sanitized error reporting.
   */
  async request(method, path, { params = {}, body = null, accessToken, stage = null, signal = null } = {}) {
    if (!accessToken) {
      throw new InstagramAdapterError({
        message: 'Missing Meta access token for API request',
        category: ERROR_CATEGORY.AUTH_REQUIRED,
        code: 'META_TOKEN_MISSING',
      });
    }

    const url = new URL(`${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`);
    
    // Add query params
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) {
        url.searchParams.set(k, String(v));
      }
    }
    url.searchParams.set('access_token', accessToken);

    const headers = {
      'Accept': 'application/json',
    };

    let fetchBody = undefined;
    if (body && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
      headers['Content-Type'] = 'application/json';
      fetchBody = JSON.stringify(body);
    }

    let response;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
      
      if (signal) {
        signal.addEventListener('abort', () => controller.abort(), { once: true });
      }

      response = await this.transport(url.toString(), {
        method,
        headers,
        body: fetchBody,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
    } catch (err) {
      throw classifyMetaError(err, { stage });
    }

    let responseData = null;
    try {
      responseData = await response.json();
    } catch (parseErr) {
      responseData = null;
    }

    if (!response.ok || (responseData && responseData.error)) {
      throw classifyMetaError({
        status: response.status,
        statusCode: response.status,
        headers: response.headers,
        error: responseData?.error || { message: `HTTP ${response.status}` },
        responseBody: responseData,
      }, { stage });
    }

    return responseData;
  }

  /**
   * 1. Create Reels media container.
   * Endpoint: POST /{ig_user_id}/media
   */
  async createReelContainer({ igUserId, accessToken, videoUrl, coverUrl = null, caption = '', shareToFeed = true, signal = null }) {
    if (!igUserId) throw new Error('igUserId is required to create a media container');
    if (!videoUrl) throw new Error('videoUrl is required to create a Reels container');

    const params = {
      media_type: 'REELS',
      video_url: videoUrl,
      share_to_feed: shareToFeed ? 'true' : 'false',
    };

    if (coverUrl) {
      params.cover_url = coverUrl;
    }

    if (caption && caption.trim().length > 0) {
      params.caption = caption;
    }

    const data = await this.request('POST', `/${igUserId}/media`, {
      params,
      accessToken,
      signal,
    });

    if (!data?.id) {
      throw classifyMetaError({ message: 'Meta returned no container ID', responseBody: data });
    }

    return data.id;
  }

  /**
   * 2. Poll Reels container status.
   * Endpoint: GET /{container_id}?fields=id,status_code,status
   */
  async getContainerStatus({ containerId, accessToken, signal = null }) {
    if (!containerId) throw new Error('containerId is required to query status');

    const data = await this.request('GET', `/${containerId}`, {
      params: { fields: 'id,status_code,status' },
      accessToken,
      signal,
    });

    return {
      id: data.id,
      statusCode: data.status_code || 'UNKNOWN',
      status: data.status || null,
      raw: data,
    };
  }

  /**
   * 3. Publish container to Instagram.
   * Endpoint: POST /{ig_user_id}/media_publish
   */
  async publishMedia({ igUserId, containerId, accessToken, signal = null }) {
    if (!igUserId) throw new Error('igUserId is required to publish media');
    if (!containerId) throw new Error('containerId is required to publish media');

    const data = await this.request('POST', `/${igUserId}/media_publish`, {
      params: { creation_id: containerId },
      accessToken,
      stage: 'publish_requested',
      signal,
    });

    if (!data?.id) {
      throw classifyMetaError({ message: 'Meta returned no published media ID', responseBody: data }, { stage: 'publish_requested' });
    }

    return data.id;
  }

  /**
   * 4. Retrieve published media details (permalink, timestamp).
   * Endpoint: GET /{media_id}?fields=id,permalink,timestamp,media_type
   */
  async getMediaDetails({ mediaId, accessToken, signal = null }) {
    if (!mediaId) throw new Error('mediaId is required to get media details');

    const data = await this.request('GET', `/${mediaId}`, {
      params: { fields: 'id,permalink,timestamp,media_type' },
      accessToken,
      signal,
    });

    return {
      id: data.id,
      permalink: data.permalink || null,
      timestamp: data.timestamp || null,
      mediaType: data.media_type || null,
      raw: data,
    };
  }

  /**
   * 5. Query recent media for reconciliation.
   * Endpoint: GET /{ig_user_id}/media?fields=id,caption,permalink,timestamp,media_type&limit={limit}
   */
  async findRecentMedia({ igUserId, accessToken, limit = 10, signal = null }) {
    if (!igUserId) throw new Error('igUserId is required to list recent media');

    const data = await this.request('GET', `/${igUserId}/media`, {
      params: {
        fields: 'id,caption,permalink,timestamp,media_type',
        limit: String(limit),
      },
      accessToken,
      signal,
    });

    return Array.isArray(data?.data) ? data.data : [];
  }

  /**
   * 6. Verify account credentials and access.
   * Endpoint: GET /{ig_user_id}?fields=id,name,username
   */
  async verifyConnection({ igUserId, accessToken, signal = null }) {
    if (!igUserId) throw new Error('igUserId is required for connection verification');

    const data = await this.request('GET', `/${igUserId}`, {
      params: { fields: 'id,name,username' },
      accessToken,
      signal,
    });

    return {
      valid: !!data?.id && String(data.id) === String(igUserId),
      accountId: data.id,
      name: data.name || null,
      username: data.username || null,
    };
  }
}

export function getMetaApiClient(options = {}) {
  return new MetaApiClient(options);
}
