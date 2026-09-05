/**
 * Input validation and security checks for Telegram updates.
 */

/**
 * Validates whether an update is from a private Telegram chat.
 * Rejects channel_posts, edited_channel_posts, groups, and supergroups.
 */
export function validatePrivateChatUpdate(update) {
  if (!update || typeof update !== 'object') {
    return { valid: false, reason: 'EMPTY_OR_MALFORMED_UPDATE' };
  }

  // 1. Explicitly reject channel posts
  if (update.channel_post || update.edited_channel_post) {
    return { valid: false, reason: 'CHANNEL_POSTS_REJECTED' };
  }

  // 2. Extract message or callback_query
  const message = update.message || update.edited_message;
  const callbackQuery = update.callback_query;

  if (message) {
    const chatType = message.chat?.type;
    if (chatType !== 'private') {
      return { valid: false, reason: `NON_PRIVATE_CHAT_REJECTED:${chatType}` };
    }
    return {
      valid: true,
      type: 'message',
      chatId: String(message.chat.id),
      userId: String(message.from?.id),
      message,
    };
  }

  if (callbackQuery) {
    const chatType = callbackQuery.message?.chat?.type;
    if (chatType && chatType !== 'private') {
      return { valid: false, reason: `NON_PRIVATE_CALLBACK_REJECTED:${chatType}` };
    }
    return {
      valid: true,
      type: 'callback_query',
      chatId: callbackQuery.message ? String(callbackQuery.message.chat.id) : String(callbackQuery.from?.id),
      userId: String(callbackQuery.from?.id),
      callbackQuery,
    };
  }

  return { valid: false, reason: 'UNSUPPORTED_UPDATE_TYPE' };
}
