import axios from 'axios';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';

export const CLOUD_MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MB
export const LOCAL_MAX_UPLOAD_BYTES = 2000 * 1024 * 1024; // 2000 MB (2 GB)
export const PUBLISHER_HARD_CAP_BYTES = 300 * 1024 * 1024; // 300 MB ElecIO limit

/**
 * Sanitizes any error message or URL to prevent leaking the Telegram Bot token.
 */
export function sanitizeTelegramError(error, token) {
  if (!error) return 'Unknown error';
  let message = error.message || String(error);
  if (token) {
    message = message.split(token).join('[REDACTED_BOT_TOKEN]');
  }
  // Generic token pattern redaction: bot<token>/
  message = message.replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot[REDACTED_BOT_TOKEN]');
  // Also redact signatures or query string credentials
  message = message.replace(/X-Amz-Signature=[a-f0-9]+/gi, 'X-Amz-Signature=[REDACTED]');
  return message;
}

function ensureBotToken(token) {
  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN is not configured');
  }
}

function ensureRelativeTelegramFilePath(filePath) {
  const cleanPath = String(filePath || '');
  if (!cleanPath || path.isAbsolute(cleanPath) || cleanPath.includes('..')) {
    const err = new Error('Telegram file_path must be a relative Bot API file path in cloud/HTTP mode');
    err.code = 'TELEGRAM_FILE_PATH_INVALID';
    throw err;
  }
  return cleanPath.replace(/^\/+/, '');
}

async function resolveInsideAllowedRoot(filePath, rootDir) {
  if (!rootDir) {
    const err = new Error('TELEGRAM_LOCAL_FILES_DIR is required for Local Bot API absolute file paths');
    err.code = 'TELEGRAM_LOCAL_FILES_DIR_REQUIRED';
    throw err;
  }

  const fileRealPath = await fs.promises.realpath(filePath);
  const rootRealPath = await fs.promises.realpath(rootDir);
  const relative = path.relative(rootRealPath, fileRealPath);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    return fileRealPath;
  }

  const err = new Error('Telegram Local Bot API file path is outside TELEGRAM_LOCAL_FILES_DIR');
  err.code = 'TELEGRAM_LOCAL_FILE_OUT_OF_ROOT';
  throw err;
}

export async function resolveTelegramFileSource({
  filePath,
  mode = 'cloud',
  baseUrl = 'https://api.telegram.org',
  botToken,
  localFilesDir = process.env.TELEGRAM_LOCAL_FILES_DIR,
  timeoutMs = 30000,
  httpGet = axios.get,
} = {}) {
  ensureBotToken(botToken);
  const cleanMode = String(mode || 'cloud').toLowerCase();
  const rawFilePath = String(filePath || '');
  if (!rawFilePath) {
    const err = new Error('Telegram file_path is required');
    err.code = 'TELEGRAM_FILE_PATH_REQUIRED';
    throw err;
  }

  if (cleanMode === 'local' && path.isAbsolute(rawFilePath)) {
    const safePath = await resolveInsideAllowedRoot(rawFilePath, localFilesDir);
    return {
      kind: 'local-file',
      path: safePath,
      stream: fs.createReadStream(safePath),
    };
  }

  const relativePath = ensureRelativeTelegramFilePath(rawFilePath);
  const cleanBaseUrl = String(baseUrl || '').replace(/\/+$/, '');
  const url = `${cleanBaseUrl}/file/bot${botToken}/${relativePath}`;
  const response = await httpGet(url, {
    responseType: 'stream',
    timeout: timeoutMs,
  });
  return {
    kind: 'bot-api-http',
    url,
    stream: response.data,
  };
}

export async function checkTelegramHealth({
  client = null,
  clientFactory = null,
  httpGet = axios.get,
  timeoutMs = 5000,
} = {}) {
  const telegramClient = client || (clientFactory ? clientFactory() : getTelegramClient({ timeoutMs }));
  const result = {
    mode: telegramClient.mode,
    telegram_local_api: telegramClient.mode === 'local' ? 'unhealthy' : 'not_applicable',
    telegram_bot: 'unavailable',
  };

  if (telegramClient.mode === 'local') {
    try {
      await httpGet(telegramClient.baseUrl, {
        timeout: timeoutMs,
        validateStatus: () => true,
      });
      result.telegram_local_api = 'healthy';
    } catch {
      result.telegram_local_api = 'unhealthy';
    }
  }

  try {
    const me = await telegramClient.getMe();
    result.telegram_bot = me?.is_bot ? 'authenticated' : 'unavailable';
    if (me?.id) result.bot_id = me.id;
    if (me?.username) result.bot_username = me.username;
  } catch (err) {
    result.telegram_bot = 'unavailable';
    result.error = sanitizeTelegramError(err, telegramClient.botToken);
  }

  return result;
}

