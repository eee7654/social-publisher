import { sanitizeAparatError } from './api.js';

/**
 * Queries authoritative uploaded chunk state from Aparat UC server:
 * GET <upload_server>/chunks/<qquuid>?includeFileSize=1
 *
 * Response format:
 * {
 *   "uuid": "...",
 *   "parts": [0, 1, 2, ...],
 *   "sizes": [3000000, ...]
 * }
 */
export async function queryServerChunks({
  uploadServer,
  qquuid,
  fetchImpl = fetch,
}) {
  if (!uploadServer) throw new Error('uploadServer is required to query chunks');
  if (!qquuid) throw new Error('qquuid is required to query chunks');

  const cleanServer = uploadServer.replace(/\/+$/, '');
  const url = `${cleanServer}/chunks/${encodeURIComponent(qquuid)}?includeFileSize=1`;

  let res;
  try {
    res = await fetchImpl(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': 'ElecIO-Publisher/1.0',
      },
    });
  } catch (netErr) {
    const err = new Error(`[AparatUpload] Network failure querying chunks: ${sanitizeAparatError(netErr)}`);
    err.code = 'APARAT_NETWORK_ERROR';
    throw err;
  }

  if (res.status === 404) {
    // No chunks uploaded yet
    return {
      uuid: qquuid,
      parts: [],
      sizes: [],
    };
  }

  let data;
  try {
    data = await res.json();
  } catch {
    const err = new Error(`[AparatUpload] Invalid JSON response querying chunks (HTTP ${res.status})`);
    err.code = 'APARAT_INVALID_RESPONSE';
    throw err;
  }

  return {
    uuid: data.uuid || qquuid,
    parts: Array.isArray(data.parts) ? data.parts.map(Number) : [],
    sizes: Array.isArray(data.sizes) ? data.sizes.map(Number) : [],
  };
}

/**
 * Uploads a single 3MB chunk to the Aparat UC server:
 * POST <upload_server>/upload
 * Header: X-Token: <token>
 * multipart/form-data fields: qqpartindex, qqchunksize, qqpartbyteoffset, qqtotalfilesize,
 *                             qqtype, qquuid, qqfilename, qqfilepath, qqtotalparts, qqfile
 */
export async function uploadChunk({
  uploadServer,
  uploadToken,
  partIndex,
  partOffset,
  partSize,
  totalFileSize,
  totalParts,
  qquuid,
  filename = 'video.mp4',
  mimeType = 'video/mp4',
  chunkBuffer,
  fetchImpl = fetch,
}) {
  if (!uploadServer) throw new Error('uploadServer is required');
  if (!uploadToken) throw new Error('uploadToken is required');
  if (!chunkBuffer) throw new Error('chunkBuffer is required');

  if (chunkBuffer.length !== partSize) {
    const err = new Error(`[AparatUpload] Chunk buffer size (${chunkBuffer.length}) does not match expected part size (${partSize})`);
    err.code = 'APARAT_CHUNK_SIZE_MISMATCH';
    throw err;
  }

  const cleanServer = uploadServer.replace(/\/+$/, '');
  const url = `${cleanServer}/upload`;

  // Build multipart form-data payload natively using FormData or Buffer boundaries
  const formData = new FormData();
  formData.append('qqpartindex', String(partIndex));
  formData.append('qqchunksize', String(partSize));
  formData.append('qqpartbyteoffset', String(partOffset));
  formData.append('qqtotalfilesize', String(totalFileSize));
  formData.append('qqtype', mimeType);
  formData.append('qquuid', qquuid);
  formData.append('qqfilename', filename);
  formData.append('qqfilepath', filename);
  formData.append('qqtotalparts', String(totalParts));

  // Append file bytes as Blob/File
  const fileBlob = new Blob([chunkBuffer], { type: mimeType });
  formData.append('qqfile', fileBlob, filename);

  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'X-Token': uploadToken,
        'User-Agent': 'ElecIO-Publisher/1.0',
      },
      body: formData,
    });
  } catch (netErr) {
    const err = new Error(`[AparatUpload] Network failure uploading chunk ${partIndex}: ${sanitizeAparatError(netErr, [uploadToken])}`);
    err.code = 'APARAT_CHUNK_NETWORK_ERROR';
    throw err;
  }

  if (res.status === 401 || res.status === 403) {
    const err = new Error(`[AparatUpload] Unauthorized token during chunk upload (HTTP ${res.status})`);
    err.code = 'APARAT_AUTH_REQUIRED';
    throw err;
  }

  let data;
  try {
    data = await res.json();
  } catch {
    const err = new Error(`[AparatUpload] Invalid JSON response uploading chunk ${partIndex} (HTTP ${res.status})`);
    err.code = 'APARAT_INVALID_RESPONSE';
    throw err;
  }

  if (!res.ok || data?.success !== true) {
    const reason = data?.error || data?.message || `HTTP ${res.status}`;
    const err = new Error(`[AparatUpload] Chunk upload ${partIndex} failed: ${reason}`);
    err.code = 'APARAT_CHUNK_FAILED';
    throw err;
  }

  return { success: true, partIndex };
}

