/**
 * System email templates.
 *
 * These are the only messages the platform sends on its own behalf. They are
 * plain, table-based HTML that renders in Outlook and Gmail without a build
 * step, because a password-reset mail that renders badly is a support incident.
 *
 * Every link points at the frontend (`app.url`), never at the API: the frontend
 * reads the token from the URL and posts it to `/api/auth?action=reset`.
 */

import { app } from '../shared/config.js';
import { sanitizeHtml } from '../shared/sanitize.js';
import { formatFrom } from './compose.js';
import { sendEmail } from './resend.js';

/** Display host for the footer, derived from APP_URL so the label can never
 *  disagree with the link beside it. */
function appHost() {
  try {
    return new URL(app.url).host;
  } catch {
    return 'Re-EL Mailer';
  }
}

/** Shared shell: inline styles only, 600px wide, dark-mode friendly. */
function shell({ title, preheader, bodyHtml }) {
  const host = appHost();
  return `<!doctype html>
<html lang="en" dir="ltr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="x-apple-disable-message-reformatting">
<title>${title}</title>
<style>
  body{margin:0;padding:0;background:#F6F8FC;color:#3B424F;
       font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Roboto,Helvetica,Arial,sans-serif;}
  table{border-collapse:collapse;width:100%;}
  .wrap{width:100%;background:#F6F8FC;padding:32px 12px;}
  .card{background:#ffffff;border-radius:14px;border:1px solid #E4E8F0;max-width:600px;margin:0 auto;}
  .hd{padding:28px 32px 8px;}
  .hd h1{margin:0;font-size:20px;line-height:1.3;color:#21396A;font-weight:650;letter-spacing:-0.01em;}
  .bd{padding:8px 32px 28px;font-size:15px;line-height:1.65;}
  .bd p{margin:0 0 14px;}
  .ft{padding:18px 32px 26px;border-top:1px solid #EEF1F6;font-size:12px;color:#7C8698;}
  .ft a{color:#21396A;}
  .btn{display:inline-block;background:#21396A;color:#ffffff !important;text-decoration:none;
       padding:13px 22px;border-radius:10px;font-weight:600;font-size:15px;}
  .code{display:inline-block;background:#F6F8FC;border:1px solid #E4E8F0;border-radius:10px;
        padding:12px 16px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:18px;
        letter-spacing:0.12em;color:#21396A;}
  .muted{color:#7C8698;font-size:13px;}
  @media (prefers-color-scheme:dark){
    body,.wrap{background:#101522 !important;color:#C8CEDA !important;}
    .card{background:#171D2B !important;border-color:#28304A !important;}
    .hd h1{color:#E8ECF4 !important;}
    .ft{border-color:#28304A !important;}
    .ft a{color:#9DB4F0 !important;}
    .code{background:#101522 !important;border-color:#28304A !important;color:#C8D6FF !important;}
    .muted{color:#8A94A8 !important;}
  }
</style>
</head>
<body>
<div style="display:none;font-size:1px;color:#F6F8FC;max-height:0;overflow:hidden;">${preheader}</div>
<table role="presentation" class="wrap"><tr><td align="center">
  <table role="presentation" class="card"><tr><td>
    <div class="hd"><h1>${title}</h1></div>
    <div class="bd">${bodyHtml}</div>
    <div class="ft">
      Sent by Re-EL Mailer. This is an automated message — replies are not monitored.
      <br><a href="${app.url}/">${host}</a>
    </div>
  </td></tr></table>
</td></tr></table>
</body>
</html>`;
}

/** Strip anything that could break out of the HTML body. */
function safe(value) {
  return sanitizeHtml(String(value ?? ''), { mode: 'email' });
}

/** Strip a token down to a user-typable form. */
function prettyToken(token) {
  return String(token).replace(/(.{4})/g, '$1 ').trim();
}

async function send({ to, subject, html, text, from, replyTo }) {
  const result = await sendEmail({
    from: from || `Re-EL Mailer <noreply@re-el.co.za>`,
    to: [to],
    subject,
    html,
    text,
    ...(replyTo ? { reply_to: [replyTo] } : null),
  });
  return result.id;
}

