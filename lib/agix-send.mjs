// agix-send — branded email via Gmail SMTP, callable as a library.
//
// Used by:
//   - bin/agix-send (thin CLI shim)
//   - agents/* via runtime.sendEmail(...)
//
// SMTP credentials come from ~/.config/agix/smtp.env (single-tenant) — Phase 3
// of the runtime architecture will route this through tenant-scoped secrets.

import { readFile, writeFile } from 'node:fs/promises';
import { operatorFullName } from './agix-identity.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, basename, dirname } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import nodemailer from 'nodemailer';
// NOTE: `puppeteer-core` is a LAZY (dynamic) import — it is heavy (~30MB) and is
// only used to render the optional email-signature PNG. It is declared as an
// OPTIONAL dependency and is NOT bundled in the lean public pack. Importing it
// at module top-level would drag it into every CLI startup (the runtime imports
// this module for `sendEmail`/`loadEnv`, neither of which needs a browser). So
// it is imported inside `renderSignatureToPng()`, with a clear error if absent.

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Send a branded email through the configured Workspace SMTP account.
 *
 * @param {object} options
 * @param {string[]|string} options.to        Recipient(s). Required unless toSelf.
 * @param {boolean} [options.toSelf]          Send to the configured From address.
 * @param {string[]|string} [options.cc]      CC recipient(s).
 * @param {string} options.subject            Email subject. Required.
 * @param {string} options.body               Email body. Plain text or HTML (see html flag).
 * @param {string[]} [options.attach]         Absolute paths to attach.
 * @param {string} [options.from]             Override From address (default operator@example.com).
 * @param {boolean} [options.html]            Body is already HTML; do not wrap.
 * @param {boolean} [options.signature=true]  Append the Agix signature card.
 * @param {boolean} [options.dryRun]          Print intent; don't actually send.
 * @returns {Promise<{messageId: string, accepted: string[], rejected: string[]}>}
 */
