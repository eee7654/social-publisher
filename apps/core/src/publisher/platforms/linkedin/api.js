import {
  LINKEDIN_API_VERSION,
  RESTLI_PROTOCOL_VERSION,
  LINKEDIN_REST_BASE,
} from './constants.js';

export function getStandardHeaders(accessToken) {
  return {
    'Authorization': `Bearer ${accessToken}`,
    'LinkedIn-Version': LINKEDIN_API_VERSION,
    'X-Restli-Protocol-Version': RESTLI_PROTOCOL_VERSION,
  };
}

/**
 * Get organization ACLs for the authenticated member.
 */
export async function getOrganizationAcls(accessToken, { fetchImpl = fetch } = {}) {
  const url = `${LINKEDIN_REST_BASE}/organizationAcls?q=roleAssignee`;
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: getStandardHeaders(accessToken),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.message || `Failed to fetch organization ACLs: ${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data.elements || [];
}

/**
 * Get organization details by organization ID.
 */
export async function getOrganization(accessToken, organizationId, { fetchImpl = fetch } = {}) {
  const cleanId = String(organizationId).replace(/^urn:li:organization:/, '');
  const url = `${LINKEDIN_REST_BASE}/organizations/${encodeURIComponent(cleanId)}`;
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: getStandardHeaders(accessToken),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.message || `Failed to fetch organization ${cleanId}: ${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }

  const localizedName = data.localizedName || data.name?.localized?.[Object.keys(data.name?.localized || {})[0]] || `Organization ${cleanId}`;
  const vanityName = data.vanityName || null;

  return {
    id: cleanId,
    urn: `urn:li:organization:${cleanId}`,
    localizedName,
    vanityName,
    raw: data,
  };
}

/**
 * Checks member authorization for the given organization URN.
 * Inspects official organizationAuthorizations or role-based check on organizationAcls.
 */
export async function checkOrganizationAuthorization(accessToken, organizationUrn, { fetchImpl = fetch } = {}) {
  // First attempt: organizationAuthorizations endpoint if supported
  try {
    const authUrl = `${LINKEDIN_REST_BASE}/organizationAuthorizations?q=organization&organization=${encodeURIComponent(organizationUrn)}`;
    const authRes = await fetchImpl(authUrl, {
      method: 'GET',
      headers: getStandardHeaders(accessToken),
    });
    if (authRes.ok) {
      const authData = await authRes.json().catch(() => ({}));
      const elements = authData.elements || [];
      const hasPostAuth = elements.some(el => 
        el.authorizationAction === 'CREATE_ORGANIZATION_POST' || 
        el.authorizationAction === 'MANAGE_ORGANIZATION_POSTS' ||
        el.state === 'AUTHORIZED' ||
        el.state === 'APPROVED'
      );
      if (hasPostAuth) {
        return { authorized: true, role: 'ORGANIZATION_POSTER', pathUsed: 'organizationAuthorizations' };
      }
    }
  } catch {
    // Fall back to organizationAcls
  }

  // Fallback: organizationAcls role check
  const acls = await getOrganizationAcls(accessToken, { fetchImpl });
  const matchingAcl = acls.find(acl => {
    const orgMatches = acl.organization === organizationUrn || acl.organization === `urn:li:organization:${organizationUrn.replace(/^urn:li:organization:/, '')}`;
    const stateMatches = !acl.state || acl.state === 'APPROVED';
    const roleAllowed = ['ADMINISTRATOR', 'DIRECT_SPONSORED_CONTENT_POSTER', 'CONTENT_ADMIN'].includes(acl.role);
    return orgMatches && stateMatches && roleAllowed;
  });

  if (matchingAcl) {
    return {
      authorized: true,
      role: matchingAcl.role,
      pathUsed: 'organizationAcls',
    };
  }

  return {
    authorized: false,
    role: null,
    pathUsed: 'organizationAcls',
  };
}

/**
 * Initialize image upload on LinkedIn.
 */
