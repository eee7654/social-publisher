/**
 * Declarative Metadata Requirements Registry.
 */

export const METADATA_FIELDS = Object.freeze({
  BASE_TITLE: 'base_title',
  BASE_CAPTION: 'base_caption',
});

/**
 * Returns the next missing required or recommended metadata field.
 */
export function getNextMetadataStep(context) {
  const metadata = context.metadata || {};

  if (!('base_title' in metadata)) {
    return {
      field: METADATA_FIELDS.BASE_TITLE,
      prompt: '📝 لطفا <b>عنوان اصلی</b> (Title) ویدیو را ارسال کنید، یا روی «رد کردن» کلیک کنید:',
      optional: true,
    };
  }

  if (!('base_caption' in metadata)) {
    return {
      field: METADATA_FIELDS.BASE_CAPTION,
      prompt: '✍️ لطفا <b>متن یا کپشن اصلی</b> (Caption) ویدیو را ارسال کنید، یا روی «رد کردن» کلیک کنید:',
      optional: true,
    };
  }

  return null; // All common metadata steps complete
}

/**
 * Formats a clean Persian/English review summary for user confirmation.
 */
export function formatReviewSummary({
  campaign,
  asset,
  coverAsset,
  selectedCandidates = [],
  metadata = {},
}) {
  const lines = [
    '📋 <b>پیش‌نمایش نهایی انتشار (Final Review)</b>\n',
    `🎥 <b>ویدیو:</b> ${asset?.width || 0}x${asset?.height || 0} (${Math.round((asset?.duration_ms || 0) / 1000)} ثانیه)`,
    `🖼️ <b>کاور:</b> ${coverAsset ? 'تایید شده ✅' : 'ندارد ❌'}`,
    `📌 <b>عنوان:</b> ${metadata.base_title || '<i>(بدون عنوان)</i>'}`,
    `📝 <b>کپشن:</b> ${metadata.base_caption ? metadata.base_caption.slice(0, 100) + (metadata.base_caption.length > 100 ? '...' : '') : '<i>(بدون کپشن)</i>'}\n`,
    '🎯 <b>مقصدهای انتخابی:</b>',
  ];

  if (selectedCandidates.length === 0) {
    lines.push('⚠️ <i>هیچ مقصدی انتخاب نشده است.</i>');
  } else {
    for (const c of selectedCandidates) {
      lines.push(`• ${c.displayName} (${c.platform})`);
    }
  }
  if (selectedCandidates.some(c => c.platform === 'youtube')) {
    const yt = metadata.youtube || {};
    lines.push('\n<b>YouTube</b>', `• mode: ${yt.mode || '<i>missing</i>'}`, `• title: ${yt.title || '<i>missing</i>'}`, `• description: ${yt.description ?? metadata.base_caption ?? '<i>none</i>'}`, `• tags: ${(yt.tags || []).join(', ') || '<i>none</i>'}`, '• privacy: private', '• audience: Not made for kids');
  }

  if (selectedCandidates.some(c => c.platform === 'aparat')) {
    const ap = metadata.aparat || {};
    const title = ap.title || metadata.base_title || '<i>(بدون عنوان)</i>';
    const category = ap.category_title || ap.category || 'کسب و کار';
    const tags = Array.isArray(ap.tags) ? ap.tags.join(', ') : (ap.tags || '<i>none</i>');
    lines.push(
      '\n<b>Aparat</b>',
      '• انتشار: عمومی',
      `• عنوان: ${title}`,
      `• دسته: ${category}`,
      `• تگها: ${tags}`,
      `• کاور: ${coverAsset ? 'آماده ✅' : 'ندارد ❌'}`,
      '• ویدیو 16:9: آماده ✅'
    );
  }

  lines.push('\nجهت ثبت نهایی و آماده‌سازی کمپین، روی «تایید نهایی» کلیک کنید.');
  return lines.join('\n');
}
