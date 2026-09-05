import { CALLBACK_ACTIONS } from './constants.js';
import { COMPATIBILITY_STATUS } from '../media/constants.js';

/**
 * Inline keyboard for deciding between resuming an existing draft or starting new.
 */
export function getResumeOrCancelKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '▶️ ادامه پیش‌نویس (Resume)', callback_data: `${CALLBACK_ACTIONS.RESUME_DRAFT}` },
        { text: '🗑️ لغو و شروع جدید (New)', callback_data: `${CALLBACK_ACTIONS.CANCEL_START_NEW}` },
      ],
    ],
  };
}

/**
 * Inline keyboard for toggling and confirming publishing targets.
 */
export function getTargetSelectionKeyboard(candidates = [], selectedIds = new Set()) {
  const keyboard = [];
  const selectedSet = selectedIds instanceof Set
    ? selectedIds
    : new Set(Array.isArray(selectedIds) ? selectedIds : []);

  for (const c of candidates) {
    const isSelected = selectedSet.has(c.candidateId);
    let prefix = '❌ ';
    if (isSelected) {
      prefix = '✅ ';
    } else if (c.status === COMPATIBILITY_STATUS.NEEDS_CREATIVE_VARIANT) {
      prefix = '⚠️ ';
    } else if (!c.publisherAvailable) {
      prefix = '🔒 ';
    }

    const buttonText = `${prefix}${c.displayName}`;
    keyboard.push([
      {
        text: buttonText,
        callback_data: `${CALLBACK_ACTIONS.TOGGLE_TARGET}:${c.candidateId}`,
      },
    ]);
  }

  // Action buttons
  keyboard.push([
    { text: '✅ تایید مقصدها (Confirm)', callback_data: `${CALLBACK_ACTIONS.CONFIRM_TARGETS}` },
    { text: '❌ لغو (Cancel)', callback_data: `${CALLBACK_ACTIONS.CANCEL_COMPOSITION}` },
  ]);

  return { inline_keyboard: keyboard };
}

/**
 * Inline keyboard for optional metadata steps with a Skip button.
 */
export function getMetadataSkipKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '⏭️ رد کردن (Skip)', callback_data: `${CALLBACK_ACTIONS.SKIP_METADATA}` },
        { text: '❌ لغو (Cancel)', callback_data: `${CALLBACK_ACTIONS.CANCEL_COMPOSITION}` },
      ],
    ],
  };
}

export function getYouTubeModeKeyboard() {
  return { inline_keyboard: [[
    { text: 'Short', callback_data: `${CALLBACK_ACTIONS.YOUTUBE_MODE}:SHORT` },
    { text: 'Regular Video', callback_data: `${CALLBACK_ACTIONS.YOUTUBE_MODE}:REGULAR` },
  ], [{ text: '❌ لغو (Cancel)', callback_data: CALLBACK_ACTIONS.CANCEL_COMPOSITION }]] };
}

/**
 * Inline keyboard for final review confirmation.
 */
export function getFinalReviewKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '🚀 تایید نهایی و ایجاد کمپین (Confirm)', callback_data: `${CALLBACK_ACTIONS.FINAL_CONFIRM}` },
      ],
      [
        { text: '❌ لغو انتشار (Cancel)', callback_data: `${CALLBACK_ACTIONS.CANCEL_COMPOSITION}` },
      ],
    ],
  };
}
