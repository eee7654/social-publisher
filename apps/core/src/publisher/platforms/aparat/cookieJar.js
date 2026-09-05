/**
 * Minimal, secure CookieJar for Aparat authenticated web sessions.
 *
 * Enforces:
 * 1. Minimal session credentials: only stores relevant session cookies (AuthV1, AFCN).
 * 2. Excludes tracking/analytics/third-party cookies (_ga, _gid, _ym_uid, aparatUid, PHPSESSID, etc.).
 * 3. Never leaks cookie values in logs, errors, or string inspection.
 * 4. Tracks cookie rotation on every HTTP response with an onChange listener.
 */

const ALLOWED_SESSION_COOKIES = new Set([
  'AuthV1',
  'AFCN',
]);

export class AparatCookieJar {
  constructor(initialCookies = {}, onChangeCallback = null) {
    this._cookies = new Map();
    this._onChangeCallback = onChangeCallback;

    if (initialCookies && typeof initialCookies === 'object') {
      for (const [key, val] of Object.entries(initialCookies)) {
        if (val && typeof val === 'string') {
          this.setCookie(key, val);
        }
      }
    }
  }

  setOnChange(callback) {
    this._onChangeCallback = callback;
  }

  clear() {
    this._cookies.clear();
    if (typeof this._onChangeCallback === 'function') {
      try {
        this._onChangeCallback(this.toJSON());
      } catch {
        // ignore callback error
      }
    }
  }

  get(name) {
    return this._cookies.get(name) || null;
  }

  setCookie(name, value, attributes = {}) {
    if (!name || typeof name !== 'string') return;
    const cleanName = name.trim();

    // Filter out analytics / third-party / non-session cookies
    if (!ALLOWED_SESSION_COOKIES.has(cleanName)) {
      return;
    }

    const cleanValue = typeof value === 'string' ? value.trim() : '';
    const oldVal = this._cookies.get(cleanName);
    if (oldVal !== cleanValue) {
      this._cookies.set(cleanName, cleanValue);
      if (typeof this._onChangeCallback === 'function') {
        try {
          this._onChangeCallback(this.toJSON());
        } catch {
          // ignore callback error
        }
      }
    }
  }

  /**
   * Parses Set-Cookie header(s) from a Fetch Response.
   * Handles Response.headers.getSetCookie() (standard), Response.headers.get('set-cookie'),
   * or raw arrays/strings.
   */
  parseResponseHeaders(headers) {
    if (!headers) return;

    let setCookieValues = [];
    if (typeof headers.getSetCookie === 'function') {
      setCookieValues = headers.getSetCookie();
    } else if (typeof headers.get === 'function') {
      const single = headers.get('set-cookie');
      if (single) {
        setCookieValues = [single];
      }
    } else if (Array.isArray(headers['set-cookie'])) {
      setCookieValues = headers['set-cookie'];
    } else if (typeof headers['set-cookie'] === 'string') {
      setCookieValues = [headers['set-cookie']];
    }

    for (const raw of setCookieValues) {
      this.parseSetCookieString(raw);
    }
  }

  /**
   * Parses a single Set-Cookie header string.
   */
  parseSetCookieString(setCookieStr) {
    if (!setCookieStr || typeof setCookieStr !== 'string') return;

    // Split on first ';' to get name=value
    const parts = setCookieStr.split(';');
    const pair = parts[0].trim();
    const eqIdx = pair.indexOf('=');
    if (eqIdx <= 0) return;

    const name = pair.slice(0, eqIdx).trim();
    const value = pair.slice(eqIdx + 1).trim();

    this.setCookie(name, value);
  }

  /**
   * Returns the formatted Cookie header for outgoing HTTP requests.
   */
  toCookieHeader() {
    const pairs = [];
    for (const [name, val] of this._cookies.entries()) {
      if (val) {
        pairs.push(`${name}=${val}`);
      }
    }
    return pairs.join('; ');
  }

  /**
   * Serializes only the minimal session credentials.
   */
  toJSON() {
    const obj = {};
    for (const [name, val] of this._cookies.entries()) {
      obj[name] = val;
    }
    return obj;
  }

  static fromJSON(json, onChangeCallback = null) {
    let parsed = json;
    if (typeof json === 'string') {
      try {
        parsed = JSON.parse(json);
      } catch {
        parsed = {};
      }
    }
    return new AparatCookieJar(parsed, onChangeCallback);
  }

  hasValidSession() {
    return Boolean(this.get('AuthV1'));
  }

  /**
   * Redact internal values in inspect/logs.
   */
  [Symbol.for('nodejs.util.inspect.custom')]() {
    return `[AparatCookieJar: ${this._cookies.size} cookies (${Array.from(this._cookies.keys()).join(', ')})]`;
  }

  toString() {
    return `[AparatCookieJar: ${this._cookies.size} cookies]`;
  }
}
