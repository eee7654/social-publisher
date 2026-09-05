import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  IntegrationConfigError,
  IntegrationProviderError,
} from '../integrationErrors.js';
import { INTEGRATION_DOMAINS } from '../types.js';

export const MINIO_ADAPTER_KEY = 'storage.minio';

const PROVIDER_CODE = 'minio';
const DEFAULT_REGION = 'us-east-1';
const DEFAULT_UPLOAD_TTL_SECONDS = 300;
const DEFAULT_DOWNLOAD_TTL_SECONDS = 600;

/**
 * MinIO / S3-compatible storage adapter.
 * Receives already-decrypted config. Does not own media_assets, auth, or key generation.
 */
export class MinioStorageAdapter {
  /**
   * @param {object} config
   * @param {object} [meta]
   * @param {number|string|null} [meta.configId]
   * @param {string|null} [meta.providerCode]
   */
  constructor(config, meta = {}) {
    this.domain = INTEGRATION_DOMAINS.STORAGE;
    this.providerCode = meta.providerCode ?? PROVIDER_CODE;
    this.configId = meta.configId ?? null;
    this.settings = normalizeMinioConfig(config, {
      configId: this.configId,
      providerCode: this.providerCode,
    });

    this.client = new S3Client({
      region: this.settings.region,
      endpoint: this.settings.endpoint,
      forcePathStyle: this.settings.force_path_style,
      credentials: {
        accessKeyId: this.settings.access_key,
        secretAccessKey: this.settings.secret_key,
      },
    });
  }

  /**
   * @param {object} params
   * @param {string} params.key
   * @param {string} [params.contentType]
   * @param {number|string} [params.contentLength]
   * @param {string} [params.checksum]
   * @param {number} [params.ttlSeconds]
   * @returns {Promise<{ url: string, headers: Record<string, string>, expiresAt: string }>}
   */
  async createUploadUrl({
    key,
    contentType,
    contentLength,
    checksum,
    ttlSeconds,
  } = {}) {
    assertObjectKey(key, this);

    const ttl = resolveTtl(
      ttlSeconds,
      this.settings.upload_url_ttl_seconds,
      DEFAULT_UPLOAD_TTL_SECONDS,
    );

    /** @type {Record<string, string>} */
    const headers = {};
    /** @type {import('@aws-sdk/client-s3').PutObjectCommandInput} */
    const input = {
      Bucket: this.settings.bucket,
      Key: key,
    };

    if (contentType != null && contentType !== '') {
      input.ContentType = String(contentType);
      headers['Content-Type'] = String(contentType);
    }

    if (contentLength != null && contentLength !== '') {
      const length = Number(contentLength);
      if (!Number.isFinite(length) || length < 0) {
        throw new IntegrationConfigError({
          code: 'INTEGRATION_STORAGE_UPLOAD_INVALID',
          message: 'contentLength must be a non-negative number',
          domain: this.domain,
          providerCode: this.providerCode,
          configId: this.configId,
        });
      }
      input.ContentLength = length;
      headers['Content-Length'] = String(length);
    }

    if (checksum != null && checksum !== '') {
      input.ChecksumSHA256 = String(checksum);
      headers['x-amz-checksum-sha256'] = String(checksum);
    }

    try {
      const url = await getSignedUrl(this.client, new PutObjectCommand(input), {
        expiresIn: ttl,
      });
      return {
        url,
        headers,
        expiresAt: expiresAtIso(ttl),
      };
    } catch (error) {
      throw mapProviderError(error, this, {
        code: 'INTEGRATION_STORAGE_PRESIGN_UPLOAD_FAILED',
        message: 'Failed to create MinIO upload URL',
      });
    }
  }

  /**
   * @param {object} params
   * @param {string} params.key
   * @param {number} [params.ttlSeconds]
   * @param {string} [params.responseContentDisposition]
   * @returns {Promise<{ url: string, expiresAt: string }>}
   */
  async createDownloadUrl({
    key,
    ttlSeconds,
    responseContentDisposition,
  } = {}) {
    assertObjectKey(key, this);

    const ttl = resolveTtl(
      ttlSeconds,
      this.settings.download_url_ttl_seconds,
      DEFAULT_DOWNLOAD_TTL_SECONDS,
    );

    /** @type {import('@aws-sdk/client-s3').GetObjectCommandInput} */
    const input = {
      Bucket: this.settings.bucket,
      Key: key,
    };

    if (responseContentDisposition != null && responseContentDisposition !== '') {
      input.ResponseContentDisposition = String(responseContentDisposition);
    }

    try {
      const url = await getSignedUrl(this.client, new GetObjectCommand(input), {
        expiresIn: ttl,
      });
      return {
        url,
        expiresAt: expiresAtIso(ttl),
      };
    } catch (error) {
      throw mapProviderError(error, this, {
        code: 'INTEGRATION_STORAGE_PRESIGN_DOWNLOAD_FAILED',
        message: 'Failed to create MinIO download URL',
      });
    }
  }