/**
 * Signals chunks completion on Aparat UC server:
 * POST <upload_server>/chunksdone
 * Header: X-Token: <token>
 * multipart fields: qquuid, qqfilename, qqtotalfilesize, qqtotalparts
 *
 * Successful response may be 200 with empty body (do not require JSON).
 */
export async function completeChunksDone({
  uploadServer,
  uploadToken,
  qquuid,
  filename = 'video.mp4',
  totalFileSize,
  totalParts,
  fetchImpl = fetch,
}) {
  if (!uploadServer) throw new Error('uploadServer is required');
  if (!uploadToken) throw new Error('uploadToken is required');
  if (!qquuid) throw new Error('qquuid is required');

  const cleanServer = uploadServer.replace(/\/+$/, '');
  const url = `${cleanServer}/chunksdone`;

  const formData = new FormData();
  formData.append('qquuid', qquuid);
  formData.append('qqfilename', filename);
  formData.append('qqtotalfilesize', String(totalFileSize));
  formData.append('qqtotalparts', String(totalParts));

  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'X-Token': uploadToken,
        'User-Agent': 'ElecIO-Publisher/1.0',
      },
      body: formData,
    });
  } catch (netErr) {
    const err = new Error(`[AparatUpload] Network failure calling chunksdone: ${sanitizeAparatError(netErr, [uploadToken])}`);
    err.code = 'APARAT_CHUNKSDONE_NETWORK_ERROR';
    throw err;
  }

  if (res.status === 401 || res.status === 403) {
    const err = new Error(`[AparatUpload] Unauthorized token in chunksdone (HTTP ${res.status})`);
    err.code = 'APARAT_AUTH_REQUIRED';
    throw err;
  }

  // 2xx response (even empty body) is success
  if (!res.ok) {
    const err = new Error(`[AparatUpload] chunksdone returned status ${res.status}`);
    err.code = 'APARAT_CHUNKSDONE_FAILED';
    throw err;
  }

  return { success: true };
}

/**
 * Verifies assembled file existence, size, and MIME type on Aparat UC server:
 * GET <upload_server>/file/<qquuid>
 *
 * Current response:
 * {
 *   "real_name": "video.mp4",
 *   "extension": "mp4",
 *   "size": 1234567,
 *   "mime_type": "video/mp4",
 *   "signature": "...",
 *   "modification_time": 1234567890
 * }
 */
export async function verifyAssembledFile({
  uploadServer,
  qquuid,
  expectedSize,
  fetchImpl = fetch,
}) {
  if (!uploadServer) throw new Error('uploadServer is required');
  if (!qquuid) throw new Error('qquuid is required');

  const cleanServer = uploadServer.replace(/\/+$/, '');
  const url = `${cleanServer}/file/${encodeURIComponent(qquuid)}`;

  let res;
  try {
    res = await fetchImpl(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': 'ElecIO-Publisher/1.0',
      },
    });
  } catch (netErr) {
    const err = new Error(`[AparatUpload] Network failure verifying assembled file: ${sanitizeAparatError(netErr)}`);
    err.code = 'APARAT_NETWORK_ERROR';
    throw err;
  }

  if (res.status === 404) {
    const err = new Error(`[AparatUpload] Assembled file ${qquuid} not found on server`);
    err.code = 'APARAT_FILE_NOT_FOUND';
    throw err;
  }

  let data;
  try {
    data = await res.json();
  } catch {
    const err = new Error(`[AparatUpload] Invalid JSON response verifying assembled file (HTTP ${res.status})`);
    err.code = 'APARAT_INVALID_RESPONSE';
    throw err;
  }

  const serverSize = Number(data.size);
  if (expectedSize != null && serverSize !== Number(expectedSize)) {
    const err = new Error(`[AparatUpload] Assembled file size (${serverSize}) does not match expected size (${expectedSize})`);
    err.code = 'APARAT_FILE_SIZE_MISMATCH';
    throw err;
  }

  return {
    verified: true,
    size: serverSize,
    mime_type: data.mime_type,
    extension: data.extension,
  };
}
