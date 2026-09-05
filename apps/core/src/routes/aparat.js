import { createRouter } from 'next-connect';
import IntegrationConnectionIntent from '../db/models/core/IntegrationConnectionIntent.js';
import {
  hashState,
  isExpired,
  verifyAparatCredentialsFromTicket,
} from '../publisher/platforms/aparat/connections.js';
import {
  APARAT_CONNECTION_PURPOSE,
  APARAT_CONNECTION_SOURCE,
  APARAT_INTENT_STATUS,
} from '../publisher/platforms/aparat/constants.js';
import { getTelegramClient } from '../publisher/telegram/api.js';
import { notifyTelegramAparatVerified } from '../publisher/telegram/connections.js';

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function renderHtmlLayout({ title, content, isSuccess = false, isError = false }) {
  const accentColor = isError ? '#ef4444' : isSuccess ? '#10b981' : '#ed145b';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)} - ElecIO</title>
  <style>
    :root {
      --bg: #090d16;
      --card-bg: rgba(22, 27, 46, 0.85);
      --border: rgba(255, 255, 255, 0.1);
      --text: #f3f4f6;
      --text-muted: #9ca3af;
      --accent: ${accentColor};
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background-color: var(--bg);
      background-image: radial-gradient(circle at 50% 20%, rgba(237, 20, 91, 0.12), transparent 45%),
                        radial-gradient(circle at 80% 80%, rgba(16, 185, 129, 0.08), transparent 40%);
      color: var(--text);
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 20px;
    }
    .card {
      background: var(--card-bg);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border: 1px solid var(--border);
      border-radius: 20px;
      padding: 36px 32px;
      width: 100%;
      max-width: 420px;
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.5);
      text-align: center;
    }
    .logo-badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 56px;
      height: 56px;
      border-radius: 16px;
      background: rgba(237, 20, 91, 0.15);
      border: 1px solid rgba(237, 20, 91, 0.3);
      color: #ed145b;
      font-size: 26px;
      margin-bottom: 20px;
    }
    h1 {
      font-size: 22px;
      font-weight: 700;
      margin-bottom: 8px;
      letter-spacing: -0.02em;
    }
    p.subtitle {
      font-size: 14px;
      color: var(--text-muted);
      margin-bottom: 28px;
      line-height: 1.5;
    }
    .form-group {
      text-align: left;
      margin-bottom: 18px;
    }
    label {
      display: block;
      font-size: 13px;
      font-weight: 500;
      color: var(--text-muted);
      margin-bottom: 6px;
    }
    input[type="text"], input[type="password"] {
      width: 100%;
      padding: 12px 14px;
      border-radius: 10px;
      border: 1px solid rgba(255, 255, 255, 0.15);
      background: rgba(10, 14, 26, 0.7);
      color: var(--text);
      font-size: 15px;
      outline: none;
      transition: border-color 0.2s, box-shadow 0.2s;
    }
    input[type="text"]:focus, input[type="password"]:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px rgba(237, 20, 91, 0.2);
    }
    .btn {
      width: 100%;
      padding: 14px;
      border-radius: 12px;
      border: none;
      background: linear-gradient(135deg, #ed145b 0%, #ff3b7b 100%);
      color: #fff;
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
      margin-top: 10px;
      transition: opacity 0.2s, transform 0.1s;
    }
    .btn:hover { opacity: 0.95; }
    .btn:active { transform: scale(0.99); }
    .security-notice {
      margin-top: 22px;
      font-size: 12px;
      color: var(--text-muted);
      line-height: 1.4;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
    }
    .error-banner {
      background: rgba(239, 68, 68, 0.15);
      border: 1px solid rgba(239, 68, 68, 0.3);
      color: #fca5a5;
      padding: 12px;
      border-radius: 10px;
      font-size: 13px;
      margin-bottom: 18px;
      text-align: left;
    }
    .success-box {
      padding: 20px;
      border-radius: 12px;
      background: rgba(16, 185, 129, 0.1);
      border: 1px solid rgba(16, 185, 129, 0.25);
      margin-bottom: 20px;
    }
  </style>
</head>
<body>
  <div class="card">
    ${content}
  </div>
</body>
</html>`;
}

export function createAparatRouter({
  telegramClientFactory = getTelegramClient,
  verifyCredentialsFactory = verifyAparatCredentialsFromTicket,
} = {}) {
  const router = createRouter();

  // Support both urlencoded and json bodies without external dependencies
  router.use(async (req, res, next) => {
    if (req.body && Object.keys(req.body).length > 0) return next();
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    const contentType = req.headers?.['content-type'] || '';
    if (typeof req[Symbol.asyncIterator] === 'function' || req.readable) {
      try {
        const chunks = [];
        for await (const chunk of req) {
          chunks.push(chunk);
        }
        const raw = Buffer.concat(chunks).toString('utf8').trim();
        if (raw) {
          if (contentType.includes('application/json')) {
            req.body = JSON.parse(raw);
          } else {
            req.body = Object.fromEntries(new URLSearchParams(raw));
          }
        }
      } catch (parseErr) {
        req.body = {};
      }
    }
    if (!req.body) req.body = {};
    return next();
  });

  // GET /api/aparat/connect?t=<ticket>
  router.get('/connect', async (req, res) => {
    const ticket = req.query?.t || req.query?.ticket;
    if (!ticket) {
      return res.status(400).send(renderHtmlLayout({
        title: 'Invalid Link',
        isError: true,
        content: `
          <div class="logo-badge" style="background: rgba(239, 68, 68, 0.15); color: #ef4444;">⚠️</div>
          <h1>Missing Ticket</h1>
          <p class="subtitle">This link is missing a valid connection ticket. Please request a new link from the Telegram bot.</p>
        `,
      }));
    }

    const hashedTicket = hashState(ticket);
    const intent = await IntegrationConnectionIntent.query()
      .where({ browser_ticket_hash: hashedTicket })
      .withGraphFetched('organization')
      .first();

    if (
      !intent ||
      intent.purpose !== APARAT_CONNECTION_PURPOSE ||
      intent.source !== APARAT_CONNECTION_SOURCE.TELEGRAM ||
      intent.status !== APARAT_INTENT_STATUS.PENDING ||
      isExpired(intent)
    ) {
      return res.status(400).send(renderHtmlLayout({
        title: 'Expired Ticket',
        isError: true,
        content: `
          <div class="logo-badge" style="background: rgba(239, 68, 68, 0.15); color: #ef4444;">⌛</div>
          <h1>Link Expired</h1>
          <p class="subtitle">This authorization link has expired or has already been used. Please return to Telegram and click "Connect Aparat" again.</p>
        `,
      }));
    }

    const orgName = intent.organization?.name || `Organization ${intent.organization_id}`;

    const content = `
      <div class="logo-badge">📺</div>
      <h1>Connect Aparat</h1>
      <p class="subtitle">Enter your Aparat credentials to link your channel to <strong>${escapeHtml(orgName)}</strong>.</p>
      
      <form action="/api/aparat/connect/submit" method="POST">
        <input type="hidden" name="ticket" value="${escapeHtml(ticket)}">
        
        <div class="form-group">
          <label for="username">Aparat Username</label>
          <input type="text" id="username" name="username" placeholder="e.g. elecio" required autocomplete="username" autofocus>
        </div>
        
        <div class="form-group">
          <label for="password">Aparat Password</label>
          <input type="password" id="password" name="password" placeholder="••••••••" required autocomplete="current-password">
        </div>
        
        <button type="submit" class="btn">Connect Aparat</button>
      </form>

      <div class="security-notice">
        <span>🔒</span>
        <span>Credentials are transmitted securely. Passwords are never stored.</span>
      </div>
    `;

    res.setHeader('Cache-Control', 'no-store');
    return res.setHeader('Content-Type', 'text/html; charset=utf-8').send(renderHtmlLayout({
      title: 'Connect Aparat',
      content,
    }));
  });

  // POST /api/aparat/connect/submit
  router.post('/connect/submit', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const { ticket, username, password } = req.body || {};

    if (!ticket) {
      return res.status(400).send(renderHtmlLayout({
        title: 'Invalid Request',
        isError: true,
        content: `
          <h1>Missing Ticket</h1>
          <p class="subtitle">The connection ticket is missing or invalid.</p>
        `,
      }));
    }

    if (!username || !password) {
      return res.status(400).send(renderHtmlLayout({
        title: 'Missing Fields',
        isError: true,
        content: `
          <h1>Incomplete Form</h1>
          <p class="subtitle">Both username and password are required.</p>
          <a href="/api/aparat/connect?t=${encodeURIComponent(ticket)}" class="btn" style="display:inline-block;text-decoration:none;margin-top:10px;">Try Again</a>
        `,
      }));
    }

    // Call verify credentials (discards password immediately)
    const verification = await verifyCredentialsFactory({ ticket, username, password });

    if (!verification.ok) {
      let errorMsg = 'Failed to verify Aparat account. Please check your credentials.';
      if (verification.code === 'APARAT_INVALID_CREDENTIALS') {
        errorMsg = 'Invalid username or password. Please verify your credentials on aparat.com.';
      } else if (verification.code === 'APARAT_INTERACTIVE_AUTH_REQUIRED') {
        errorMsg = 'Aparat requires interactive verification (CAPTCHA, OTP, or 2FA) which cannot be automated. Please sign in directly on aparat.com or try again later.';
      } else if (verification.code === 'APARAT_ACCOUNT_BANNED') {
        errorMsg = 'This Aparat account has been suspended or banned.';
      } else if (verification.code === 'INVALID_OR_EXPIRED_TICKET') {
        errorMsg = 'This connection session has expired. Please get a new link from Telegram.';
      }

      return res.status(400).send(renderHtmlLayout({
        title: 'Connection Failed',
        isError: true,
        content: `
          <div class="logo-badge" style="background: rgba(239, 68, 68, 0.15); color: #ef4444;">❌</div>
          <h1>Verification Failed</h1>
          <div class="error-banner">${escapeHtml(errorMsg)}</div>
          <p class="subtitle">Please return to Telegram and try connecting again.</p>
        `,
      }));
    }

    // Dispatch Telegram notification
    try {
      const telegramClient = telegramClientFactory();
      await notifyTelegramAparatVerified({
        intent: verification.intent,
        profile: verification.profile,
        categories: verification.categories,
        defaultCategory: verification.defaultCategory,
        telegramClient,
      });
    } catch (notifErr) {
      console.warn('[AparatRouter] Telegram notification warning:', notifErr.message);
    }

    const content = `
      <div class="logo-badge" style="background: rgba(16, 185, 129, 0.15); color: #10b981;">✅</div>
      <h1>Aparat Account Verified</h1>
      <div class="success-box">
        <p style="font-size: 15px; font-weight: 600; color: #10b981; margin-bottom: 4px;">@${escapeHtml(verification.profile.username)}</p>
        <p style="font-size: 13px; color: var(--text-muted);">${escapeHtml(verification.profile.name || '')}</p>
      </div>
      <p class="subtitle">Your Aparat channel is verified. Please return to <strong>Telegram</strong> to confirm the connection.</p>
    `;

    return res.setHeader('Content-Type', 'text/html; charset=utf-8').send(renderHtmlLayout({
      title: 'Aparat Account Verified',
      isSuccess: true,
      content,
    }));
  });

  return router;
}

export default createAparatRouter();
