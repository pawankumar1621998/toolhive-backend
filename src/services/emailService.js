'use strict';

/**
 * Email Service — NodeMailer-based transactional email sender.
 *
 * All emails sent by the application go through this service.
 */

const nodemailer = require('nodemailer');
const logger = require('../utils/logger');

// ─── Transporter ─────────────────────────────────────────────────────────────

let transporter = null;

function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host:   process.env.EMAIL_HOST || 'smtp.gmail.com',
      port:   parseInt(process.env.EMAIL_PORT || '587', 10),
      secure: process.env.EMAIL_PORT === '465',
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
    });
  }
  return transporter;
}

// ─── Base sender ─────────────────────────────────────────────────────────────

/**
 * Send an email.
 * @param {object} options - { to, subject, html, text }
 */
async function sendEmail({ to, subject, html, text }) {
  try {
    const info = await getTransporter().sendMail({
      from:    `"ToolHive" <${process.env.EMAIL_USER}>`,
      to,
      subject,
      html,
      text: text || html.replace(/<[^>]+>/g, ''), // Strip HTML for plain-text fallback
    });
    logger.info('Email sent', { to, subject, messageId: info.messageId });
    return info;
  } catch (err) {
    logger.error('Email send failed', { to, subject, error: err.message });
    throw err;
  }
}

// ─── Email templates ─────────────────────────────────────────────────────────

const BASE_STYLE = `
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  background: #f9fafb; margin: 0; padding: 0;
`;

const CARD_STYLE = `
  max-width: 520px; margin: 40px auto; background: #ffffff;
  border-radius: 16px; overflow: hidden; box-shadow: 0 4px 24px rgba(0,0,0,0.08);
`;

const BTN_STYLE = `
  display: inline-block; padding: 14px 32px; background: linear-gradient(135deg,#7c3aed,#06b6d4);
  color: #ffffff; text-decoration: none; border-radius: 10px;
  font-weight: 600; font-size: 15px; margin: 20px 0;
`;

function baseTemplate(content, title = 'ToolHive') {
  return `
    <!DOCTYPE html><html><head><meta charset="UTF-8"><title>${title}</title></head>
    <body style="${BASE_STYLE}">
      <div style="${CARD_STYLE}">
        <div style="background:linear-gradient(135deg,#7c3aed,#06b6d4);padding:28px 32px;text-align:center;">
          <h1 style="margin:0;color:#fff;font-size:22px;font-weight:700;">⚡ ToolHive</h1>
          <p style="margin:6px 0 0;color:rgba(255,255,255,0.8);font-size:13px;">Powerful tools, smarter work</p>
        </div>
        <div style="padding:32px;">${content}</div>
        <div style="background:#f3f4f6;padding:16px 32px;text-align:center;font-size:12px;color:#9ca3af;">
          &copy; ${new Date().getFullYear()} ToolHive by Pawan Kumar &bull;
          <a href="${process.env.FRONTEND_URL}/privacy" style="color:#7c3aed;">Privacy</a>
        </div>
      </div>
    </body></html>
  `;
}

// ─── Transactional emails ────────────────────────────────────────────────────

