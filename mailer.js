// ============================================================
// mailer.js — Production Email Delivery Engine for VocaMate
//
// Sends real email messages for:
// 1. Registration OTP Verification (when any user signs up)
// 2. Password Reset OTPs (when user requests "Forgot Password")
// 3. Login Security Alerts (when any user logs in)
//
// Supports:
// - Nodemailer SMTP & Gmail (Zero domain restrictions, delivers to ANY recipient)
// - Resend HTTP API (via RESEND_API_KEY)
// - Dynamic Admin Configuration via vocamate-email-config.json
// - Local & Admin Email Delivery Logging (vocamate-emails-log.json)
// ============================================================
const fs = require('fs');
const path = require('path');
const activity = require('./activity');

const CONFIG_FILE = path.join(__dirname, 'vocamate-email-config.json');
let nodemailer = null;
let smtpTransporter = null;

try {
  nodemailer = require('nodemailer');
} catch (e) {
  // Nodemailer transport not installed
}

function loadEmailConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
      return JSON.parse(raw);
    }
  } catch (e) {
    console.error('Error loading email config:', e.message);
  }
  return {};
}

function initTransporters() {
  if (!nodemailer) return;
  const cfg = loadEmailConfig();

  const smtpHost = cfg.smtpHost || process.env.SMTP_HOST || process.env.EMAIL_HOST;
  const smtpUser = cfg.smtpUser || process.env.SMTP_USER || process.env.EMAIL_USER;
  const smtpPass = cfg.smtpPass || process.env.SMTP_PASS || process.env.EMAIL_PASS;
  const smtpPort = parseInt(cfg.smtpPort || process.env.SMTP_PORT || process.env.EMAIL_PORT || '587', 10);
  const smtpSecure = cfg.smtpSecure === true || process.env.SMTP_SECURE === 'true' || smtpPort === 465;

  const gmailUser = cfg.gmailUser || process.env.GMAIL_USER;
  const gmailPass = cfg.gmailAppPassword || process.env.GMAIL_APP_PASSWORD;

  if (smtpHost && smtpUser && smtpPass) {
    smtpTransporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpSecure,
      auth: { user: smtpUser, pass: smtpPass }
    });
    console.log(`📧 SMTP Transporter initialized (${smtpHost}:${smtpPort} as ${smtpUser})`);
  } else if (gmailUser && gmailPass) {
    smtpTransporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: gmailUser,
        pass: gmailPass
      }
    });
    console.log(`📧 Gmail SMTP Transporter initialized (${gmailUser})`);
  } else {
    smtpTransporter = null;
  }
}

initTransporters();

const EMAIL_LOG_FILE = path.join(__dirname, 'vocamate-emails-log.json');
const TMP_FILE = EMAIL_LOG_FILE + '.tmp';
const MAX_LOGS = 1000;

let emailLogs = [];
let nextEmailId = 1;