/**
 * Converts a stream or buffer into a Buffer while strictly validating maximum size
 * and expected byte count (failing closed on short or overflow reads).
 */
export async function readStreamWithByteLimit(streamOrBuffer, maxBytes, expectedBytes = null) {
  if (!streamOrBuffer) return null;
  if (Buffer.isBuffer(streamOrBuffer)) {
    if (maxBytes && streamOrBuffer.length > maxBytes) {
      const err = new Error(`Payload size ${streamOrBuffer.length} bytes exceeds maximum allowed limit of ${maxBytes} bytes`);
      err.code = 'TELEGRAM_FILE_TOO_LARGE';
      throw err;
    }
    if (expectedBytes != null && streamOrBuffer.length !== expectedBytes) {
      const err = new Error(`Buffer finished with byte count mismatch: expected ${expectedBytes} bytes, got ${streamOrBuffer.length}`);
      err.code = 'STREAM_LENGTH_MISMATCH';
      throw err;
    }
    return streamOrBuffer;
  }

  let bytesRead = 0;
  const chunks = [];
  for await (const chunk of streamOrBuffer) {
    bytesRead += chunk.length;
    if (maxBytes && bytesRead > maxBytes) {
      const err = new Error(`Payload size exceeded limit of ${maxBytes} bytes (read ${bytesRead} bytes)`);
      err.code = 'TELEGRAM_FILE_TOO_LARGE';
      throw err;
    }
    chunks.push(chunk);
  }

  if (expectedBytes != null && bytesRead !== expectedBytes) {
    const err = new Error(`Stream finished with short read: expected ${expectedBytes} bytes, got ${bytesRead}`);
    err.code = 'STREAM_SHORT_READ';
    throw err;
  }

  return Buffer.concat(chunks);
}

/**
 * Asynchronously generates chunks for a multipart/form-data payload without materializing
 * the entire file into a contiguous in-memory Buffer or Blob.
 */
export async function* createMultipartStream({
  boundary,
  fields = {},
  files = [],
}) {
  // 1. Emit text fields
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    const header = `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`;
    yield Buffer.from(header, 'utf8');
  }

  // 2. Stream attached files chunk-by-chunk directly
  for (const file of files) {
    if (!file || !file.stream) continue;
    const fileHeader = `--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\nContent-Type: ${file.contentType || 'application/octet-stream'}\r\n\r\n`;
    yield Buffer.from(fileHeader, 'utf8');

    let bytesStreamed = 0;
    if (Buffer.isBuffer(file.stream)) {
      bytesStreamed = file.stream.length;
      if (file.maxBytes && bytesStreamed > file.maxBytes) {
        const err = new Error(`File ${file.name} exceeded maximum allowed limit of ${file.maxBytes} bytes`);
        err.code = 'TELEGRAM_FILE_TOO_LARGE';
        throw err;
      }
      yield file.stream;
    } else {
      for await (const chunk of file.stream) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytesStreamed += buf.length;
        if (file.maxBytes && bytesStreamed > file.maxBytes) {
          const err = new Error(`File ${file.name} exceeded maximum allowed limit of ${file.maxBytes} bytes (streamed ${bytesStreamed} bytes)`);
          err.code = 'TELEGRAM_FILE_TOO_LARGE';
          throw err;
        }
        yield buf;
      }
    }

    if (file.sizeBytes != null && bytesStreamed !== file.sizeBytes) {
      const err = new Error(`File ${file.name} stream finished with short/length mismatch: expected ${file.sizeBytes} bytes, got ${bytesStreamed}`);
      err.code = 'STREAM_SHORT_READ';
      throw err;
    }

    yield Buffer.from('\r\n', 'utf8');
  }

  // 3. Emit closing boundary
  const closing = `--${boundary}--\r\n`;
  yield Buffer.from(closing, 'utf8');
}