const emailService = {

  /** Welcome email after signup */
  sendWelcome: (user) => sendEmail({
    to:      user.email,
    subject: 'Welcome to ToolHive!',
    html:    baseTemplate(`
      <h2 style="margin:0 0 8px;color:#111827;">Hey ${user.name}, welcome aboard!</h2>
      <p style="color:#6b7280;line-height:1.6;">
        Your ToolHive account is ready. You now have access to 70+ free AI-powered tools
        for PDF, images, video, writing, and more — no account needed for most tools.
      </p>
      <a href="${process.env.FRONTEND_URL}/tools" style="${BTN_STYLE}">Explore Tools</a>
      <p style="color:#9ca3af;font-size:13px;">
        Your account: <strong>${user.email}</strong> &bull; Plan: <strong>Free</strong>
      </p>
    `, 'Welcome to ToolHive'),
  }),

  /** Email verification */
  sendVerificationEmail: (user, token) => sendEmail({
    to:      user.email,
    subject: 'Verify your ToolHive email',
    html:    baseTemplate(`
      <h2 style="margin:0 0 8px;color:#111827;">Verify your email</h2>
      <p style="color:#6b7280;line-height:1.6;">
        Click the button below to verify your email address. This link expires in <strong>24 hours</strong>.
      </p>
      <a href="${process.env.FRONTEND_URL}/verify-email?token=${token}" style="${BTN_STYLE}">
        Verify Email Address
      </a>
      <p style="color:#9ca3af;font-size:12px;">If you didn't create an account, ignore this email.</p>
    `, 'Verify Email'),
  }),

  /** Password reset */
  sendPasswordReset: (user, token) => sendEmail({
    to:      user.email,
    subject: 'Reset your ToolHive password',
    html:    baseTemplate(`
      <h2 style="margin:0 0 8px;color:#111827;">Reset your password</h2>
      <p style="color:#6b7280;line-height:1.6;">
        We received a request to reset your password. Click below — this link expires in <strong>1 hour</strong>.
      </p>
      <a href="${process.env.FRONTEND_URL}/reset-password?token=${token}" style="${BTN_STYLE}">
        Reset Password
      </a>
      <p style="color:#9ca3af;font-size:12px;">If you didn't request this, your account is safe — just ignore this email.</p>
    `, 'Reset Password'),
  }),

  /** Job/processing complete notification */
  sendJobComplete: (user, job) => sendEmail({
    to:      user.email,
    subject: `Your ${job.tool} is ready — ToolHive`,
    html:    baseTemplate(`
      <h2 style="margin:0 0 8px;color:#111827;">Your file is ready! 🎉</h2>
      <p style="color:#6b7280;line-height:1.6;">
        Your <strong>${job.tool}</strong> job completed successfully.
        The processed file is ready to download from your dashboard.
      </p>
      <a href="${process.env.FRONTEND_URL}/dashboard/history" style="${BTN_STYLE}">
        View & Download
      </a>
      <p style="color:#9ca3af;font-size:12px;">Files are available for <strong>1 hour</strong> after processing.</p>
    `, 'File Ready'),
  }),

  /** Subscription activated */
  sendSubscriptionConfirmation: (user, subscription, payment) => sendEmail({
    to:      user.email,
    subject: `ToolHive ${subscription.plan} plan activated!`,
    html:    baseTemplate(`
      <h2 style="margin:0 0 8px;color:#111827;">Subscription activated ✅</h2>
      <p style="color:#6b7280;line-height:1.6;">
        Your <strong>${subscription.plan.charAt(0).toUpperCase() + subscription.plan.slice(1)}</strong> plan
        is now active. Enjoy unlimited access to all premium tools!
      </p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:14px;">
        <tr><td style="padding:8px;color:#6b7280;">Plan</td><td style="padding:8px;font-weight:600;text-transform:capitalize;">${subscription.plan}</td></tr>
        <tr style="background:#f9fafb;"><td style="padding:8px;color:#6b7280;">Valid until</td><td style="padding:8px;font-weight:600;">${new Date(subscription.endDate).toLocaleDateString()}</td></tr>
        <tr><td style="padding:8px;color:#6b7280;">Amount paid</td><td style="padding:8px;font-weight:600;">₹${(payment.amount / 100).toFixed(2)}</td></tr>
      </table>
      <a href="${process.env.FRONTEND_URL}/dashboard" style="${BTN_STYLE}">Go to Dashboard</a>
    `, 'Subscription Confirmed'),
  }),

  /** Subscription expiry warning (3 days before) */
  sendExpiryWarning: (user, subscription) => sendEmail({
    to:      user.email,
    subject: 'Your ToolHive subscription expires soon',
    html:    baseTemplate(`
      <h2 style="margin:0 0 8px;color:#111827;">Subscription expiring soon ⏰</h2>
      <p style="color:#6b7280;line-height:1.6;">
        Your <strong>${subscription.plan}</strong> plan expires on
        <strong>${new Date(subscription.endDate).toLocaleDateString()}</strong>.
        Renew now to keep uninterrupted access.
      </p>
      <a href="${process.env.FRONTEND_URL}/pricing" style="${BTN_STYLE}">Renew Subscription</a>
    `, 'Subscription Expiring'),
  }),
};

module.exports = emailService;