function loadLogs() {
  try {
    if (fs.existsSync(EMAIL_LOG_FILE)) {
      const raw = fs.readFileSync(EMAIL_LOG_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      emailLogs = Array.isArray(parsed.logs) ? parsed.logs : [];
      nextEmailId = parsed.nextEmailId || (emailLogs.length + 1);
    } else {
      emailLogs = [];
      nextEmailId = 1;
    }
  } catch (e) {
    console.error('Email log load error:', e.message);
    emailLogs = [];
  }
}

let saveScheduled = false;
function scheduleSave() {
  if (saveScheduled) return;
  saveScheduled = true;
  setTimeout(() => {
    saveScheduled = false;
    try {
      const payload = JSON.stringify({ logs: emailLogs, nextEmailId }, null, 2);
      fs.writeFileSync(TMP_FILE, payload, 'utf8');
      fs.renameSync(TMP_FILE, EMAIL_LOG_FILE);
    } catch (e) {
      console.error('Email log save error:', e.message);
    }
  }, 100);
}

loadLogs();

function getSenderAddress() {
  const cfg = loadEmailConfig();
  if (cfg.fromEmail && cfg.fromEmail.trim() && !cfg.fromEmail.includes('yourdomain.com')) {
    return cfg.fromEmail.trim();
  }
  const envFrom = (process.env.EMAIL_FROM || '').trim();
  if (envFrom && !envFrom.includes('yourdomain.com') && !envFrom.includes('example.com')) {
    return envFrom;
  }
  const smtpUser = cfg.smtpUser || cfg.gmailUser || process.env.SMTP_USER || process.env.GMAIL_USER;
  if (smtpUser) {
    return `VocaMate <${smtpUser}>`;
  }
  return 'VocaMate <onboarding@resend.dev>';
}

function getResendApiKey() {
  const cfg = loadEmailConfig();
  return (cfg.resendApiKey || process.env.RESEND_API_KEY || '').trim();
}

/**
 * Core sendEmail dispatcher
 */
async function sendEmail({ to, subject, html, text, type = 'general', metadata = {} }) {
  const emailId = `mail_${Date.now()}_${nextEmailId++}`;
  const timestamp = new Date().toISOString();
  const from = getSenderAddress();
  const resendApiKey = getResendApiKey();

  const logEntry = {
    id: emailId,
    timestamp,
    to,
    from,
    subject,
    type,
    status: 'pending',
    provider: smtpTransporter ? 'smtp' : (resendApiKey ? 'resend' : 'console_fallback'),
    error: null,
    metadata
  };

  emailLogs.unshift(logEntry);
  if (emailLogs.length > MAX_LOGS) {
    emailLogs.splice(MAX_LOGS);
  }
  scheduleSave();

  // 1) Try SMTP first if configured (works for ANY recipient address)
  if (smtpTransporter) {
    try {
      const info = await smtpTransporter.sendMail({
        from,
        to,
        subject,
        html,
        text: text || undefined
      });
      console.log(`✅ [SMTP EMAIL SENT] to: ${to} | ID: ${info.messageId} | "${subject}"`);
      logEntry.status = 'sent';
      logEntry.provider = 'smtp';
      logEntry.smtpId = info.messageId;
      scheduleSave();
      return { ok: true, delivered: true, id: emailId, provider: 'smtp', otp: metadata.otp };
    } catch (smtpErr) {
      console.warn(`⚠️ [SMTP SEND ERROR] to: ${to}:`, smtpErr.message);
      logEntry.error = 'SMTP: ' + smtpErr.message;
      // Fall through to Resend if available
    }
  }

  // 2) Try Resend API if configured
  if (resendApiKey) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);

      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Authorization': `Bearer ${resendApiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from,
          to,
          subject,
          html,
          text: text || undefined
        })
      });
      clearTimeout(timeoutId);

      const resBody = await res.json().catch(() => ({}));

      if (res.ok) {
        console.log(`✅ [RESEND EMAIL SENT] ID: ${resBody.id} to: ${to} | "${subject}"`);
        logEntry.status = 'sent';
        logEntry.provider = 'resend';
        logEntry.resendId = resBody.id;
        scheduleSave();
        return { ok: true, delivered: true, id: emailId, provider: 'resend', resendId: resBody.id, otp: metadata.otp };
      } else {
        const errMsg = resBody.message || resBody.name || res.statusText || ('Resend HTTP ' + res.status);
        const isSandboxRestriction = res.status === 403 || String(errMsg).toLowerCase().includes('testing emails to your own email address') || String(errMsg).toLowerCase().includes('verify a domain');
        console.warn(`⚠️ [RESEND NOTICE ${res.status}] to: ${to}:`, errMsg);

        logEntry.status = isSandboxRestriction ? 'sandbox_restricted' : 'send_failed';
        logEntry.error = errMsg;
        logEntry.sandboxRestricted = isSandboxRestriction;
        scheduleSave();

        // If Resend failed because of sandbox restrictions (recipient is not owner)
        // Relay a notification copy to the Resend account owner so the OTP is never lost
        const ownerEmail = 'chandrashekharbansal.2006@gmail.com';
        if (isSandboxRestriction && to.toLowerCase() !== ownerEmail.toLowerCase()) {
          try {
            console.log(`📨 [RESEND SANDBOX RELAY] Sending OTP notification copy to owner ${ownerEmail} for user ${to}...`);
            await fetch('https://api.resend.com/emails', {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${resendApiKey}`,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                from: 'VocaMate <onboarding@resend.dev>',
                to: ownerEmail,
                subject: `⚠️ [Resend Sandbox Relay] OTP for ${to}: ${metadata.otp || 'Action Required'}`,
                html: `
                  <div style="font-family:sans-serif; padding:20px; background:#0f172a; color:#f8fafc; border-radius:12px;">
                    <h3 style="color:#38bdf8; margin-top:0;">🗣️ VocaMate Email Gateway Sandbox Notice</h3>
                    <p>A user just initiated an action with email: <strong style="color:#ffffff;">${to}</strong></p>
                    <div style="background:rgba(245,158,11,0.15); border:1px solid #f59e0b; padding:14px; border-radius:8px; margin:16px 0;">
                      <p style="margin:0 0 8px 0; color:#fbbf24; font-weight:700;">⚠️ Why this email went to your inbox instead of ${to}:</p>
                      <p style="margin:0; font-size:13px; color:#cbd5e1; line-height:1.5;">Your Resend account is currently in <strong>free Sandbox mode</strong> without a verified domain. Resend strictly delivers only to your registered account address (${ownerEmail}).</p>
                    </div>
                    <div style="background:rgba(56,189,248,0.1); border:2px dashed #38bdf8; border-radius:10px; padding:16px; text-align:center; margin:18px 0;">
                      <div style="font-size:12px; color:#94a3b8; text-transform:uppercase;">6-Digit OTP Code for ${to}</div>
                      <div style="font-size:32px; font-weight:900; color:#38bdf8; letter-spacing:6px; font-family:monospace; margin-top:6px;">${metadata.otp || 'N/A'}</div>
                    </div>
                    <p style="font-size:13px; color:#94a3b8; line-height:1.5;">👉 <strong>How to send directly to ANY email:</strong> Open VocaMate Admin 🛡️ &rarr; 📧 Email Gateway, and enter your Gmail & Google App Password! (100% free, 0 domain required).</p>
                  </div>
                `
              })
            });
            console.log(`✅ [RESEND SANDBOX RELAY DISPATCHED] Owner ${ownerEmail} notified of OTP for ${to}`);
          } catch (relayErr) {
            console.warn('⚠️ [RESEND SANDBOX RELAY FAILED]:', relayErr.message);
          }
        }

        return {
          ok: false,
          delivered: false,
          sandboxRestricted: isSandboxRestriction,
          error: errMsg,
          id: emailId
        };
      }
    } catch (err) {
      const isTimeout = err.name === 'AbortError';
      const errMsg = isTimeout ? 'Email service timeout (8s)' : err.message;
      console.error('Email send exception:', errMsg);
      logEntry.status = 'error';
      logEntry.error = errMsg;
      scheduleSave();
      return { ok: false, delivered: false, error: errMsg, id: emailId };
    }
  }

  // 3) Local / Console fallback (offline / testing mode)
  console.log(`\n📧 [EMAIL NOTIFICATION] to: ${to} | subject: "${subject}"`);
  if (metadata.otp) {
    console.log(`    🔢 OTP Code: ${metadata.otp}`);
  }
  if (metadata.resetUrl || metadata.verifyUrl) {
    console.log(`    🔗 Action Link: ${metadata.resetUrl || metadata.verifyUrl}`);
  }
  logEntry.status = 'delivered_local';
  logEntry.provider = 'console_fallback';
  scheduleSave();
  return { ok: true, delivered: false, localFallback: true, id: emailId };
}

/**
 * 1. Login Security Alert Notification
 * Sent whenever a user logs in
 */
async function sendLoginAlertEmail({ user, ip, userAgent }) {
  if (!user || !user.email) return;

  const now = new Date();
  const timeFormatted = now.toLocaleDateString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: true,
    timeZone: 'Asia/Kolkata'
  }) + ' IST';

  const appUrl = process.env.APP_URL || 'http://localhost:3000';
  const resetLink = `${appUrl}/reset-password.html`;
  const subject = `🛡️ Security Alert: New Sign-in to your VocaMate Account`;

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #070b14; color: #f8fafc; margin: 0; padding: 24px; }
    .container { max-width: 540px; margin: 0 auto; background: #0e1526; border: 1px solid rgba(255,255,255,0.1); border-radius: 16px; padding: 28px; box-shadow: 0 12px 36px rgba(0,0,0,0.5); }
    .header { display: flex; align-items: center; gap: 8px; margin-bottom: 20px; border-bottom: 1px solid rgba(255,255,255,0.08); padding-bottom: 16px; }
    .title { font-size: 22px; font-weight: 800; color: #38bdf8; margin: 0; }
    .badge { background: rgba(56,189,248,0.15); color: #38bdf8; border: 1px solid rgba(56,189,248,0.3); padding: 3px 10px; border-radius: 20px; font-size: 11px; font-weight: 700; }
    .greeting { font-size: 16px; font-weight: 600; color: #ffffff; margin-bottom: 12px; }
    .text { font-size: 14px; line-height: 1.6; color: #94a3b8; margin-bottom: 18px; }
    .info-card { background: #151f34; border-radius: 12px; padding: 14px 18px; margin-bottom: 20px; border: 1px solid rgba(255,255,255,0.06); }
    .info-row { display: flex; justify-content: space-between; padding: 6px 0; font-size: 13px; border-bottom: 1px solid rgba(255,255,255,0.04); }
    .info-row:last-child { border-bottom: none; }
    .info-label { color: #64748b; font-weight: 600; }
    .info-val { color: #ffffff; font-weight: 600; font-family: monospace; }
    .warning-box { background: rgba(245, 158, 11, 0.1); border: 1px solid rgba(245, 158, 11, 0.3); border-radius: 10px; padding: 12px 16px; font-size: 13px; color: #fbbf24; margin-bottom: 22px; }
    .btn { display: inline-block; background: #0284c7; color: #ffffff !important; text-decoration: none; padding: 10px 20px; border-radius: 8px; font-size: 13px; font-weight: 700; margin-top: 6px; }
    .footer { font-size: 11.5px; color: #475569; text-align: center; margin-top: 24px; border-top: 1px solid rgba(255,255,255,0.06); padding-top: 16px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1 class="title">🗣️ VocaMate</h1>
      <span class="badge">SECURITY NOTIFICATION</span>
    </div>
    <div class="greeting">Hello ${user.displayName || 'Learner'},</div>
    <div class="text">
      We noticed a new successful sign-in to your <strong>VocaMate</strong> account. Here are the sign-in details:
    </div>

    <div class="info-card">
      <div class="info-row">
        <span class="info-label">Account User ID:</span>
        <span class="info-val">#${user.userCode || '----'}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Account Email:</span>
        <span class="info-val" style="font-family:sans-serif;">${user.email}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Date & Time:</span>
        <span class="info-val" style="font-family:sans-serif;">${timeFormatted}</span>
      </div>
      <div class="info-row">
        <span class="info-label">IP Address:</span>
        <span class="info-val">${ip || '127.0.0.1'}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Device / Browser:</span>
        <span class="info-val" style="font-family:sans-serif; font-size:12px; max-width:240px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${userAgent ? userAgent.slice(0, 45) : 'Web Browser'}</span>
      </div>
    </div>

    <div class="text">
      If this was you, you can safely disregard this message. Your session is active and secure.
    </div>

    <div class="warning-box">
      <strong>Didn't sign in?</strong> If you did not perform this login, someone else might have access to your account.
      <br>
      <a href="${resetLink}" class="btn" style="margin-top:10px;">Change Password & Secure Account</a>
    </div>

    <div class="footer">
      This is an automated security notice from VocaMate AI English Speaking Platform.<br>
      © ${now.getFullYear()} VocaMate. All rights reserved.
    </div>
  </div>
</body>
</html>
  `.trim();

  const text = `
Hello ${user.displayName || 'Learner'},

A new sign-in was detected for your VocaMate account:
- User ID: #${user.userCode}
- Email: ${user.email}
- Time: ${timeFormatted}
- IP Address: ${ip || '127.0.0.1'}

If this was you, you can safely disregard this message.
If you did not sign in, please secure your account immediately: ${resetLink}
  `.trim();

  sendEmail({
    to: user.email,
    subject,
    html,
    text,
    type: 'login_alert',
    metadata: {
      userId: user.id,
      userCode: user.userCode,
      displayName: user.displayName,
      ip,
      userAgent
    }
  }).catch(e => console.error('sendLoginAlertEmail error:', e.message));

  activity.logEvent({
    userCode: user.userCode,
    userId: user.id,
    email: user.email,
    displayName: user.displayName,
    category: 'auth',
    type: 'email_login_alert',
    title: 'Login Alert Email Dispatched',
    summary: `Sent sign-in security notification to ${user.email}`,
    details: { email: user.email, ip, userAgent }
  });
}

/**
 * 2. Password Reset Request Email
 * Sent whenever user clicks "Forgot Password" and enters email
 */
async function sendPasswordResetEmail({ user, token, otp, appUrl }) {
  if (!user || !user.email) return null;

  const resolvedAppUrl = (appUrl || process.env.APP_URL || 'http://localhost:3000').replace(/\/+$/, '');
  const resetUrl = `${resolvedAppUrl}/reset-password.html?token=${token}`;
  const displayOtp = otp ? String(otp).trim() : token.slice(0, 6);
  const subject = `🔑 Your VocaMate Password Reset Code: ${displayOtp}`;

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #070b14; color: #f8fafc; margin: 0; padding: 24px; }
    .container { max-width: 540px; margin: 0 auto; background: #0e1526; border: 1px solid rgba(255,255,255,0.1); border-radius: 16px; padding: 32px; box-shadow: 0 12px 36px rgba(0,0,0,0.5); }
    .header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; border-bottom: 1px solid rgba(255,255,255,0.08); padding-bottom: 16px; }
    .title { font-size: 22px; font-weight: 800; color: #38bdf8; margin: 0; }
    .badge { background: rgba(245,158,11,0.15); color: #fbbf24; border: 1px solid rgba(245,158,11,0.3); padding: 3px 10px; border-radius: 20px; font-size: 11px; font-weight: 700; }
    .greeting { font-size: 17px; font-weight: 700; color: #ffffff; margin-bottom: 12px; }
    .text { font-size: 14.5px; line-height: 1.6; color: #94a3b8; margin-bottom: 20px; }
    .otp-box { background: rgba(56,189,248,0.1); border: 2px dashed #38bdf8; border-radius: 12px; padding: 20px; text-align: center; margin: 24px 0; }
    .otp-label { font-size: 13px; font-weight: 700; color: #94a3b8; text-transform: uppercase; letter-spacing: 1.5px; margin-bottom: 8px; }
    .otp-val { font-size: 36px; font-weight: 900; letter-spacing: 8px; color: #38bdf8; font-family: monospace; }
    .otp-hint { font-size: 12px; color: #64748b; margin-top: 8px; }
    .btn-wrap { text-align: center; margin: 24px 0; }
    .reset-btn { display: inline-block; background: linear-gradient(135deg, #38bdf8, #0284c7); color: #070b14 !important; font-size: 15px; font-weight: 800; text-decoration: none; padding: 14px 32px; border-radius: 10px; box-shadow: 0 4px 18px rgba(56,189,248,0.35); }
    .link-fallback { background: #151f34; border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; padding: 12px; font-family: monospace; font-size: 12px; color: #38bdf8; word-break: break-all; margin: 16px 0; }
    .notice { font-size: 13px; color: #64748b; line-height: 1.5; margin-top: 20px; }
    .footer { font-size: 11.5px; color: #475569; text-align: center; margin-top: 28px; border-top: 1px solid rgba(255,255,255,0.06); padding-top: 16px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1 class="title">🗣️ VocaMate</h1>
      <span class="badge">PASSWORD RESET</span>
    </div>
    <div class="greeting">Hello ${user.displayName || 'Learner'},</div>
    <div class="text">
      We received a request to reset your password for your <strong>VocaMate</strong> account (User ID: <strong>#${user.userCode || '----'}</strong>).
      Enter the 6-digit OTP code below directly on the password reset screen:
    </div>

    <div class="otp-box">
      <div class="otp-label">Your 6-Digit Password Reset OTP</div>
      <div class="otp-val">${displayOtp}</div>
      <div class="otp-hint">Valid for 15 minutes • Do not share this code</div>
    </div>

    <div class="btn-wrap">
      <a href="${resetUrl}" class="reset-btn">👉 Open Password Reset Page</a>
    </div>

    <div class="text" style="font-size:13px; margin-bottom:8px;">
      Or use this direct link in your browser:
    </div>
    <div class="link-fallback">${resetUrl}</div>

    <div class="notice">
      ⏱️ <strong>This reset code is valid for 15 minutes</strong> and can only be used once.<br>
      🛡️ If you did not request a password reset, you can safely ignore this email — your account remains completely secure.
    </div>

    <div class="footer">
      VocaMate AI English Speaking Platform • Real-time Conversation Practice<br>
      © ${new Date().getFullYear()} VocaMate.
    </div>
  </div>
</body>
</html>
  `.trim();

  const text = `
Hello ${user.displayName || 'Learner'},

We received a request to reset your password for your VocaMate account (#${user.userCode}).

Your 6-Digit Password Reset OTP: ${displayOtp}
(Valid for 15 minutes)

Direct Reset Link:
${resetUrl}

If you did not request a password reset, you can safely ignore this message.
  `.trim();

  const sendRes = await sendEmail({
    to: user.email,
    subject,
    html,
    text,
    type: 'password_reset',
    metadata: {
      userId: user.id,
      userCode: user.userCode,
      displayName: user.displayName,
      otp: displayOtp,
      resetUrl,
      tokenPrefix: token.slice(0, 8)
    }
  });

  activity.logEvent({
    userCode: user.userCode,
    userId: user.id,
    email: user.email,
    displayName: user.displayName,
    category: 'auth',
    type: 'email_password_reset',
    title: 'Password Reset OTP Sent',
    summary: `Sent password reset OTP (${displayOtp}) to ${user.email}`,
    details: { email: user.email, otp: displayOtp, resetUrl, delivered: sendRes && sendRes.delivered }
  });

  return {
    success: true,
    delivered: Boolean(sendRes && sendRes.delivered),
    sandboxRestricted: Boolean(sendRes && sendRes.sandboxRestricted),
    error: (sendRes && sendRes.error) || null,
    resetUrl,
    otp: displayOtp
  };
}

/**
 * 3. Registration Email Verification
 * Sent whenever a new user registers to verify their email address
 */
async function sendVerificationEmail({ user, token, otp, appUrl }) {
  if (!user || !user.email) return null;

  const resolvedAppUrl = (appUrl || process.env.APP_URL || 'http://localhost:3000').replace(/\/+$/, '');
  const verifyUrl = `${resolvedAppUrl}/verify-email.html?token=${token}`;
  const displayOtp = otp ? String(otp).trim() : token.slice(0, 6);
  const subject = `✉️ Your VocaMate Verification Code: ${displayOtp} (User ID: #${user.userCode})`;

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #070b14; color: #f8fafc; margin: 0; padding: 24px; }
    .container { max-width: 540px; margin: 0 auto; background: #0e1526; border: 1px solid rgba(255,255,255,0.1); border-radius: 16px; padding: 32px; box-shadow: 0 12px 36px rgba(0,0,0,0.5); }
    .header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; border-bottom: 1px solid rgba(255,255,255,0.08); padding-bottom: 16px; }
    .title { font-size: 22px; font-weight: 800; color: #10b981; margin: 0; }
    .badge { background: rgba(16,185,129,0.15); color: #34d399; border: 1px solid rgba(16,185,129,0.3); padding: 3px 10px; border-radius: 20px; font-size: 11px; font-weight: 700; }
    .greeting { font-size: 17px; font-weight: 700; color: #ffffff; margin-bottom: 12px; }
    .text { font-size: 14.5px; line-height: 1.6; color: #94a3b8; margin-bottom: 20px; }
    .id-box { background: rgba(16,185,129,0.08); border: 1.5px dashed rgba(16,185,129,0.35); border-radius: 12px; padding: 14px 18px; margin: 18px 0; text-align: center; }
    .id-box .id-label { font-size: 12px; color: #94a3b8; text-transform: uppercase; letter-spacing: 1px; font-weight: 700; margin-bottom: 4px; }
    .id-box .id-val { font-size: 24px; font-weight: 800; color: #10b981; letter-spacing: 2px; font-family: monospace; }
    .otp-box { background: rgba(16,185,129,0.1); border: 2px dashed #10b981; border-radius: 12px; padding: 20px; text-align: center; margin: 24px 0; }
    .otp-label { font-size: 13px; font-weight: 700; color: #94a3b8; text-transform: uppercase; letter-spacing: 1.5px; margin-bottom: 8px; }
    .otp-val { font-size: 36px; font-weight: 900; letter-spacing: 8px; color: #10b981; font-family: monospace; }
    .otp-hint { font-size: 12px; color: #64748b; margin-top: 8px; }
    .btn-wrap { text-align: center; margin: 24px 0; }
    .verify-btn { display: inline-block; background: linear-gradient(135deg, #10b981, #0d9488); color: #ffffff !important; font-size: 15px; font-weight: 800; text-decoration: none; padding: 14px 34px; border-radius: 12px; box-shadow: 0 4px 18px rgba(16,185,129,0.35); }
    .link-fallback { background: #151f34; border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; padding: 12px; font-family: monospace; font-size: 12px; color: #38bdf8; word-break: break-all; margin: 16px 0; }
    .notice { font-size: 13px; color: #64748b; line-height: 1.5; margin-top: 20px; }
    .footer { font-size: 11.5px; color: #475569; text-align: center; margin-top: 28px; border-top: 1px solid rgba(255,255,255,0.06); padding-top: 16px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1 class="title">🗣️ VocaMate</h1>
      <span class="badge">EMAIL VERIFICATION</span>
    </div>
    <div class="greeting">Welcome, ${user.displayName || 'Learner'}!</div>
    <div class="text">
      Thank you for joining <strong>VocaMate</strong>, your AI English Speaking & Peer Conversation platform.
      Your permanent 4-digit User ID has been automatically assigned:
    </div>

    <div class="id-box">
      <div class="id-label">Your Unique 4-Digit User ID</div>
      <div class="id-val">#${user.userCode}</div>
    </div>

    <div class="otp-box">
      <div class="otp-label">Your 6-Digit Verification Code (OTP)</div>
      <div class="otp-val">${displayOtp}</div>
      <div class="otp-hint">Enter this 6-digit code on the screen to activate your account instantly</div>
    </div>

    <div class="text">
      You can also click the activation button below to verify your account in one click:
    </div>

    <div class="btn-wrap">
      <a href="${verifyUrl}" class="verify-btn">👉 Verify Email & Activate Account</a>
    </div>

    <div class="text" style="font-size:13px; margin-bottom:8px;">
      Or copy and paste this link in your browser:
    </div>
    <div class="link-fallback">${verifyUrl}</div>

    <div class="notice">
      ⏱️ <strong>This OTP code is valid for 15 minutes</strong> (link valid for 24 hours).<br>
      🛡️ If you did not create a VocaMate account, please disregard this email.
    </div>

    <div class="footer">
      VocaMate AI English Speaking Platform • Real-time Conversation Practice<br>
      © ${new Date().getFullYear()} VocaMate.
    </div>
  </div>
</body>
</html>
  `.trim();

  const text = `
Welcome to VocaMate, ${user.displayName || 'Learner'}!

Your unique 4-digit User ID has been automatically assigned: #${user.userCode}

Your 6-Digit Verification OTP: ${displayOtp}
(Enter this code on the screen to activate your account)

Direct Activation Link:
${verifyUrl}

© VocaMate AI English Speaking Platform
  `.trim();

  const sendRes = await sendEmail({
    to: user.email,
    subject,
    html,
    text,
    type: 'email_verification',
    metadata: {
      userId: user.id,
      userCode: user.userCode,
      displayName: user.displayName,
      otp: displayOtp,
      verifyUrl,
      tokenPrefix: token.slice(0, 8)
    }
  });

  activity.logEvent({
    userCode: user.userCode,
    userId: user.id,
    email: user.email,
    displayName: user.displayName,
    category: 'auth',
    type: 'email_verification',
    title: 'Verification Email Dispatched',
    summary: `Dispatched account activation link to ${user.email}`,
    details: { email: user.email, userCode: user.userCode, verifyUrl, delivered: sendRes && sendRes.delivered }
  });

  return {
    success: true,
    delivered: Boolean(sendRes && sendRes.delivered),
    sandboxRestricted: Boolean(sendRes && sendRes.sandboxRestricted),
    error: (sendRes && sendRes.error) || null,
    verifyUrl,
    otp: displayOtp
  };
}

function getEmailLogs(limit = 100) {
  return emailLogs.slice(0, limit);
}

function getEmailGatewayConfig() {
  const cfg = loadEmailConfig();
  const hasResend = Boolean(cfg.resendApiKey || process.env.RESEND_API_KEY);
  const hasSmtp = Boolean(smtpTransporter);
  const rawSmtpUser = cfg.smtpUser || cfg.gmailUser || process.env.SMTP_USER || process.env.GMAIL_USER || '';
  const fromEmail = getSenderAddress();
  return {
    hasResend,
    hasSmtp,
    activeProvider: hasSmtp ? (cfg.gmailUser ? 'gmail' : 'smtp') : (hasResend ? 'resend' : 'console'),
    fromEmail,
    resendAccountOwner: 'chandrashekharbansal.2006@gmail.com',
    smtpUser: rawSmtpUser ? rawSmtpUser.replace(/(.{2})(.*)(@.*)/, '$1***$3') : '',
    rawSmtpUser: rawSmtpUser || '',
    gmailUser: cfg.gmailUser || process.env.GMAIL_USER || '',
    hasGmailPass: Boolean(cfg.gmailAppPassword || process.env.GMAIL_APP_PASSWORD),
    hasSmtpPass: Boolean(cfg.smtpPass || process.env.SMTP_PASS),
    smtpHost: cfg.smtpHost || process.env.SMTP_HOST || (cfg.gmailUser || process.env.GMAIL_USER ? 'smtp.gmail.com' : ''),
    smtpPort: cfg.smtpPort || process.env.SMTP_PORT || '587',
    customDomain: cfg.fromEmail && !cfg.fromEmail.includes('resend.dev') ? cfg.fromEmail : ''
  };
}

function updateEmailGatewayConfig(newCfg = {}) {
  const existing = loadEmailConfig();
  const merged = { ...existing };

  if (newCfg.fromEmail !== undefined) merged.fromEmail = (newCfg.fromEmail || '').trim();
  if (newCfg.resendApiKey !== undefined && newCfg.resendApiKey !== '********') {
    merged.resendApiKey = (newCfg.resendApiKey || '').trim();
  }
  if (newCfg.gmailUser !== undefined) merged.gmailUser = (newCfg.gmailUser || '').trim();
  if (newCfg.gmailAppPassword !== undefined && newCfg.gmailAppPassword !== '********') {
    merged.gmailAppPassword = (newCfg.gmailAppPassword || '').trim();
  }
  if (newCfg.smtpHost !== undefined) merged.smtpHost = (newCfg.smtpHost || '').trim();
  if (newCfg.smtpPort !== undefined) merged.smtpPort = parseInt(newCfg.smtpPort || '587', 10);
  if (newCfg.smtpUser !== undefined) merged.smtpUser = (newCfg.smtpUser || '').trim();
  if (newCfg.smtpPass !== undefined && newCfg.smtpPass !== '********') {
    merged.smtpPass = (newCfg.smtpPass || '').trim();
  }

  fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2), 'utf8');
  initTransporters();
  return getEmailGatewayConfig();
}

async function sendTestEmail(toEmail) {
  const target = (toEmail || '').trim();
  if (!target || !target.includes('@')) {
    throw new Error('Please enter a valid recipient email address for testing');
  }

  const testOtp = String(Math.floor(100000 + Math.random() * 900000));
  const res = await sendEmail({
    to: target,
    subject: `🧪 VocaMate Email Gateway Test (OTP: ${testOtp})`,
    html: `
      <div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif; max-width:520px; margin:0 auto; padding:28px; background:#0f172a; color:#f8fafc; border-radius:14px; border:1px solid rgba(255,255,255,0.1);">
        <h2 style="color:#38bdf8; margin-top:0;">🗣️ VocaMate Email Gateway Test</h2>
        <p style="font-size:15px; color:#cbd5e1; line-height:1.6;">This test email confirms that your email gateway is successfully delivering messages to: <strong style="color:#ffffff;">${target}</strong></p>
        <div style="background:rgba(56,189,248,0.1); border:2px dashed #38bdf8; border-radius:10px; padding:18px; text-align:center; margin:22px 0;">
          <div style="font-size:12px; color:#94a3b8; text-transform:uppercase; font-weight:700; letter-spacing:1px;">Test Verification OTP</div>
          <div style="font-size:34px; font-weight:900; color:#38bdf8; letter-spacing:8px; font-family:monospace; margin-top:6px;">${testOtp}</div>
        </div>
        <p style="font-size:13px; color:#94a3b8; line-height:1.5;">✅ If this email reached your inbox, all new users registering with this domain or email will receive their 6-digit OTP codes instantly!</p>
      </div>
    `,
    text: `VocaMate Email Gateway Test\nTarget: ${target}\nTest OTP: ${testOtp}\nYour email gateway is working!`,
    type: 'test_email',
    metadata: { test: true, otp: testOtp }
  });
  return res;
}

module.exports = {
  sendEmail,
  sendLoginAlertEmail,
  sendPasswordResetEmail,
  sendVerificationEmail,
  getEmailLogs,
  getEmailGatewayConfig,
  updateEmailGatewayConfig,
  sendTestEmail
};