  /**
   * @param {object} params
   * @param {string} params.key
   * @returns {Promise<{ success: true }>}
   */
  async deleteObject({ key } = {}) {
    assertObjectKey(key, this);

    try {
      await this.client.send(
        new DeleteObjectCommand({
          Bucket: this.settings.bucket,
          Key: key,
        }),
      );
      return { success: true };
    } catch (error) {
      throw mapProviderError(error, this, {
        code: 'INTEGRATION_STORAGE_DELETE_FAILED',
        message: 'Failed to delete MinIO object',
      });
    }
  }

  /**
   * @param {object} params
   * @param {string} params.key
   * @returns {Promise<{ contentType: string|null, contentLength: number|null, etag: string|null, checksum: string|null }>}
   */
  async headObject({ key } = {}) {
    assertObjectKey(key, this);

    try {
      const response = await this.client.send(
        new HeadObjectCommand({
          Bucket: this.settings.bucket,
          Key: key,
        }),
      );

      return {
        contentType: response.ContentType ?? null,
        contentLength:
          response.ContentLength == null ? null : Number(response.ContentLength),
        etag: response.ETag ?? null,
        checksum: response.ChecksumSHA256 ?? null,
      };
    } catch (error) {
      if (isNotFoundError(error)) {
        throw new IntegrationProviderError({
          code: 'INTEGRATION_STORAGE_OBJECT_NOT_FOUND',
          message: 'MinIO object not found',
          domain: this.domain,
          providerCode: this.providerCode,
          configId: this.configId,
          details: { key, bucket: this.settings.bucket },
        });
      }

      throw mapProviderError(error, this, {
        code: 'INTEGRATION_STORAGE_HEAD_FAILED',
        message: 'Failed to head MinIO object',
      });
    }
  }
}

/**
 * Factory for the integration registry.
 * Expects resolver context:
 *   - providerConfig: provider settings JSON (`integrationConfig.config_json ?? {}`)
 *   - integrationConfig: IntegrationConfig row
 *   - provider: IntegrationProvider row
 *
 * Direct construction may still use `new MinioStorageAdapter(settingsJson)`.
 *
 * @param {{ providerConfig?: object, provider?: object, integrationConfig?: object }} context
 * @returns {MinioStorageAdapter}
 */
export function createMinioStorageAdapter({
  providerConfig = {},
  provider,
  integrationConfig,
} = {}) {
  return new MinioStorageAdapter(providerConfig, {
    configId: integrationConfig?.id ?? null,
    providerCode: provider?.code ?? PROVIDER_CODE,
  });
}

/**
 * @param {object} config
 * @param {{ configId: number|string|null, providerCode: string }} meta
 */
