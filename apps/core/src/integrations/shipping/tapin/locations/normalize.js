/**
 * Persian/Arabic mechanical text normalization.
 *
 * Two exports, same transformation, deliberately different names — because the
 * two uses have very different safety properties.
 *
 * `normalizePersianText` is a neutral primitive. Its legitimate runtime use is
 * deriving a deterministic lookup key from Esima's *own* canonical City row,
 * which is necessary because `cities` has no dedicated code column. That is key
 * derivation over data Esima owns, not a search.
 *
 * `normalizeProviderNameForBootstrap` names the dangerous use: comparing text
 * against a *provider's* catalog. LOCATION-R0 proved this cannot be production
 * authority — provider catalogs legitimately carry one name under several
 * external IDs (this dataset has such a case), so a name lookup can resolve to
 * the wrong locality and ship a real parcel to the wrong place, with nothing
 * visible to the customer or the merchant. It is confined to:
 *
 *   - proposing candidates when the static mapping is regenerated,
 *   - auditing that mapping's coverage,
 *   - maintenance diagnostics comparing Esima geography to a provider catalog.
 *
 * The suffix exists so that wiring it into a checkout path reads as obviously
 * wrong at the call site. Runtime destination translation goes through the
 * explicit mapping in `resolver.js` and performs no text comparison against
 * provider data at all.
 *
 * The transformation is purely mechanical: Unicode canonicalization,
 * Arabic↔Persian codepoint unification, diacritic and zero-width removal, digit
 * folding, whitespace removal. No fuzzy matching, no edit distance, no
 * transliteration, no synonyms.
 *
 * Note what is deliberately NOT folded: alef-madda (آ) is not reduced to bare
 * alef (ا). Folding it would gain 2 of 1132 canonical cities while widening the
 * class of names treated as identical, and it sits outside the normalization
 * set frozen for this slice. It is recorded as an owner decision rather than
 * taken unilaterally.
 */

const ZERO_WIDTH = /[​-‏‪-‮﻿]/g;
const DIACRITICS = /[ً-ْٰ]/g;
const ARABIC_YEH = /[يى]/g;
const ARABIC_KAF = /ك/g;
const ARABIC_INDIC_DIGITS = /[٠-٩۰-۹]/g;

/**
 * Whitespace is removed rather than collapsed: Persian compound place names are
 * written three ways for one place — with a zero-width non-joiner
 * (`اسلام‌شهر`), with a space (`اسلام شهر`), and closed up (`اسلامشهر`).
 * Collapsing unifies only two of the three.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizePersianText(value) {
  if (value == null) return '';
  return String(value)
    .normalize('NFKC')
    .replace(ZERO_WIDTH, '')
    .replace(DIACRITICS, '')
    .replace(ARABIC_YEH, 'ی')
    .replace(ARABIC_KAF, 'ک')
    .replace(ARABIC_INDIC_DIGITS, (digit) => String(digit.charCodeAt(0) & 0x0f))
    .replace(/\s+/g, '')
    .toLowerCase();
}

/**
 * BOOTSTRAP / AUDIT / DIAGNOSTICS ONLY — never on a checkout path.
 * See the module header for why.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeProviderNameForBootstrap(value) {
  return normalizePersianText(value);
}

export default { normalizePersianText, normalizeProviderNameForBootstrap };
