// mailer.js v3 — Themed transactional email system with logo banner.
// Matches the in-app AssetTrack navy/brass theme. All emails share one
// master template (themedTemplate/wrapEmail) so branding stays consistent.
'use strict';
let nodemailer;
try { nodemailer = require('nodemailer'); } catch { nodemailer = null; }

const { getSettings, getLogoPath } = require('./db');
const files = require('./fileStorage');
const fs    = require('fs');

function isConfigured() {
  return !!(nodemailer && process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

let transporter = null;
function getTransporter() {
  if (!isConfigured()) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: Number(process.env.SMTP_PORT || 587) === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      pool: true, maxConnections: 3, maxMessages: 50
    });
  }
  return transporter;
}

// ---------------------------------------------------------------------------
// Logo cache — avoids re-reading the logo file from disk on every single
// email. Invalidated whenever the admin uploads/removes the school logo.
// ---------------------------------------------------------------------------
let _logoCache = undefined; // undefined = not loaded, null = confirmed no logo
async function getLogoAttachment() {
  if (_logoCache !== undefined) return _logoCache;
  try {
    const relPath = await getLogoPath();
    if (relPath && files.exists(relPath)) {
      const mimeByExt = { png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', webp:'image/webp', gif:'image/gif' };
      const extension = relPath.split('.').pop().toLowerCase();
      _logoCache = {
        filename: 'logo', content: fs.readFileSync(files.absolutePath(relPath)),
        cid: 'schoollogo', contentType: mimeByExt[extension] || 'image/png'
      };
    } else {
      _logoCache = null;
    }
  } catch { _logoCache = null; }
  return _logoCache;
}
function invalidateLogoCache() { _logoCache = undefined; }

function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

// ---------------------------------------------------------------------------
// Master themed template — navy gradient header with logo/initials mark,
// white content card, soft footer. Every email in the app renders through
// this so branding is 100% consistent.
// ---------------------------------------------------------------------------
async function wrapEmail({ schoolName, tagline, hasLogo, headerTitle, bodyHtml }) {
  const year = new Date().getFullYear();
  const initials = (schoolName || 'AT').split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
  const logoAtt = hasLogo ? await getLogoAttachment() : null;
  const markHtml = logoAtt
    ? `<div style="width:40px;height:40px;border-radius:10px;background:#ffffff;box-shadow:0 1px 3px rgba(16,24,56,.12);text-align:center;line-height:0;"><img src="cid:schoollogo" width="30" height="30" style="display:inline-block;margin:5px;object-fit:contain;"></div>`
    : `<div style="width:40px;height:40px;border-radius:10px;background:rgba(255,255,255,.14);text-align:center;line-height:40px;font-family:Georgia,'Times New Roman',serif;font-weight:700;font-size:15px;color:#8CC63F;">${escHtml(initials)}</div>`;

  return `
  <div style="background:#EEF2FA;padding:28px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">
    <table role="presentation" width="100%" style="max-width:560px;margin:0 auto;border-collapse:collapse;background:#FFFFFF;border-radius:18px;overflow:hidden;box-shadow:0 12px 32px rgba(12,22,51,.14);">
      <tr>
        <td style="background:linear-gradient(135deg,#1B2F63 0%,#12204A 60%,#0C1633 100%);padding:30px 34px 26px;">
          <table role="presentation" style="border-collapse:collapse;margin-bottom:18px;"><tr>
            <td style="padding-right:10px;vertical-align:middle;">${markHtml}</td>
            <td style="vertical-align:middle;padding-left:10px;font-size:12.5px;color:#9BA6D1;font-weight:600;letter-spacing:.02em;">${escHtml(schoolName || '')}</td>
          </tr></table>
          <div style="font-family:Georgia,'Times New Roman',serif;font-size:23px;font-weight:700;color:#FFFFFF;line-height:1.3;">${escHtml(headerTitle)}</div>
        </td>
      </tr>
      <tr>
        <td style="padding:30px 34px 26px;color:#29304A;font-size:14.5px;line-height:1.7;">
          ${bodyHtml}
        </td>
      </tr>
      <tr>
        <td style="padding:18px 34px 26px;border-top:1px solid #EEF1F8;color:#8A93AC;font-size:11.5px;line-height:1.6;">
          <p style="margin:0 0 8px;">This is an automated message from <strong style="color:#5A6588;">${escHtml(schoolName)}</strong>'s AssetTrack inventory system — this mailbox isn't monitored and replies won't be read. Sign in to your dashboard for full details or to take action.</p>
          <p style="margin:0;">© ${year} ${escHtml(schoolName)}. All rights reserved.</p>
        </td>
      </tr>
    </table>
  </div>`;
}

// Key/value info table used inside notification email bodies
function infoTable(rows) {
  return `<table role="presentation" width="100%" style="border-collapse:collapse;background:#F6F8FD;border-radius:12px;margin:16px 0;">
    ${rows.map(([k, v]) => `<tr>
      <td style="padding:8px 20px 8px 18px;color:#666F8C;font-size:12px;white-space:nowrap;vertical-align:top;">${escHtml(k)}</td>
      <td style="padding:8px 18px 8px 0;font-size:13.5px;font-weight:600;color:#101526;">${escHtml(v == null || v === '' ? '—' : v)}</td>
    </tr>`).join('')}
  </table>`;
}

// ---------------------------------------------------------------------------
// Low-level send
// ---------------------------------------------------------------------------
async function sendMail({ to, subject, html }) {
  if (!to) return { sent: false, reason: 'no-recipient' };
  const t = getTransporter();
  const settings = await getSettings();
  if (!t) {
    console.log(`[mailer] SMTP not configured — would send to: ${to} | Subject: ${subject}`);
    return { sent: false, reason: 'not-configured' };
  }
  try {
    const logoAtt = settings.hasLogo ? await getLogoAttachment() : null;
    const mail = {
      from: process.env.SMTP_FROM || `"${settings.schoolName} AssetTrack" <${process.env.SMTP_USER}>`,
      to, subject, html
    };
    if (logoAtt) mail.attachments = [logoAtt];
    await t.sendMail(mail);
    return { sent: true };
  } catch (err) {
    console.error('[mailer] send failed:', err.message);
    return { sent: false, reason: 'send-error' };
  }
}

// ---------------------------------------------------------------------------
// OTP email — matches reference design
// ---------------------------------------------------------------------------
async function sendOtp({ to, name, otp, schoolName }) {
  const settings = await getSettings();
  const bodyHtml = `
    <p style="margin:0 0 22px;">Hi <strong>${escHtml(name)}</strong>, use the code below to reset your password. It expires in <strong>10 minutes</strong>. If you didn't request this, you can safely ignore this email.</p>
    <table role="presentation" width="100%" style="border-collapse:collapse;background:#F6F8FD;border-radius:14px;">
      <tr><td style="padding:18px 22px;">
        <div style="font-size:12px;color:#666F8C;margin-bottom:4px;">One-time code</div>
        <div style="font-family:'Courier New',monospace;font-size:30px;font-weight:800;letter-spacing:6px;color:#101526;">${escHtml(otp)}</div>
      </td></tr>
    </table>`;
  const html = await wrapEmail({ schoolName: schoolName || settings.schoolName, tagline: settings.tagline, hasLogo: settings.hasLogo, headerTitle: 'Password Reset Code', bodyHtml });
  return sendMail({ to, subject: `${otp} — Password Reset Code`, html });
}

// ---------------------------------------------------------------------------
// New request notification (sent to admins) — transfer / procurement / repair
// ---------------------------------------------------------------------------
async function sendNewRequest({ to, kind, requesterName, rows }) {
  const settings = await getSettings();
  const kindLabel = { transfer: 'Transfer', procurement: 'Procurement', repair: 'Repair' }[kind] || titleCaseLocal(kind);
  const bodyHtml = `<p>${escHtml(requesterName)} submitted a new ${kindLabel.toLowerCase()} request that needs your review.</p>${infoTable(rows)}`;
  const html = await wrapEmail({ schoolName: settings.schoolName, tagline: settings.tagline, hasLogo: settings.hasLogo, headerTitle: `New ${kindLabel} Request`, bodyHtml });
  return sendMail({ to, subject: `New ${kindLabel} request from ${requesterName}`, html });
}

// ---------------------------------------------------------------------------
// Welcome email for new users
// ---------------------------------------------------------------------------
async function sendWelcomeUser({ to, name, tempPassword }) {
  const settings = await getSettings();
  const bodyHtml = `
    <p style="margin:0 0 16px;">Hi <strong>${escHtml(name)}</strong>, an account has been created for you on ${escHtml(settings.schoolName)}'s AssetTrack inventory system.</p>
    ${infoTable([['Email', to], ['Temporary password', tempPassword]])}
    <p style="margin:16px 0 0;color:#666F8C;font-size:13px;">Please sign in and change your password from <strong>My Profile</strong> as soon as possible.</p>`;
  const html = await wrapEmail({ schoolName: settings.schoolName, tagline: settings.tagline, hasLogo: settings.hasLogo, headerTitle: 'Welcome to AssetTrack', bodyHtml });
  return sendMail({ to, subject: `Welcome to ${settings.schoolName} AssetTrack`, html });
}

// ---------------------------------------------------------------------------
// Transfer decision notification
// ---------------------------------------------------------------------------
async function sendTransferDecision({ to, transfer, decision, reviewedBy }) {
  const settings = await getSettings();
  const bodyHtml = `<p>Your transfer request has been <strong>${escHtml(decision)}</strong> by ${escHtml(reviewedBy)}.</p>
    ${infoTable([['Item', transfer.itemName], ['To', transfer.toLocationName], ['Decision', titleCaseLocal(decision)], ['Reviewed by', reviewedBy]])}`;
  const html = await wrapEmail({ schoolName: settings.schoolName, tagline: settings.tagline, hasLogo: settings.hasLogo, headerTitle: `Transfer ${titleCaseLocal(decision)}`, bodyHtml });
  return sendMail({ to, subject: `Transfer ${decision} — ${transfer.itemName}`, html });
}

// ---------------------------------------------------------------------------
// Procurement decision notification
// ---------------------------------------------------------------------------
async function sendProcurementDecision({ to, procurement, decision, reviewedBy }) {
  const settings = await getSettings();
  const bodyHtml = `<p>Your procurement request has been <strong>${escHtml(decision)}</strong> by ${escHtml(reviewedBy)}.</p>
    ${infoTable([['Item', procurement.itemName], ['Quantity', `${procurement.quantity ?? ''} ${procurement.unit || ''}`.trim()], ['Decision', titleCaseLocal(decision)], ['Reviewed by', reviewedBy]])}`;
  const html = await wrapEmail({ schoolName: settings.schoolName, tagline: settings.tagline, hasLogo: settings.hasLogo, headerTitle: `Procurement ${titleCaseLocal(decision)}`, bodyHtml });
  return sendMail({ to, subject: `Procurement ${decision} — ${procurement.itemName}`, html });
}

// ---------------------------------------------------------------------------
// Stocking plan created notification
// ---------------------------------------------------------------------------
async function sendPlanCreated({ plan, createdBy, schoolName }) {
  const settings = await getSettings();
  const bodyHtml = `<p>A new ${escHtml(plan.planType)} stocking plan has been created by ${escHtml(createdBy.name)}.</p>
    ${infoTable([['Title', plan.title], ['Type', titleCaseLocal(plan.planType)], ['Budget', plan.budget != null ? `Rs. ${Number(plan.budget).toLocaleString()}` : '—'], ['Department', plan.departmentName || 'All departments']])}`;
  const html = await wrapEmail({ schoolName: schoolName || settings.schoolName, tagline: settings.tagline, hasLogo: settings.hasLogo, headerTitle: 'Stocking Plan Created', bodyHtml });
  const admins = []; // caller decides recipients; kept for API symmetry
  return html;
}

function titleCaseLocal(s) {
  return String(s || '—').split('_').map(w => w ? w[0].toUpperCase() + w.slice(1) : w).join(' ');
}

function wantsMail(user) {
  return !!(user && user.email && user.status === 'active' && user.emailNotifications !== false);
}

module.exports = {
  sendMail, sendOtp, sendNewRequest, sendWelcomeUser, sendTransferDecision,
  sendProcurementDecision, sendPlanCreated, wrapEmail, infoTable,
  wantsMail, isConfigured, invalidateLogoCache
};
