import { LINKEDIN_REST_BASE } from './constants.js';
import { getStandardHeaders } from './api.js';

/**
 * Attempts to reconcile an ambiguous publish outcome by reading recent posts for the organization.
 */
export async function reconcileLinkedInPost({ accessToken, organizationUrn, expectedCommentary }, { fetchImpl = fetch } = {}) {
  try {
    const url = `${LINKEDIN_REST_BASE}/posts?author=${encodeURIComponent(organizationUrn)}&q=author&count=10`;
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: getStandardHeaders(accessToken),
    });

    if (!response.ok) {
      return { reconciled: false, reason: `Failed to query organization posts: ${response.status}` };
    }

    const data = await response.json().catch(() => ({}));
    const elements = data.elements || [];

    const matched = elements.find(post => {
      const commentaryMatches = post.commentary && post.commentary.trim() === (expectedCommentary || '').trim();
      const authorMatches = post.author === organizationUrn;
      return commentaryMatches && authorMatches;
    });

    if (matched) {
      return {
        reconciled: true,
        postId: matched.id,
      };
    }

    return { reconciled: false, reason: 'No matching post found in recent organization posts' };
  } catch (error) {
    return { reconciled: false, error: error.message };
  }
}