/**
 * Calculates the exact byte-deterministic Content-Length of a multipart stream.
 */
export function calculateMultipartLength({
  boundary,
  fields = {},
  files = [],
}) {
  let totalLength = 0;
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    const header = `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`;
    totalLength += Buffer.byteLength(header, 'utf8');
  }

  for (const file of files) {
    if (!file || !file.stream) continue;
    if (typeof file.sizeBytes !== 'number' || file.sizeBytes < 0) {
      return null;
    }
    const fileHeader = `--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\nContent-Type: ${file.contentType || 'application/octet-stream'}\r\n\r\n`;
    totalLength += Buffer.byteLength(fileHeader, 'utf8') + file.sizeBytes + 2; // +2 for trailing \r\n
  }

  const closing = `--${boundary}--\r\n`;
  totalLength += Buffer.byteLength(closing, 'utf8');
  return totalLength;
}

export class TelegramApiClient {
  constructor(options = {}) {
    this.botToken = options.botToken || process.env.TELEGRAM_BOT_TOKEN;
    this.mode = (options.mode || process.env.TELEGRAM_BOT_API_MODE || 'cloud').toLowerCase();
    
    // In Local API mode, base URL can be http://localhost:8081 or configured endpoint
    const defaultBaseUrl = this.mode === 'local' ? 'http://127.0.0.1:8081' : 'https://api.telegram.org';
    this.baseUrl = (options.baseUrl || process.env.TELEGRAM_BOT_API_BASE_URL || defaultBaseUrl).replace(/\/+$/, '');
    
    this.timeoutMs = options.timeoutMs || 30000;
    this.localFilesDir = options.localFilesDir || process.env.TELEGRAM_LOCAL_FILES_DIR || null;
    this.maxUploadBytes = this.mode === 'local' ? LOCAL_MAX_UPLOAD_BYTES : CLOUD_MAX_UPLOAD_BYTES;
  }

  getApiUrl(method) {
    ensureBotToken(this.botToken);
    return `${this.baseUrl}/bot${this.botToken}/${method}`;
  }

  getFileDownloadUrl(filePath) {
    ensureBotToken(this.botToken);
    const relativePath = ensureRelativeTelegramFilePath(filePath);
    return `${this.baseUrl}/file/bot${this.botToken}/${relativePath}`;
  }

  async callMethod(method, payload = {}, config = {}) {
    const url = this.getApiUrl(method);
    try {
      const response = await axios.post(url, payload, {
        timeout: config.timeout || this.timeoutMs,
        headers: { 'Content-Type': 'application/json' },
      });
      if (response.data && response.data.ok) {
        return response.data.result;
      }
      throw new Error(response.data?.description || `Telegram API call ${method} failed`);
    } catch (err) {
      const telegramDescription = err.response?.data?.description;
      const detail = telegramDescription ? `${telegramDescription} (${err.message})` : err;
      const sanitized = sanitizeTelegramError(detail, this.botToken);
      const safeErr = new Error(`[TelegramAPI] ${method} error: ${sanitized}`);
      if (err.response?.data) {
        safeErr.description = sanitizeTelegramError(err.response.data.description, this.botToken);
        safeErr.error_code = err.response.data.error_code;
        safeErr.parameters = err.response.data.parameters;
      }
      throw safeErr;
    }
  }

  async getMe() {
    return this.callMethod('getMe');
  }

  async getUpdates({ offset = 0, limit = 100, timeout = 30, allowed_updates } = {}) {
    // Timeout for HTTP request should be slightly larger than Telegram long-poll timeout
    const httpTimeout = (timeout + 10) * 1000;
    const params = { offset, limit, timeout };
    if (allowed_updates) {
      params.allowed_updates = allowed_updates;
    }
    return this.callMethod('getUpdates', params, { timeout: httpTimeout });
  }

  async getFile(fileId) {
    return this.callMethod('getFile', { file_id: fileId });
  }

  async getWebhookInfo() {
    return this.callMethod('getWebhookInfo');
  }

  async logOut() {
    return this.callMethod('logOut');
  }

  async getChat(chatId) {
    return this.callMethod('getChat', { chat_id: chatId });
  }

  async getChatMember(chatId, userId) {
    return this.callMethod('getChatMember', { chat_id: chatId, user_id: userId });
  }