function normalizeMinioConfig(config, meta) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new IntegrationConfigError({
      code: 'INTEGRATION_STORAGE_CONFIG_INVALID',
      message: 'MinIO config must be an object',
      domain: INTEGRATION_DOMAINS.STORAGE,
      providerCode: meta.providerCode,
      configId: meta.configId,
    });
  }

  const required = ['endpoint', 'access_key', 'secret_key', 'bucket'];
  for (const field of required) {
    if (typeof config[field] !== 'string' || config[field].trim() === '') {
      throw new IntegrationConfigError({
        code: 'INTEGRATION_STORAGE_CONFIG_INVALID',
        message: `MinIO config missing required field: ${field}`,
        domain: INTEGRATION_DOMAINS.STORAGE,
        providerCode: meta.providerCode,
        configId: meta.configId,
      });
    }
  }

  const forcePathStyle =
    config.force_path_style == null ? true : Boolean(config.force_path_style);

  return {
    endpoint: config.endpoint.trim(),
    region:
      typeof config.region === 'string' && config.region.trim() !== ''
        ? config.region.trim()
        : DEFAULT_REGION,
    access_key: config.access_key,
    secret_key: config.secret_key,
    bucket: config.bucket.trim(),
    force_path_style: forcePathStyle,
    public_base_url:
      config.public_base_url == null || config.public_base_url === ''
        ? null
        : String(config.public_base_url),
    upload_url_ttl_seconds: normalizeTtl(
      config.upload_url_ttl_seconds,
      DEFAULT_UPLOAD_TTL_SECONDS,
    ),
    download_url_ttl_seconds: normalizeTtl(
      config.download_url_ttl_seconds,
      DEFAULT_DOWNLOAD_TTL_SECONDS,
    ),
  };
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function normalizeTtl(value, fallback) {
  if (value == null || value === '') {
    return fallback;
  }
  const ttl = Number(value);
  if (!Number.isFinite(ttl) || ttl <= 0) {
    throw new IntegrationConfigError({
      code: 'INTEGRATION_STORAGE_CONFIG_INVALID',
      message: 'MinIO TTL values must be positive numbers',
      domain: INTEGRATION_DOMAINS.STORAGE,
      providerCode: PROVIDER_CODE,
    });
  }
  return Math.floor(ttl);
}

/**
 * @param {unknown} ttlSeconds
 * @param {number} configured
 * @param {number} fallback
 * @returns {number}
 */
function resolveTtl(ttlSeconds, configured, fallback) {
  if (ttlSeconds == null || ttlSeconds === '') {
    return configured ?? fallback;
  }
  const ttl = Number(ttlSeconds);
  if (!Number.isFinite(ttl) || ttl <= 0) {
    throw new IntegrationConfigError({
      code: 'INTEGRATION_STORAGE_TTL_INVALID',
      message: 'ttlSeconds must be a positive number',
      domain: INTEGRATION_DOMAINS.STORAGE,
      providerCode: PROVIDER_CODE,
    });
  }
  return Math.floor(ttl);
}

/**
 * @param {number} ttlSeconds
 * @returns {string}
 */
function expiresAtIso(ttlSeconds) {
  return new Date(Date.now() + ttlSeconds * 1000).toISOString();
}

/**
 * @param {unknown} key
 * @param {MinioStorageAdapter} adapter
 */
function assertObjectKey(key, adapter) {
  if (typeof key !== 'string' || key.trim() === '') {
    throw new IntegrationConfigError({
      code: 'INTEGRATION_STORAGE_KEY_INVALID',
      message: 'Object key is required',
      domain: adapter.domain,
      providerCode: adapter.providerCode,
      configId: adapter.configId,
    });
  }
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isNotFoundError(error) {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const status = /** @type {{ $metadata?: { httpStatusCode?: number } }} */ (error)
    .$metadata?.httpStatusCode;
  if (status === 404) {
    return true;
  }

  const name = /** @type {{ name?: string }} */ (error).name;
  const code = /** @type {{ Code?: string, code?: string }} */ (error).Code
    || /** @type {{ code?: string }} */ (error).code;

  return name === 'NotFound' || name === 'NoSuchKey' || code === 'NotFound' || code === 'NoSuchKey';
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isRetryableAwsError(error) {
  const status = error && typeof error === 'object'
    ? /** @type {{ $metadata?: { httpStatusCode?: number } }} */ (error).$metadata
      ?.httpStatusCode
    : undefined;
  return status === 429 || status === 500 || status === 502 || status === 503;
}

/**
 * Map provider failures without leaking credentials.
 *
 * @param {unknown} error
 * @param {MinioStorageAdapter} adapter
 * @param {{ code: string, message: string }} options
 * @returns {IntegrationProviderError}
 */
function mapProviderError(error, adapter, { code, message }) {
  const status = error && typeof error === 'object'
    ? /** @type {{ $metadata?: { httpStatusCode?: number } }} */ (error).$metadata
      ?.httpStatusCode
    : undefined;

  const providerName = error && typeof error === 'object'
    ? /** @type {{ name?: string }} */ (error).name
    : undefined;

  return new IntegrationProviderError({
    code,
    message,
    retryable: isRetryableAwsError(error),
    domain: adapter.domain,
    providerCode: adapter.providerCode,
    configId: adapter.configId,
    details: {
      httpStatusCode: status ?? null,
      providerErrorName: providerName ?? null,
      bucket: adapter.settings.bucket,
    },
  });
}