export async function sendEmail(options = {}) {
  const opts = normalizeOptions(options);

  const smtpEnv = loadEnv(resolve(homedir(), '.config/agix/smtp.env'), true);
  const sigEnv = loadEnv(resolve(homedir(), '.config/agix/signature.env'), false);

  const smtpUser = smtpEnv.SMTP_USER || opts.from;
  const smtpPass = smtpEnv.SMTP_APP_PASSWORD;
  if (!smtpPass) {
    throw new Error(
      'SMTP_APP_PASSWORD not set in ~/.config/agix/smtp.env. ' +
      'See docs/operations/email-setup.md.'
    );
  }

  // SMTP host/port come from config — NO email provider is baked into the pack (generic AOS).
  const smtpHost = smtpEnv.SMTP_HOST;
  if (!smtpHost) {
    throw new Error(
      'SMTP_HOST not set in ~/.config/agix/smtp.env (e.g. SMTP_HOST=smtp.your-provider.com). ' +
      'See docs/operations/email-setup.md.'
    );
  }
  const smtpPort = Number(smtpEnv.SMTP_PORT) || 587;   // 587 = standard STARTTLS submission (provider-neutral)
  const smtpSecure = smtpEnv.SMTP_SECURE === 'true';   // false → STARTTLS on 587; true → implicit TLS on 465

  // All signature fields come from ~/.config/agix/signature.env (set per instance).
  // Generic fallbacks ONLY — never the author's real entity/address/domain.
  const sig = {
    from_name: sigEnv.FROM_NAME || operatorFullName(),
    from_title: sigEnv.FROM_TITLE || '',
    from_email: smtpUser,
    from_domain: sigEnv.FROM_DOMAIN || 'example.com',
    legal_entity: sigEnv.LEGAL_ENTITY || '',
    legal_address: sigEnv.LEGAL_ADDRESS || '',
  };

  const bodyHtml = opts.html ? opts.body : plainToHtml(opts.body);
  const sigText = opts.signature ? buildSignatureText(sig) : '';
  const sigImagePath = opts.signature ? await renderSignatureToPng(sig) : null;

  const sigHtml = opts.signature
    ? `<div style="margin-top: 28px;">
         <img src="cid:agix-signature" alt="${escapeHtml(sig.from_name)} — ${escapeHtml(sig.from_title)}" style="display: block; width: 260px; max-width: 100%; height: auto; border: 0;">
         <div style="font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 10px; line-height: 1.5; color: #888a92; margin-top: 6px; width: 260px; max-width: 100%;">
           <a href="mailto:${escapeHtml(sig.from_email)}" style="color: #888a92; text-decoration: underline;">${escapeHtml(sig.from_email)}</a>
           &nbsp;&middot;&nbsp;
           <a href="https://${escapeHtml(sig.from_domain)}" style="color: #888a92; text-decoration: underline;">${escapeHtml(sig.from_domain)}</a>
         </div>
       </div>`
    : '';

  const htmlBody = wrapHtml(bodyHtml + sigHtml);
  const textBody = opts.html
    ? htmlToText(opts.body) + (sigText ? '\n\n' + sigText : '')
    : opts.body + (sigText ? '\n\n' + sigText : '');

  const attachments = [];
  for (const p of opts.attach) {
    const fullPath = resolve(p);
    if (!existsSync(fullPath)) {
      throw new Error(`Attachment not found: ${p}`);
    }
    attachments.push({ filename: basename(fullPath), path: fullPath });
  }
  if (sigImagePath) {
    attachments.push({ filename: 'agix-signature.png', path: sigImagePath, cid: 'agix-signature' });
  }

  const fromHeader = `${sig.from_name} <${opts.from}>`;

  const message = {
    from: fromHeader,
    to: opts.to.join(', '),
    cc: opts.cc.length ? opts.cc.join(', ') : undefined,
    subject: opts.subject,
    html: htmlBody,
    text: textBody,
    attachments,
  };

  if (opts.dryRun) {
    return {
      dryRun: true,
      from: message.from,
      to: message.to,
      cc: message.cc,
      subject: message.subject,
      htmlBytes: htmlBody.length,
      textBytes: textBody.length,
      signature: opts.signature,
      attachments: attachments.map(a => ({ filename: a.filename, cid: a.cid || null })),
    };
  }

  const transporter = nodemailer.createTransport({
    host: smtpHost,
    port: smtpPort,
    secure: smtpSecure,
    auth: { user: smtpUser, pass: smtpPass.replace(/\s+/g, '') },
  });

  try {
    const info = await transporter.sendMail(message);
    return {
      messageId: info.messageId,
      accepted: info.accepted || [],
      rejected: info.rejected || [],
    };
  } catch (err) {
    if (err.code === 'EAUTH') {
      throw new Error(
        'SMTP auth failed. Verify SMTP_APP_PASSWORD is current and 2-Step Verification is enabled. ' +
        `Underlying: ${err.message}`
      );
    }
    throw new Error(`SMTP send failed: ${err.message}`);
  }
}

// ─── Option normalization ────────────────────────────────────────────

function normalizeOptions(input) {
  const opts = {
    to: [],
    cc: [],
    attach: [],
    from: input.from || 'operator@example.com',
    subject: input.subject,
    body: input.body || '',
    html: Boolean(input.html),
    signature: input.signature !== false,
    dryRun: Boolean(input.dryRun),
  };

  if (input.to) {
    const arr = Array.isArray(input.to) ? input.to : [input.to];
    for (const v of arr) opts.to.push(...String(v).split(',').map(s => s.trim()).filter(Boolean));
  }
  if (input.toSelf) opts.to.push(opts.from);
  if (input.cc) {
    const arr = Array.isArray(input.cc) ? input.cc : [input.cc];
    for (const v of arr) opts.cc.push(...String(v).split(',').map(s => s.trim()).filter(Boolean));
  }
  if (input.attach) {
    const arr = Array.isArray(input.attach) ? input.attach : [input.attach];
    for (const v of arr) opts.attach.push(v);
  }

  if (!opts.to.length) throw new Error('sendEmail: at least one recipient required (to or toSelf).');
  if (!opts.subject) throw new Error('sendEmail: subject required.');
  return opts;
}

// ─── Helpers (verbatim from former bin/agix-send) ────────────────────