  async sendMessage({ chat_id, text, reply_markup, parse_mode = 'HTML', disable_web_page_preview = true }) {
    return this.callMethod('sendMessage', {
      chat_id,
      text,
      reply_markup,
      parse_mode,
      disable_web_page_preview,
    });
  }

  async editMessageText({ chat_id, message_id, text, reply_markup, parse_mode = 'HTML' }) {
    return this.callMethod('editMessageText', {
      chat_id,
      message_id,
      text,
      reply_markup,
      parse_mode,
    });
  }

  async answerCallbackQuery({ callback_query_id, text, show_alert = false }) {
    return this.callMethod('answerCallbackQuery', {
      callback_query_id,
      text,
      show_alert,
    });
  }

  async downloadFileStream(filePath) {
    try {
      const source = await resolveTelegramFileSource({
        filePath,
        mode: this.mode,
        baseUrl: this.baseUrl,
        botToken: this.botToken,
        localFilesDir: this.localFilesDir,
        timeoutMs: this.timeoutMs,
      });
      return source.stream;
    } catch (err) {
      const sanitized = sanitizeTelegramError(err, this.botToken);
      const safeErr = new Error(`[TelegramAPI] File download failed: ${sanitized}`);
      safeErr.code = err.code;
      throw safeErr;
    }
  }

  /**
   * Sends a photo to a chat or channel.
   * If photo is a stream or Buffer, uploads via streaming multipart/form-data.
   */
  async sendPhoto({
    chat_id,
    photo,
    caption,
    parse_mode,
    reply_markup,
    filename = 'photo.jpg',
    fileSizeBytes = null,
    fetchImpl = fetch,
  }) {
    if (typeof photo === 'string') {
      const payload = { chat_id, photo };
      if (caption != null && caption !== '') payload.caption = caption;
      if (parse_mode) payload.parse_mode = parse_mode;
      if (reply_markup) payload.reply_markup = reply_markup;
      return this.callMethod('sendPhoto', payload);
    }

    if (fileSizeBytes != null && fileSizeBytes > this.maxUploadBytes) {
      const err = new Error(
        `[TelegramAPI] Photo file size ${fileSizeBytes} bytes exceeds ${this.mode} API limit of ${this.maxUploadBytes} bytes`
      );
      err.code = 'TELEGRAM_FILE_TOO_LARGE';
      throw err;
    }

    const fields = { chat_id: String(chat_id) };
    if (caption != null && caption !== '') fields.caption = caption;
    if (parse_mode) fields.parse_mode = parse_mode;
    if (reply_markup) {
      fields.reply_markup = typeof reply_markup === 'string' ? reply_markup : JSON.stringify(reply_markup);
    }

    const files = [
      {
        name: 'photo',
        filename,
        contentType: 'image/jpeg',
        stream: photo,
        sizeBytes: fileSizeBytes,
        maxBytes: this.maxUploadBytes,
      },
    ];

    return this._postStreamingMultipart('sendPhoto', { fields, files, fetchImpl });
  }