export async function initializeImageUpload(accessToken, organizationUrn, { fetchImpl = fetch } = {}) {
  const url = `${LINKEDIN_REST_BASE}/images?action=initializeUpload`;
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      ...getStandardHeaders(accessToken),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      initializeUploadRequest: {
        owner: organizationUrn,
      },
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.message || `Failed to initialize image upload: ${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }

  const uploadUrl = data.value?.uploadUrl;
  const imageUrn = data.value?.image;

  if (!uploadUrl || !imageUrn) {
    throw new Error('LinkedIn initializeUpload response missing uploadUrl or image URN');
  }

  return { uploadUrl, imageUrn, expiresAt: data.value?.uploadUrlExpiresAt };
}

/**
 * Upload binary image to LinkedIn's single-use upload URL.
 */
export async function uploadImageBinary(uploadUrl, body, mimeType, contentLength, { fetchImpl = fetch } = {}) {
  const headers = {
    'Content-Type': mimeType || 'image/jpeg',
  };
  if (contentLength != null) {
    headers['Content-Length'] = String(contentLength);
  }

  const isStream = body && typeof body.pipe === 'function';
  const fetchOptions = {
    method: 'PUT',
    headers,
    body,
    ...(isStream ? { duplex: 'half' } : {}),
  };

  const response = await fetchImpl(uploadUrl, fetchOptions);
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    const error = new Error(`Image binary upload failed: ${response.status} ${text}`);
    error.status = response.status;
    throw error;
  }

  return { ok: true, status: response.status };
}

/**
 * Initialize video upload on LinkedIn.
 */
export async function initializeVideoUpload(accessToken, organizationUrn, fileSizeBytes, { fetchImpl = fetch } = {}) {
  if (!Number.isInteger(fileSizeBytes) || fileSizeBytes <= 0) {
    throw new Error(`Invalid video fileSizeBytes: ${fileSizeBytes}`);
  }
  const url = `${LINKEDIN_REST_BASE}/videos?action=initializeUpload`;
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      ...getStandardHeaders(accessToken),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      initializeUploadRequest: {
        owner: organizationUrn,
        fileSizeBytes,
        uploadCaptions: false,
        uploadThumbnail: false,
      },
    }),
  });

  const data = await response.json().catch(() => ({}));
  const isOk = response.ok ?? (response.status >= 200 && response.status < 300);
  if (!isOk) {
    const error = new Error(data.message || `Failed to initialize video upload: ${response.status}`);
    error.status = response.status;
    error.headers = response.headers;
    error.data = data;
    throw error;
  }

  const value = data.value || {};
  const videoUrn = value.video;
  const uploadInstructions = value.uploadInstructions || [];
  const uploadToken = value.uploadToken || '';
  const uploadUrlsExpireAt = value.uploadUrlsExpireAt || null;

  if (!videoUrn || !Array.isArray(uploadInstructions) || uploadInstructions.length === 0) {
    throw new Error('LinkedIn initializeVideoUpload response missing video URN or uploadInstructions');
  }

  return {
    videoUrn,
    uploadInstructions,
    uploadToken,
    uploadUrlsExpireAt,
  };
}

/**
 * Upload a binary video part to LinkedIn uploadUrl.
 */
export async function uploadVideoPart(uploadUrl, body, contentLength, { fetchImpl = fetch } = {}) {
  const headers = {
    'Content-Type': 'application/octet-stream',
  };
  if (contentLength != null) {
    headers['Content-Length'] = String(contentLength);
  }

  const isStream = body && typeof body.pipe === 'function';
  const fetchOptions = {
    method: 'PUT',
    headers,
    body,
    ...(isStream ? { duplex: 'half' } : {}),
  };

  const response = await fetchImpl(uploadUrl, fetchOptions);
  const isOk = response.ok ?? (response.status >= 200 && response.status < 300);
  if (!isOk) {
    const text = await response.text().catch(() => '');
    const error = new Error(`Video part binary upload failed: ${response.status} ${text}`);
    error.status = response.status;
    error.headers = response.headers;
    throw error;
  }

  const rawEtag = response.headers.get('etag');
  const cleanEtag = rawEtag ? rawEtag.replace(/^"|"$/g, '') : null;

  return {
    ok: true,
    status: response.status,
    etag: cleanEtag,
  };
}

/**
 * Finalize video upload on LinkedIn.
 */
export async function finalizeVideoUpload(accessToken, { videoUrn, uploadToken, uploadedPartIds }, { fetchImpl = fetch } = {}) {
  if (!videoUrn || !videoUrn.startsWith('urn:li:video:')) {
    throw new Error(`Invalid video URN for finalizeUpload: ${videoUrn}`);
  }
  if (!Array.isArray(uploadedPartIds) || uploadedPartIds.length === 0) {
    throw new Error('uploadedPartIds array is required and must not be empty');
  }

  const url = `${LINKEDIN_REST_BASE}/videos?action=finalizeUpload`;
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      ...getStandardHeaders(accessToken),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      finalizeUploadRequest: {
        video: videoUrn,
        uploadToken: uploadToken || '',
        uploadedPartIds,
      },
    }),
  });

  const isOk = response.ok ?? (response.status >= 200 && response.status < 300);
  if (!isOk) {
    const data = await response.json().catch(() => ({}));
    const error = new Error(data.message || `Failed to finalize video upload: ${response.status}`);
    error.status = response.status;
    error.headers = response.headers;
    error.data = data;
    throw error;
  }

  return { ok: true, status: response.status };
}

/**
 * Get video asset status from LinkedIn Videos API.
 */
export async function getVideoStatus(accessToken, videoUrn, { fetchImpl = fetch } = {}) {
  if (!videoUrn || !videoUrn.startsWith('urn:li:video:')) {
    throw new Error(`Invalid video URN for getVideoStatus: ${videoUrn}`);
  }
  const url = `${LINKEDIN_REST_BASE}/videos/${encodeURIComponent(videoUrn)}`;
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: getStandardHeaders(accessToken),
  });

  const isOk = response.ok ?? (response.status >= 200 && response.status < 300);
  const data = await response.json().catch(() => ({}));
  if (!isOk) {
    const error = new Error(data.message || `Failed to get video status: ${response.status}`);
    error.status = response.status;
    error.headers = response.headers;
    error.data = data;
    throw error;
  }

  return {
    status: data.status,
    id: data.id || videoUrn,
    raw: data,
  };
}

/**
 * Create a post via official Posts API (POST /rest/posts).
 */
export async function createPost(accessToken, { authorUrn, commentary, mediaUrn, title, mediaType }, { fetchImpl = fetch } = {}) {
  if (mediaType === 'video') {
    if (!mediaUrn || !mediaUrn.startsWith('urn:li:video:')) {
      throw new Error(`content.media.id MUST start with urn:li:video: for video posts, got: ${mediaUrn}`);
    }
  }

  if (mediaUrn && mediaUrn.startsWith('urn:li:image:') && mediaType === 'video') {
    throw new Error('Image URN rejected for video post: fail closed');
  }

  const url = `${LINKEDIN_REST_BASE}/posts`;
  const payload = {
    author: authorUrn,
    commentary,
    visibility: 'PUBLIC',
    distribution: {
      feedDistribution: 'MAIN_FEED',
      targetEntities: [],
      thirdPartyDistributionChannels: [],
    },
    lifecycleState: 'PUBLISHED',
    isReshareDisabledByAuthor: false,
  };

  if (mediaUrn) {
    payload.content = {
      media: {
        id: mediaUrn,
        title: title || 'Post Media',
      },
    };
  }

  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      ...getStandardHeaders(accessToken),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (response.status === 201) {
    const postId = response.headers.get('x-restli-id') || null;
    return {
      status: 201,
      postId,
      ok: true,
    };
  }

  const data = await response.json().catch(() => ({}));
  const error = new Error(data.message || `LinkedIn post creation failed with status ${response.status}`);
  error.status = response.status;
  error.data = data;
  throw error;
}