export function loadEnv(path, required) {
  if (!existsSync(path)) {
    if (required) {
      throw new Error(
        `Missing config at ${path}. See docs/operations/email-setup.md.`
      );
    }
    return {};
  }
  const env = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line || line.trim().startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
  }
  return env;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function plainToHtml(text) {
  return escapeHtml(text)
    .split(/\n{2,}/)
    .map(p => `<p style="margin: 0 0 14px 0;">${p.replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

function htmlToText(html) {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&middot;/g, '·')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function wrapHtml(inner) {
  return `<!doctype html><html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body style="margin:0; padding:0;">
<div style="font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size:14px; line-height:1.6; max-width:640px; padding:0;">
${inner}
</div></body></html>`;
}

function buildSignatureMarkup(s, lockupSrc) {
  const tpl = readFileSync(resolve(repoRoot, 'scripts/templates/email-signature.html'), 'utf8');
  return tpl
    .replace(/{{lockup_src}}/g, lockupSrc || '')
    .replace(/{{from_name}}/g, escapeHtml(s.from_name))
    .replace(/{{from_title}}/g, escapeHtml(s.from_title))
    .replace(/{{from_email}}/g, escapeHtml(s.from_email))
    .replace(/{{from_domain}}/g, escapeHtml(s.from_domain))
    .replace(/{{legal_entity}}/g, escapeHtml(s.legal_entity))
    .replace(/{{legal_address}}/g, escapeHtml(s.legal_address));
}

async function renderSignatureToPng(s) {
  const lockupPath = resolve(repoRoot, 'apps/website/public/brand/logo-lockup-horizontal-tight-navy@2x.png');
  const lockupSrc = 'file://' + lockupPath;
  const sigMarkup = buildSignatureMarkup(s, lockupSrc);
  const html = `<!doctype html><html><head><meta charset="utf-8"><link rel="preconnect" href="https://rsms.me/"><link rel="stylesheet" href="https://rsms.me/inter/inter.css"><style>html,body{margin:0;padding:0;background:transparent;}</style></head><body>${sigMarkup}</body></html>`;

  const tmpHtml = resolve(tmpdir(), `agix-signature-${Date.now()}.html`);
  const tmpPng = resolve(tmpdir(), `agix-signature-${Date.now()}.png`);
  await writeFile(tmpHtml, html);

  const chromeCandidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ];
  let exePath = null;
  for (const p of chromeCandidates) {
    try { await readFile(p); exePath = p; break; } catch {}
  }
  if (!exePath) {
    console.warn('No Chrome found — signature image cannot be rendered, falling back to no signature.');
    return null;
  }

  // Lazy-load the optional puppeteer-core dep. Clear error (not a raw
  // module-not-found stack) when the lean pack omitted it — the email
  // still sends, just without the rendered signature PNG.
  let puppeteer;
  try {
    ({ default: puppeteer } = await import('puppeteer-core'));
  } catch {
    console.warn(
      'Email signature rendering needs the optional "puppeteer-core" package, which is ' +
      'not bundled in the lean Agix pack. Install it to enable rendered signatures:\n' +
      '  npm i -g puppeteer-core\n' +
      'Sending without a rendered signature image.'
    );
    return null;
  }

  const browser = await puppeteer.launch({ executablePath: exePath, headless: 'new', args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 600, height: 400, deviceScaleFactor: 2 });
    await page.goto('file://' + tmpHtml, { waitUntil: 'networkidle0', timeout: 15000 });
    await page.evaluate(() => new Promise(async (r) => {
      try { if (document.fonts && document.fonts.ready) await document.fonts.ready; } catch {}
      requestAnimationFrame(() => requestAnimationFrame(r));
    }));
    const el = await page.$('table');
    if (!el) throw new Error('Signature table not found in rendered page');
    await el.screenshot({ path: tmpPng, omitBackground: true });
  } finally {
    await browser.close();
  }
  return tmpPng;
}

function buildSignatureText(s) {
  return `--
${s.from_name}
${s.from_title}
${s.from_email} · ${s.from_domain}
${s.legal_entity} · ${s.legal_address}`;
}