  /**
   * Sends a video to a chat or channel.
   * Uploads via bounded streaming multipart/form-data directly from stream.
   */
  async sendVideo({
    chat_id,
    video,
    caption,
    parse_mode,
    reply_markup,
    duration,
    width,
    height,
    cover = null,
    filename = 'video.mp4',
    coverFilename = 'cover.jpg',
    fileSizeBytes = null,
    coverSizeBytes = null,
    supports_streaming = true,
    fetchImpl = fetch,
  }) {
    // Fail BEFORE opening or consuming video stream if size exceeds mode limit
    if (this.mode === 'cloud' && fileSizeBytes != null && fileSizeBytes > CLOUD_MAX_UPLOAD_BYTES) {
      const err = new Error(
        `[TelegramAPI] Video file size ${fileSizeBytes} bytes exceeds Telegram Cloud Bot API limit of 50MB. Switch to Local Bot API or upload smaller file.`
      );
      err.code = 'TELEGRAM_CLOUD_FILE_TOO_LARGE';
      throw err;
    }

    const effectiveLimit = this.mode === 'local'
      ? Math.min(PUBLISHER_HARD_CAP_BYTES, this.maxUploadBytes)
      : CLOUD_MAX_UPLOAD_BYTES;

    if (fileSizeBytes != null && fileSizeBytes > effectiveLimit) {
      const err = new Error(
        `[TelegramAPI] Video file size ${fileSizeBytes} bytes exceeds ${this.mode} API limit of ${effectiveLimit} bytes.`
      );
      err.code = 'TELEGRAM_FILE_TOO_LARGE';
      throw err;
    }

    if (typeof video === 'string') {
      const payload = {
        chat_id,
        video,
        supports_streaming,
      };
      if (caption != null && caption !== '') payload.caption = caption;
      if (parse_mode) payload.parse_mode = parse_mode;
      if (reply_markup) payload.reply_markup = reply_markup;
      if (duration != null) payload.duration = Math.round(duration);
      if (width != null) payload.width = Math.round(width);
      if (height != null) payload.height = Math.round(height);
      if (cover) payload.cover = cover;
      return this.callMethod('sendVideo', payload);
    }

    const fields = {
      chat_id: String(chat_id),
      video: 'attach://video',
    };
    if (caption != null && caption !== '') fields.caption = caption;
    if (parse_mode) fields.parse_mode = parse_mode;
    if (duration != null) fields.duration = String(Math.round(duration));
    if (width != null) fields.width = String(Math.round(width));
    if (height != null) fields.height = String(Math.round(height));
    if (supports_streaming) fields.supports_streaming = 'true';
    if (reply_markup) {
      fields.reply_markup = typeof reply_markup === 'string' ? reply_markup : JSON.stringify(reply_markup);
    }
    if (cover) {
      fields.cover = 'attach://cover';
    }

    const files = [
      {
        name: 'video',
        filename: filename || 'video.mp4',
        contentType: 'video/mp4',
        stream: video,
        sizeBytes: fileSizeBytes,
        maxBytes: effectiveLimit,
      },
    ];

    if (cover) {
      files.push({
        name: 'cover',
        filename: coverFilename || 'cover.jpg',
        contentType: 'image/jpeg',
        stream: cover,
        sizeBytes: coverSizeBytes,
        maxBytes: 10 * 1024 * 1024,
      });
    }

    return this._postStreamingMultipart('sendVideo', { fields, files, fetchImpl });
  }

  async _postStreamingMultipart(method, { fields = {}, files = [], fetchImpl = fetch } = {}) {
    const boundary = `----ElecIOPublisher${randomUUID().replace(/-/g, '')}`;
    const stream = Readable.from(createMultipartStream({ boundary, fields, files }));
    const contentLength = calculateMultipartLength({ boundary, fields, files });

    const headers = {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    };
    if (contentLength != null) {
      headers['Content-Length'] = String(contentLength);
    }

    const url = this.getApiUrl(method);
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: stream,
        duplex: 'half',
      });

      const data = await response.json().catch(() => null);
      if (response.ok && data?.ok) {
        return data.result;
      }

      const telegramDescription = data?.description;
      const detail = telegramDescription || `HTTP ${response.status} ${response.statusText}`;
      const sanitized = sanitizeTelegramError(detail, this.botToken);
      const safeErr = new Error(`[TelegramAPI] ${method} error: ${sanitized}`);
      safeErr.status = response.status;
      safeErr.error_code = data?.error_code || response.status;
      safeErr.description = sanitizeTelegramError(telegramDescription || '', this.botToken);
      safeErr.parameters = data?.parameters;
      throw safeErr;
    } catch (err) {
      if (
        err.error_code ||
        err.code === 'TELEGRAM_CLOUD_FILE_TOO_LARGE' ||
        err.code === 'TELEGRAM_FILE_TOO_LARGE' ||
        err.code === 'STREAM_SHORT_READ'
      ) {
        throw err;
      }
      const sanitized = sanitizeTelegramError(err, this.botToken);
      const safeErr = new Error(`[TelegramAPI] ${method} error: ${sanitized}`);
      safeErr.cause = err;
      throw safeErr;
    }
  }
}

export const TelegramBotApiClient = TelegramApiClient;

let defaultClient = null;

export function getTelegramClient(options = {}) {
  if (!defaultClient || Object.keys(options).length > 0) {
    defaultClient = new TelegramApiClient(options);
  }
  return defaultClient;
}

export const getTelegramBotClient = getTelegramClient;