/** Password reset. `token` is the raw token from password_resets.token. */
export async function sendPasswordReset({ to, displayName, token, ttlMinutes = 30 }) {
  // The frontend is a single page with a hash router: there is no
  // reset-password.html, and the reset view is only reachable at #/reset.
  const link = `${app.url}/#/reset?token=${encodeURIComponent(token)}`;
  const name = safe(displayName || 'there');

  return send({
    to,
    subject: 'Reset your Re-EL Mailer password',
    html: shell({
      title: 'Reset your password',
      preheader: 'This link expires in 30 minutes.',
      bodyHtml: `
        <p>Hi ${name},</p>
        <p>Use the button below to choose a new Re-EL Mailer password.
           This link works once and expires in ${ttlMinutes} minutes.</p>
        <p><a class="btn" href="${safe(link)}">Choose a new password</a></p>
        <p class="muted">If the button does not work, copy this address into your browser:<br>
          <span class="code">${safe(link)}</span></p>
        <p class="muted">If you did not ask for a reset, ignore this message —
           your password will not change and no action is needed.</p>`,
    }),
    text: [
      'Reset your Re-EL Mailer password',
      '',
      `Open this link to choose a new password (expires in ${ttlMinutes} minutes):`,
      link,
      '',
      'If you did not ask for a reset, ignore this message.',
    ].join('\n'),
  });
}

/** Welcome mail for a newly provisioned mailbox. */
export async function sendWelcome({ to, displayName, temporaryPassword }) {
  const name = safe(displayName || 'there');
  const link = `${app.url}/#/`;

  return send({
    to,
    subject: 'Your Re-EL Mailer mailbox is ready',
    html: shell({
      title: 'Your mailbox is ready',
      preheader: 'Sign in and set your password.',
      bodyHtml: `
        <p>Hi ${name},</p>
        <p>A Re-EL Mailer mailbox has been created for you.</p>
        ${temporaryPassword ? `<p>Your temporary password is<br><span class="code">${safe(temporaryPassword)}</span><br>
          You will be asked to change it when you first sign in.</p>` : ''}
        <p><a class="btn" href="${safe(link)}">Sign in to Re-EL Mailer</a></p>`,
    }),
    text: [
      'Your Re-EL Mailer mailbox is ready',
      '',
      `Sign in: ${link}`,
      temporaryPassword ? `Temporary password: ${temporaryPassword}` : null,
      '',
      'You will be asked to change your password when you first sign in.',
    ]
      .filter(Boolean)
      .join('\n'),
  });
}

/** Notify an administrator that a mailbox is close to its storage quota. */
export async function sendQuotaWarning({ to, email, usedBytes, quotaBytes, ratio }) {
  const percent = Math.round(ratio * 100);
  return send({
    to,
    subject: `${email} is at ${percent}% of its storage quota`,
    html: shell({
      title: 'Storage quota warning',
      preheader: `${email} has used ${percent}% of its quota.`,
      bodyHtml: `
        <p><strong>${safe(email)}</strong> is using ${percent}% of its storage quota.</p>
        <p class="muted">Used: ${safe(usedBytes)} bytes · Quota: ${safe(quotaBytes)} bytes</p>
        <p>Old messages in Trash and Spam are purged after 30 days, which usually frees
           enough space. Raise the quota from Admin → Mailboxes if this mailbox needs more.</p>`,
    }),
    text: `${email} is at ${percent}% of its storage quota (${usedBytes} / ${quotaBytes} bytes).`,
  });
}

/** Security notice for a suspicious sign-in. */
export async function sendLoginAlert({ to, displayName, ip, userAgent, at }) {
  const name = safe(displayName || 'there');
  return send({
    to,
    subject: 'New sign-in to your Re-EL Mailer account',
    html: shell({
      title: 'New sign-in',
      preheader: 'A new device signed in to your account.',
      bodyHtml: `
        <p>Hi ${name},</p>
        <p>Your Re-EL Mailer account was just used to sign in.</p>
        <p>
          When: ${safe(at)}<br>
          Address: ${safe(ip || 'unknown')}<br>
          Device: ${safe(userAgent || 'unknown')}
        </p>
        <p>If this was not you, change your password immediately and revoke other sessions
           from Account → Sessions.</p>`,
    }),
    text: [
      'New sign-in to your Re-EL Mailer account',
      `When: ${at}`,
      `Address: ${ip || 'unknown'}`,
      `Device: ${userAgent || 'unknown'}`,
      '',
      'If this was not you, change your password and revoke other sessions.',
    ].join('\n'),
  });
}

export { formatFrom, prettyToken };