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
const dns = require('dns');
const activity = require('./activity');

// Ensure IPv4 first on Node.js to prevent 30-second IPv6 hangs on Render and Linux containers
try {
  if (dns && typeof dns.setDefaultResultOrder === 'function') {
    dns.setDefaultResultOrder('ipv4first');
  }
} catch (e) {
  // Ignore if unsupported
}

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

  // Support both Environment Variables and config file (process.env priority for Render)
  const gmailUser = (process.env.GMAIL_USER || process.env.GMAIL_EMAIL || cfg.gmailUser || '').trim();
  const rawGmailPass = (process.env.GMAIL_APP_PASSWORD || process.env.GMAIL_PASSWORD || process.env.GMAIL_PASS || cfg.gmailAppPassword || '').trim();
  const cleanGmailPass = rawGmailPass.replace(/\s+/g, '');

  const smtpHost = (process.env.SMTP_HOST || cfg.smtpHost || process.env.EMAIL_HOST || (gmailUser ? 'smtp.gmail.com' : '')).trim();
  const smtpUser = (process.env.SMTP_USER || cfg.smtpUser || process.env.EMAIL_USER || gmailUser).trim();
  const smtpPass = (process.env.SMTP_PASS || process.env.SMTP_PASSWORD || cfg.smtpPass || process.env.EMAIL_PASS || cleanGmailPass).trim();
  const smtpPort = parseInt(process.env.SMTP_PORT || process.env.EMAIL_PORT || cfg.smtpPort || '587', 10);
  const smtpSecure = process.env.SMTP_SECURE === 'true' || cfg.smtpSecure === true || smtpPort === 465;

  if (gmailUser && cleanGmailPass) {
    const port = smtpPort === 465 ? 465 : 587;
    const isSecure = port === 465;
    smtpTransporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: port,
      secure: isSecure,
      requireTLS: !isSecure,
      family: 4, // CRITICAL FOR RENDER: forces IPv4 to avoid Render's 30s IPv6 hang
      pool: true, // Keep connection pool warm for sub-second email dispatch
      maxConnections: 3,
      maxMessages: 100,
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 25000,
      auth: {
        user: gmailUser,
        pass: cleanGmailPass
      }
    });
    console.log(`📧 Gmail SMTP Transporter initialized (${gmailUser}, port ${port}, secure=${isSecure}) with pooled IPv4 ✅`);
  } else if (smtpHost && smtpUser && smtpPass) {
    smtpTransporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpSecure,
      requireTLS: !smtpSecure,
      family: 4, // Force IPv4
      pool: true,
      maxConnections: 3,
      maxMessages: 100,
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 25000,
      auth: { user: smtpUser, pass: smtpPass }
    });
    console.log(`📧 SMTP Transporter initialized (${smtpHost}:${smtpPort} as ${smtpUser}) with pooled IPv4 ✅`);
  } else {
    smtpTransporter = null;
    console.warn('⚠️ No SMTP or Gmail credentials found. Outgoing emails will fail or fall back.');
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

function getSenderAddress(targetProvider) {
  const cfg = loadEmailConfig();
  const gmailUser = (process.env.GMAIL_USER || cfg.gmailUser || '').trim();
  const smtpUser = (process.env.SMTP_USER || cfg.smtpUser || '').trim();

  // If using SMTP/Gmail, From MUST match the authenticated user to pass SPF/DKIM/DMARC
  if (targetProvider === 'smtp' || targetProvider === 'gmail' || (!targetProvider && smtpTransporter)) {
    const user = gmailUser || smtpUser;
    if (user) {
      return `VocaMate <${user}>`;
    }
  }

  // If using Resend, check for custom verified domain (NEVER use @gmail.com for Resend as it will fail 403)
  if (targetProvider === 'resend') {
    if (cfg.fromEmail && cfg.fromEmail.trim() && !cfg.fromEmail.includes('resend.dev') && !cfg.fromEmail.includes('yourdomain.com') && !cfg.fromEmail.includes('gmail.com')) {
      return cfg.fromEmail.trim();
    }
    const envFrom = (process.env.EMAIL_FROM || '').trim();
    if (envFrom && !envFrom.includes('resend.dev') && !envFrom.includes('yourdomain.com') && !envFrom.includes('example.com') && !envFrom.includes('gmail.com')) {
      return envFrom;
    }
    return 'VocaMate <onboarding@resend.dev>';
  }

  if (gmailUser) return `VocaMate <${gmailUser}>`;
  if (smtpUser) return `VocaMate <${smtpUser}>`;

  // Fallback for Resend sandbox
  return 'VocaMate <onboarding@resend.dev>';
}

function getReplyToAddress() {
  const cfg = loadEmailConfig();
  const gmailUser = (cfg.gmailUser || process.env.GMAIL_USER || '').trim();
  if (gmailUser) return gmailUser;
  const smtpUser = (cfg.smtpUser || process.env.SMTP_USER || '').trim();
  if (smtpUser && smtpUser.includes('@')) return smtpUser;
  if (cfg.fromEmail && cfg.fromEmail.includes('@') && !cfg.fromEmail.includes('resend.dev')) return cfg.fromEmail.trim();
  return 'support@vocamate.com';
}

function getResendApiKey() {
  const cfg = loadEmailConfig();
  return (process.env.RESEND_API_KEY || cfg.resendApiKey || '').trim();
}

function getBrevoApiKey() {
  const cfg = loadEmailConfig();
  return (process.env.BREVO_API_KEY || process.env.SENDINBLUE_API_KEY || cfg.brevoApiKey || '').trim();
}

/**
 * Core sendEmail dispatcher with Anti-Spam compliance
 */
async function sendEmail({ to, subject, html, text, type = 'general', metadata = {} }) {
  const emailId = `mail_${Date.now()}_${nextEmailId++}`;
  const timestamp = new Date().toISOString();
  const brevoApiKey = getBrevoApiKey();
  const resendApiKey = getResendApiKey();
  const replyTo = getReplyToAddress();

  const activeProvider = brevoApiKey ? 'brevo' : (smtpTransporter ? 'smtp' : (resendApiKey ? 'resend' : 'console_fallback'));
  const from = getSenderAddress(activeProvider);

  const logEntry = {
    id: emailId,
    timestamp,
    to,
    from,
    subject,
    type,
    status: 'pending',
    provider: activeProvider,
    error: null,
    metadata
  };

  emailLogs.unshift(logEntry);
  if (emailLogs.length > MAX_LOGS) {
    emailLogs.splice(MAX_LOGS);
  }
  scheduleSave();

  // Standard Anti-Spam RFC Headers
  const antiSpamHeaders = {
    'X-Entity-Ref-ID': emailId,
    'Auto-Submitted': 'auto-generated',
    'X-Auto-Response-Suppress': 'All',
    'Precedence': 'bulk',
    'Feedback-ID': `auth:${type}:vocamate`
  };

  // 1) Try Brevo (Sendinblue) HTTPS API first if configured (Port 443 - NEVER BLOCKED BY RENDER OR CLOUD FIREWALLS)
  if (brevoApiKey) {
    try {
      const cfg = loadEmailConfig();
      const senderEmail = (process.env.GMAIL_USER || cfg.gmailUser || process.env.EMAIL_FROM || 'contact@vocamate.com').trim();
      const senderName = 'VocaMate';
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 12000);

      const res = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'api-key': brevoApiKey,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          sender: { name: senderName, email: senderEmail },
          to: [{ email: to }],
          subject,
          htmlContent: html,
          textContent: text || undefined,
          replyTo: { email: replyTo }
        })
      });
      clearTimeout(timeoutId);
      const resBody = await res.json().catch(() => ({}));
      if (res.ok && (resBody.messageId || res.status === 201 || res.status === 200)) {
        console.log(`✅ [BREVO HTTPS DELIVERED] to: ${to} | ID: ${resBody.messageId || 'ok'} | "${subject}"`);
        logEntry.status = 'sent';
        logEntry.provider = 'brevo';
        logEntry.from = `${senderName} <${senderEmail}>`;
        logEntry.smtpId = resBody.messageId || 'brevo_' + Date.now();
        logEntry.error = null;
        scheduleSave();
        return { ok: true, delivered: true, id: emailId, provider: 'brevo', otp: metadata.otp };
      } else {
        const errMsg = resBody.message || resBody.code || ('Brevo HTTP ' + res.status);
        console.warn(`⚠️ [BREVO API NOTICE] to: ${to}:`, errMsg);
        logEntry.error = 'Brevo: ' + errMsg;
      }
    } catch (brevoErr) {
      console.warn(`⚠️ [BREVO API EXCEPTION] to: ${to}:`, brevoErr.message);
      logEntry.error = 'Brevo: ' + brevoErr.message;
    }
  }

  // 2) Try SMTP (Gmail or custom) next if configured (delivers to ANY recipient address worldwide)
  if (smtpTransporter) {
    try {
      const smtpFrom = getSenderAddress('smtp');
      const sendPromise = smtpTransporter.sendMail({
        from: smtpFrom,
        to,
        subject,
        html,
        text: text || undefined,
        replyTo,
        headers: antiSpamHeaders
      });
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('SMTP send timed out after 25s')), 25000)
      );
      const info = await Promise.race([sendPromise, timeoutPromise]);
      console.log(`✅ [SMTP EMAIL DELIVERED] to: ${to} | ID: ${info.messageId} | "${subject}"`);
      logEntry.status = 'sent';
      logEntry.provider = 'smtp';
      logEntry.from = smtpFrom;
      logEntry.smtpId = info.messageId;
      logEntry.error = null;
      scheduleSave();
      return { ok: true, delivered: true, id: emailId, provider: 'smtp', otp: metadata.otp };
    } catch (smtpErr) {
      console.warn(`⚠️ [SMTP SEND ERROR] to: ${to}:`, smtpErr.message);
      logEntry.error = 'SMTP: ' + smtpErr.message;

      // If Gmail SMTP failed on primary port, attempt secondary port (465 if 587, or 587 if 465)
      const cfg = loadEmailConfig();
      const gmailUser = (process.env.GMAIL_USER || cfg.gmailUser || '').trim();
      const rawGmailPass = (process.env.GMAIL_APP_PASSWORD || cfg.gmailAppPassword || '').trim();
      const cleanGmailPass = rawGmailPass.replace(/\s+/g, '');
      const primaryPort = parseInt(process.env.SMTP_PORT || process.env.EMAIL_PORT || cfg.smtpPort || '587', 10);
      const altPort = primaryPort === 465 ? 587 : 465;

      if (gmailUser && cleanGmailPass) {
        try {
          console.log(`🔄 Retrying Gmail SMTP on alternate port ${altPort} for ${to}...`);
          const altTransporter = nodemailer.createTransport({
            host: 'smtp.gmail.com',
            port: altPort,
            secure: altPort === 465,
            requireTLS: altPort !== 465,
            family: 4,
            connectionTimeout: 15000,
            greetingTimeout: 15000,
            socketTimeout: 20000,
            auth: { user: gmailUser, pass: cleanGmailPass }
          });
          const altInfo = await altTransporter.sendMail({
            from: getSenderAddress('smtp'),
            to,
            subject,
            html,
            text: text || undefined,
            replyTo,
            headers: antiSpamHeaders
          });
          console.log(`✅ [GMAIL SMTP RETRY SUCCESS] Delivered to: ${to} via port ${altPort} | ID: ${altInfo.messageId}`);
          logEntry.status = 'sent';
          logEntry.provider = 'smtp';
          logEntry.smtpId = altInfo.messageId;
          logEntry.error = null;
          scheduleSave();
          return { ok: true, delivered: true, id: emailId, provider: 'smtp', otp: metadata.otp };
        } catch (altErr) {
          console.warn(`⚠️ [GMAIL SMTP RETRY ON PORT ${altPort} FAILED]:`, altErr.message);
          logEntry.error = `SMTP (primary port ${primaryPort} & alt port ${altPort}): ${smtpErr.message}; ${altErr.message}`;
        }
      }
      // Fall through to Resend if available
    }
  }

  // 3) Try Resend API if configured
  if (resendApiKey) {
    try {
      const resendFrom = getSenderAddress('resend');
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 6000);

      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Authorization': `Bearer ${resendApiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: resendFrom,
          to,
          subject,
          html,
          text: text || undefined,
          reply_to: replyTo,
          headers: antiSpamHeaders
        })
      });
      clearTimeout(timeoutId);

      const resBody = await res.json().catch(() => ({}));

      if (res.ok) {
        console.log(`✅ [RESEND EMAIL SENT] ID: ${resBody.id} to: ${to} | "${subject}"`);
        logEntry.status = 'sent';
        logEntry.provider = 'resend';
        logEntry.from = resendFrom;
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

        return {
          ok: false,
          delivered: false,
          sandboxRestricted: isSandboxRestriction,
          error: isSandboxRestriction ? 'Resend sandbox mode can only deliver to verified domain. Configure Brevo HTTPS API Key or Gmail SMTP in Admin Email Gateway.' : errMsg,
          id: emailId,
          otp: metadata.otp
        };
      }
    } catch (err) {
      const isTimeout = err.name === 'AbortError';
      const errMsg = isTimeout ? 'Email service timeout (8s)' : err.message;
      console.error('Email send exception:', errMsg);
      logEntry.status = 'error';
      logEntry.error = errMsg;
      scheduleSave();
      return { ok: false, delivered: false, error: errMsg, id: emailId, otp: metadata.otp };
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

  const appUrl = (process.env.APP_URL || 'http://localhost:3000').replace(/\/+$/, '');
  const resetLink = `${appUrl}/reset-password.html`;
  // Clean subject line without emojis to prevent spam filtering
  const subject = `VocaMate Security Alert: New sign-in detected for your account`;

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Security Alert</title>
</head>
<body style="margin:0; padding:24px; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; background-color:#f1f5f9; color:#0f172a;">
  <div style="max-width:540px; margin:0 auto; background:#ffffff; border:1px solid #e2e8f0; border-radius:12px; padding:32px 28px; box-shadow:0 4px 16px rgba(0,0,0,0.04);">
    <div style="border-bottom:1px solid #e2e8f0; padding-bottom:18px; margin-bottom:20px;">
      <h2 style="margin:0; font-size:22px; font-weight:800; color:#0284c7; letter-spacing:-0.3px;">VocaMate</h2>
      <p style="margin:4px 0 0 0; font-size:12px; color:#64748b; text-transform:uppercase; font-weight:700; letter-spacing:0.5px;">Account Security Notification</p>
    </div>

    <p style="font-size:15px; font-weight:600; color:#0f172a; margin:0 0 12px 0;">Hello ${user.displayName || 'Learner'},</p>
    <p style="font-size:14px; line-height:1.6; color:#475569; margin:0 0 18px 0;">
      A new successful sign-in to your <strong>VocaMate</strong> account was recorded with the following details:
    </p>

    <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px; padding:14px 18px; margin-bottom:20px; font-size:13px;">
      <div style="display:flex; justify-content:space-between; padding:5px 0; border-bottom:1px solid #f1f5f9;">
        <span style="color:#64748b; font-weight:600;">Account ID:</span>
        <span style="font-weight:700; color:#0f172a; font-family:monospace;">#${user.userCode || '----'}</span>
      </div>
      <div style="display:flex; justify-content:space-between; padding:5px 0; border-bottom:1px solid #f1f5f9;">
        <span style="color:#64748b; font-weight:600;">Account Email:</span>
        <span style="font-weight:600; color:#0f172a;">${user.email}</span>
      </div>
      <div style="display:flex; justify-content:space-between; padding:5px 0; border-bottom:1px solid #f1f5f9;">
        <span style="color:#64748b; font-weight:600;">Date & Time:</span>
        <span style="font-weight:600; color:#0f172a;">${timeFormatted}</span>
      </div>
      <div style="display:flex; justify-content:space-between; padding:5px 0; border-bottom:1px solid #f1f5f9;">
        <span style="color:#64748b; font-weight:600;">IP Address:</span>
        <span style="font-weight:600; color:#0f172a; font-family:monospace;">${ip || '127.0.0.1'}</span>
      </div>
      <div style="display:flex; justify-content:space-between; padding:5px 0;">
        <span style="color:#64748b; font-weight:600;">Browser / Device:</span>
        <span style="font-weight:600; color:#0f172a; max-width:240px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${userAgent ? userAgent.slice(0, 45) : 'Web Client'}</span>
      </div>
    </div>

    <p style="font-size:13.5px; line-height:1.6; color:#475569; margin:0 0 16px 0;">
      If this was you, you can safely ignore this notification. Your session is active and protected.
    </p>

    <div style="background:#fffbeb; border:1px solid #fde68a; border-radius:8px; padding:12px 16px; font-size:13px; color:#92400e; margin-bottom:20px;">
      <strong>Didn't sign in?</strong> If you did not perform this login, please secure your account immediately:
      <div style="margin-top:10px;">
        <a href="${resetLink}" style="display:inline-block; background:#0284c7; color:#ffffff; text-decoration:none; padding:9px 18px; border-radius:6px; font-size:12.5px; font-weight:700;">Reset Password & Secure Account</a>
      </div>
    </div>

    <div style="border-top:1px solid #e2e8f0; padding-top:16px; margin-top:24px; font-size:11.5px; color:#94a3b8; text-align:center; line-height:1.5;">
      VocaMate Learning Platform • AI English Speaking & Peer Conversation Practice<br>
      This is an automated transactional security email sent to ${user.email}.
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

If this was you, no action is needed.
If you did not sign in, please secure your account immediately: ${resetLink}

VocaMate Learning Platform
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
  // Anti-spam subject: clear, standard transactional style
  const subject = `VocaMate: Your password reset code is ${displayOtp}`;

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Password Reset Code</title>
</head>
<body style="margin:0; padding:24px; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; background-color:#f1f5f9; color:#0f172a;">
  <div style="max-width:540px; margin:0 auto; background:#ffffff; border:1px solid #e2e8f0; border-radius:12px; padding:32px 28px; box-shadow:0 4px 16px rgba(0,0,0,0.04);">
    <div style="border-bottom:1px solid #e2e8f0; padding-bottom:18px; margin-bottom:20px;">
      <h2 style="margin:0; font-size:22px; font-weight:800; color:#0284c7; letter-spacing:-0.3px;">VocaMate</h2>
      <p style="margin:4px 0 0 0; font-size:12px; color:#64748b; text-transform:uppercase; font-weight:700; letter-spacing:0.5px;">Password Reset Request</p>
    </div>

    <p style="font-size:15px; font-weight:600; color:#0f172a; margin:0 0 12px 0;">Hello ${user.displayName || 'Learner'},</p>
    <p style="font-size:14px; line-height:1.6; color:#475569; margin:0 0 18px 0;">
      We received a request to reset the password for your VocaMate account (User ID: <strong>#${user.userCode || '----'}</strong>).
      Please enter the 6-digit verification code below on the password reset screen:
    </p>

    <!-- Clear, High-Contrast OTP Code Card -->
    <div style="background:#f0f9ff; border:2px dashed #0284c7; border-radius:10px; padding:22px 16px; text-align:center; margin:22px 0;">
      <div style="font-size:12px; font-weight:700; color:#0369a1; text-transform:uppercase; letter-spacing:1px; margin-bottom:8px;">Your 6-Digit Password Reset Code</div>
      <div style="font-size:36px; font-weight:800; color:#0f172a; letter-spacing:8px; font-family:'Courier New',Courier,monospace;">${displayOtp}</div>
      <div style="font-size:12px; color:#64748b; margin-top:8px;">Valid for 15 minutes • Do not share this code with anyone</div>
    </div>

    <div style="text-align:center; margin:24px 0 18px 0;">
      <a href="${resetUrl}" style="display:inline-block; background:#0284c7; color:#ffffff; font-size:14px; font-weight:700; text-decoration:none; padding:12px 28px; border-radius:8px;">Open Password Reset Page</a>
    </div>

    <p style="font-size:12.5px; color:#64748b; margin:16px 0 4px 0;">Or copy and paste this link in your browser:</p>
    <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:6px; padding:10px; font-family:monospace; font-size:11.5px; color:#0284c7; word-break:break-all;">
      ${resetUrl}
    </div>

    <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px; padding:12px 14px; font-size:12.5px; color:#64748b; line-height:1.5; margin-top:20px;">
      If you did not request a password reset, you can safely disregard this email — your account remains secure.
    </div>

    <div style="border-top:1px solid #e2e8f0; padding-top:16px; margin-top:24px; font-size:11.5px; color:#94a3b8; text-align:center; line-height:1.5;">
      VocaMate Learning Platform • AI English Speaking & Peer Conversation Practice<br>
      This is an automated transactional security email sent to ${user.email}.
    </div>
  </div>
</body>
</html>
  `.trim();

  const text = `
Hello ${user.displayName || 'Learner'},

We received a request to reset your password for your VocaMate account (#${user.userCode}).

Your 6-Digit Password Reset OTP: ${displayOtp}
(This code is valid for 15 minutes)

Direct Password Reset Link:
${resetUrl}

If you did not request a password reset, you can safely ignore this message.

VocaMate Learning Platform
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
  // Anti-spam subject: clear, standard transactional style without emojis
  const subject = `VocaMate: Your verification code is ${displayOtp}`;

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Verify your VocaMate Account</title>
</head>
<body style="margin:0; padding:24px; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; background-color:#f1f5f9; color:#0f172a;">
  <div style="max-width:540px; margin:0 auto; background:#ffffff; border:1px solid #e2e8f0; border-radius:12px; padding:32px 28px; box-shadow:0 4px 16px rgba(0,0,0,0.04);">
    <div style="border-bottom:1px solid #e2e8f0; padding-bottom:18px; margin-bottom:20px;">
      <h2 style="margin:0; font-size:22px; font-weight:800; color:#0284c7; letter-spacing:-0.3px;">VocaMate</h2>
      <p style="margin:4px 0 0 0; font-size:12px; color:#64748b; text-transform:uppercase; font-weight:700; letter-spacing:0.5px;">Account Verification</p>
    </div>

    <p style="font-size:15px; font-weight:600; color:#0f172a; margin:0 0 12px 0;">Welcome, ${user.displayName || 'Learner'}!</p>
    <p style="font-size:14px; line-height:1.6; color:#475569; margin:0 0 18px 0;">
      Thank you for creating an account on <strong>VocaMate</strong>. Your permanent User ID is <strong>#${user.userCode}</strong>.
      Please use the 6-digit verification code below to activate your account:
    </p>

    <!-- Clear, High-Contrast OTP Code Card -->
    <div style="background:#f0fdf4; border:2px dashed #16a34a; border-radius:10px; padding:22px 16px; text-align:center; margin:22px 0;">
      <div style="font-size:12px; font-weight:700; color:#15803d; text-transform:uppercase; letter-spacing:1px; margin-bottom:8px;">Your 6-Digit Verification Code</div>
      <div style="font-size:36px; font-weight:800; color:#0f172a; letter-spacing:8px; font-family:'Courier New',Courier,monospace;">${displayOtp}</div>
      <div style="font-size:12px; color:#64748b; margin-top:8px;">Enter this code on the verification screen to activate your account</div>
    </div>

    <div style="text-align:center; margin:24px 0 18px 0;">
      <a href="${verifyUrl}" style="display:inline-block; background:#16a34a; color:#ffffff; font-size:14px; font-weight:700; text-decoration:none; padding:12px 28px; border-radius:8px;">Verify Email Address</a>
    </div>

    <p style="font-size:12.5px; color:#64748b; margin:16px 0 4px 0;">Or copy and paste this link in your browser:</p>
    <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:6px; padding:10px; font-family:monospace; font-size:11.5px; color:#0284c7; word-break:break-all;">
      ${verifyUrl}
    </div>

    <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px; padding:12px 14px; font-size:12.5px; color:#64748b; line-height:1.5; margin-top:20px;">
      ⏱️ This code is valid for 15 minutes. If you did not sign up for a VocaMate account, please disregard this email.
    </div>

    <div style="border-top:1px solid #e2e8f0; padding-top:16px; margin-top:24px; font-size:11.5px; color:#94a3b8; text-align:center; line-height:1.5;">
      VocaMate Learning Platform • AI English Speaking & Peer Conversation Practice<br>
      This is an automated transactional security email sent to ${user.email}.
    </div>
  </div>
</body>
</html>
  `.trim();

  const text = `
Welcome to VocaMate, ${user.displayName || 'Learner'}!

Your unique 4-digit User ID has been automatically assigned: #${user.userCode}

Your 6-Digit Verification Code (OTP): ${displayOtp}
(Enter this code on the screen to activate your account)

Direct Activation Link:
${verifyUrl}

This code is valid for 15 minutes. If you did not create a VocaMate account, please disregard this email.

VocaMate Learning Platform
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
  const hasBrevo = Boolean(cfg.brevoApiKey || process.env.BREVO_API_KEY || process.env.SENDINBLUE_API_KEY);
  const hasResend = Boolean(cfg.resendApiKey || process.env.RESEND_API_KEY);
  const hasSmtp = Boolean(smtpTransporter);
  const rawSmtpUser = cfg.smtpUser || cfg.gmailUser || process.env.SMTP_USER || process.env.GMAIL_USER || '';
  const fromEmail = getSenderAddress();
  return {
    hasBrevo,
    hasResend,
    hasSmtp,
    activeProvider: hasBrevo ? 'brevo' : (hasSmtp ? (cfg.gmailUser ? 'gmail' : 'smtp') : (hasResend ? 'resend' : 'console')),
    fromEmail,
    resendAccountOwner: (cfg.fromEmail || process.env.EMAIL_FROM || '').trim(),
    smtpUser: rawSmtpUser ? rawSmtpUser.replace(/(.{2})(.*)(@.*)/, '$1***$3') : '',
    rawSmtpUser: rawSmtpUser || '',
    gmailUser: cfg.gmailUser || process.env.GMAIL_USER || '',
    hasGmailPass: Boolean(cfg.gmailAppPassword || process.env.GMAIL_APP_PASSWORD || process.env.GMAIL_PASSWORD || process.env.GMAIL_PASS),
    hasBrevoKey: hasBrevo,
    hasSmtpPass: Boolean(cfg.smtpPass || process.env.SMTP_PASS || process.env.EMAIL_PASS),
    smtpHost: cfg.smtpHost || process.env.SMTP_HOST || (cfg.gmailUser || process.env.GMAIL_USER ? 'smtp.gmail.com' : ''),
    smtpPort: cfg.smtpPort || process.env.SMTP_PORT || '587',
    customDomain: cfg.fromEmail && !cfg.fromEmail.includes('resend.dev') ? cfg.fromEmail : ''
  };
}

function isMaskedValue(val) {
  if (val === undefined || val === null) return true;
  const s = String(val).trim();
  if (!s) return true; // Empty string or whitespace is treated as NO NEW VALUE (preserves existing password)
  return /^[\u2022\u25cf\*\s]+$/.test(s) || s.includes('••••••••') || s.includes('********') || s.includes('••••');
}

function updateEmailGatewayConfig(newCfg = {}) {
  const existing = loadEmailConfig();
  const merged = { ...existing };

  if (newCfg.fromEmail !== undefined && typeof newCfg.fromEmail === 'string') {
    const trimmed = newCfg.fromEmail.trim();
    if (trimmed) merged.fromEmail = trimmed;
  }

  // Brevo API Key: update if provided
  if (newCfg.clearBrevoKey === true) {
    merged.brevoApiKey = '';
  } else if (newCfg.brevoApiKey !== undefined) {
    const rawKey = String(newCfg.brevoApiKey || '').trim();
    if (rawKey && !isMaskedValue(rawKey)) {
      merged.brevoApiKey = rawKey;
    }
  }

  // Resend API Key: only update if explicitly provided and not masked/empty
  if (newCfg.clearResendKey === true) {
    merged.resendApiKey = '';
  } else if (newCfg.resendApiKey !== undefined) {
    const rawKey = String(newCfg.resendApiKey || '').trim();
    if (rawKey && !isMaskedValue(rawKey)) {
      merged.resendApiKey = rawKey;
    }
  }

  // Gmail User: update if non-empty
  if (newCfg.gmailUser !== undefined) {
    const gu = String(newCfg.gmailUser || '').trim();
    if (gu) merged.gmailUser = gu;
  }

  // Gmail App Password:
  // CRITICAL: NEVER overwrite with empty string, whitespace, or masked dots!
  // Only update if a valid non-empty string is passed.
  // If user wants to explicitly clear it, they must pass clearGmailPassword: true.
  if (newCfg.clearGmailPassword === true) {
    merged.gmailAppPassword = '';
  } else if (newCfg.gmailAppPassword !== undefined) {
    const rawPass = String(newCfg.gmailAppPassword || '').trim();
    if (rawPass && !isMaskedValue(rawPass)) {
      // Strip spaces since users copy Google App Passwords as 'abcd efgh ijkl mnop'
      const cleanPass = rawPass.replace(/\s+/g, '');
      if (cleanPass.length > 0) {
        merged.gmailAppPassword = cleanPass;
      }
    }
  }

  if (newCfg.smtpHost !== undefined && typeof newCfg.smtpHost === 'string') {
    const sh = newCfg.smtpHost.trim();
    if (sh) merged.smtpHost = sh;
  }
  if (newCfg.smtpPort !== undefined) {
    const sp = parseInt(newCfg.smtpPort || '587', 10);
    if (!isNaN(sp) && sp > 0) merged.smtpPort = sp;
  }
  if (newCfg.smtpUser !== undefined) {
    const su = String(newCfg.smtpUser || '').trim();
    if (su) merged.smtpUser = su;
  }
  if (newCfg.clearSmtpPass === true) {
    merged.smtpPass = '';
  } else if (newCfg.smtpPass !== undefined) {
    const sp = String(newCfg.smtpPass || '').trim();
    if (sp && !isMaskedValue(sp)) {
      merged.smtpPass = sp;
    }
  }

  // If user entered a gmailUser, auto-set fromEmail if not set
  if (merged.gmailUser && (!merged.fromEmail || merged.fromEmail.includes('resend.dev'))) {
    merged.fromEmail = `VocaMate <${merged.gmailUser}>`;
  }

  fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2), 'utf8');
  initTransporters();
  return getEmailGatewayConfig();
}

async function verifyEmailGatewayConnection() {
  const cfg = loadEmailConfig();
  const brevoApiKey = getBrevoApiKey();
  const gmailUser = (cfg.gmailUser || process.env.GMAIL_USER || process.env.EMAIL_USER || '').trim();
  const rawGmailPass = (cfg.gmailAppPassword || process.env.GMAIL_APP_PASSWORD || process.env.GMAIL_PASSWORD || process.env.GMAIL_PASS || '').trim();
  const cleanGmailPass = rawGmailPass.replace(/\s+/g, '');

  // 1. If Brevo HTTPS Key is configured, test connection via HTTPS
  if (brevoApiKey) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);
      const res = await fetch('https://api.brevo.com/v3/account', {
        headers: { 'api-key': brevoApiKey },
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      if (res.ok) {
        const body = await res.json().catch(() => ({}));
        return {
          ok: true,
          connected: true,
          provider: 'brevo',
          message: `Connected to Brevo HTTPS API (${body.email || 'Active'}) — 100% firewall-safe on Render (Port 443)`
        };
      } else {
        return { ok: false, connected: false, provider: 'brevo', error: `Brevo API returned HTTP ${res.status}` };
      }
    } catch (e) {
      return { ok: false, connected: false, provider: 'brevo', error: `Brevo API check failed: ${e.message}` };
    }
  }

  // 2. If Gmail SMTP is configured, test SMTP connection
  if (gmailUser && cleanGmailPass) {
    if (!smtpTransporter) {
      initTransporters();
    }
    if (smtpTransporter) {
      try {
        const verifyPromise = smtpTransporter.verify();
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Connection check timed out after 10s. If deploying on Render Free Tier, note that Render blocks outbound SMTP ports 587/465. To bypass, configure BREVO_API_KEY in Render Environment Variables.')), 10000)
        );
        await Promise.race([verifyPromise, timeoutPromise]);
        return { ok: true, connected: true, provider: 'gmail', message: `Connected to Gmail SMTP as ${gmailUser}` };
      } catch (err) {
        return { ok: false, connected: false, provider: 'gmail', error: err.message };
      }
    }
  } else if (smtpTransporter) {
    try {
      const verifyPromise = smtpTransporter.verify();
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('SMTP connection check timed out')), 10000)
      );
      await Promise.race([verifyPromise, timeoutPromise]);
      return { ok: true, connected: true, provider: 'custom_smtp', message: 'Connected to custom SMTP server' };
    } catch (err) {
      return { ok: false, connected: false, provider: 'custom_smtp', error: err.message };
    }
  }
  return { ok: false, connected: false, message: 'Email credentials not fully configured (needs Brevo API Key or Gmail email & 16-character App Password)' };
}

async function sendTestEmail(toEmail) {
  const target = (toEmail || '').trim();
  if (!target || !target.includes('@')) {
    throw new Error('Please enter a valid recipient email address for testing');
  }

  const testOtp = String(Math.floor(100000 + Math.random() * 900000));
  const res = await sendEmail({
    to: target,
    subject: `VocaMate: Your email test code is ${testOtp}`,
    html: `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>VocaMate Email Test</title>
      </head>
      <body style="margin:0; padding:24px; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; background-color:#f1f5f9; color:#0f172a;">
        <div style="max-width:520px; margin:0 auto; padding:32px 28px; background:#ffffff; color:#0f172a; border-radius:12px; border:1px solid #e2e8f0; box-shadow:0 4px 16px rgba(0,0,0,0.04);">
          <div style="border-bottom:1px solid #e2e8f0; padding-bottom:14px; margin-bottom:18px;">
            <h2 style="color:#0284c7; margin:0; font-size:20px; font-weight:800;">VocaMate Email Gateway Test</h2>
            <p style="margin:4px 0 0 0; font-size:12px; color:#64748b; text-transform:uppercase; font-weight:700;">Delivery & Anti-Spam Check</p>
          </div>
          <p style="font-size:14.5px; color:#475569; line-height:1.6; margin:0 0 16px 0;">
            This test verifies that your VocaMate email gateway is successfully dispatching messages to:
            <br><strong style="color:#0f172a; font-size:15px;">${target}</strong>
          </p>
          <div style="background:#f0f9ff; border:2px dashed #0284c7; border-radius:10px; padding:20px; text-align:center; margin:20px 0;">
            <div style="font-size:11.5px; color:#0369a1; text-transform:uppercase; font-weight:700; letter-spacing:1px;">Test Verification OTP</div>
            <div style="font-size:36px; font-weight:800; color:#0f172a; letter-spacing:8px; font-family:'Courier New',Courier,monospace; margin-top:6px;">${testOtp}</div>
            <div style="font-size:11.5px; color:#64748b; margin-top:6px;">Valid for 15 minutes</div>
          </div>
          <div style="background:#f0fdf4; border:1px solid #bbf7d0; border-radius:8px; padding:12px 14px; font-size:13px; color:#166534; line-height:1.5;">
            <strong>Inbox Placement Confirmed:</strong> Because this email reached your inbox, all student registrations and password resets will reach their devices reliably.
          </div>
          <div style="border-top:1px solid #e2e8f0; padding-top:14px; margin-top:22px; font-size:11.5px; color:#94a3b8; text-align:center;">
            VocaMate Learning Platform • Automated Dispatcher<br>
            If you did not request this test, you can safely ignore this email.
          </div>
        </div>
      </body>
      </html>
    `,
    text: `VocaMate Email Gateway Test\nTarget: ${target}\nTest OTP: ${testOtp}\nYour email gateway is working!`,
    type: 'test_email',
    metadata: { test: true, otp: testOtp }
  });
  return res;
}

/**
 * 4. AI Interview Performance Report Email
 * Sent directly to user's registered email when an interview is completed
 */
async function sendInterviewReportEmail({ user, interviewData }) {
  if (!user || !user.email) throw new Error('Valid user with registered email is required');

  const {
    topicTitle = 'Technical Interview',
    difficulty = 'Intermediate',
    overallScore = 80,
    overallGrade = 'Good',
    strengths = [],
    weaknesses = [],
    areasToImprove = [],
    summary = '',
    questionEvaluations = []
  } = interviewData || {};

  const subject = `VocaMate Interview Report: ${topicTitle} (${overallScore}/100 - ${overallGrade})`;

  const strengthsHtml = strengths.map(s => `<li style="margin-bottom:6px; color:#166534;">${escapeHtml(s)}</li>`).join('') || '<li>Demonstrated good foundational knowledge</li>';
  const weaknessesHtml = weaknesses.map(w => `<li style="margin-bottom:6px; color:#991b1b;">${escapeHtml(w)}</li>`).join('') || '<li>Keep working on structured explanations</li>';
  const improvementsHtml = areasToImprove.map(a => `<li style="margin-bottom:6px; color:#1e40af;">${escapeHtml(a)}</li>`).join('') || '<li>Practice answering with concrete examples</li>';

  let questionsBreakdownHtml = '';
  if (Array.isArray(questionEvaluations) && questionEvaluations.length > 0) {
    questionsBreakdownHtml = questionEvaluations.map((q, idx) => `
      <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px; padding:14px; margin-bottom:12px;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
          <strong style="color:#0f172a; font-size:13.5px;">Q${idx + 1}: ${escapeHtml(q.question || '')}</strong>
          <span style="background:#0284c7; color:#fff; font-size:11px; font-weight:700; padding:2px 8px; border-radius:999px;">${q.score !== undefined ? q.score + '/10' : ''}</span>
        </div>
        <p style="margin:4px 0 8px 0; font-size:13px; color:#334155;"><strong>Your Answer:</strong> <em>"${escapeHtml(q.answer || '(No answer recorded)')}"</em></p>
        ${q.whatWasCorrect ? `<div style="font-size:12.5px; color:#15803d; margin-bottom:4px;"><strong>✓ Correct:</strong> ${escapeHtml(q.whatWasCorrect)}</div>` : ''}
        ${q.whatWasMissing ? `<div style="font-size:12.5px; color:#b45309; margin-bottom:4px;"><strong>⚠ Missing:</strong> ${escapeHtml(q.whatWasMissing)}</div>` : ''}
        ${q.mistakes ? `<div style="font-size:12.5px; color:#dc2626; margin-bottom:4px;"><strong>✗ Inaccuracies:</strong> ${escapeHtml(q.mistakes)}</div>` : ''}
        ${q.betterAnswer ? `<div style="background:#f0fdf4; border:1px solid #bbf7d0; border-radius:6px; padding:8px 10px; font-size:12px; color:#166534; margin-top:6px;"><strong>💡 Model Professional Answer:</strong> ${escapeHtml(q.betterAnswer)}</div>` : ''}
      </div>
    `).join('');
  }

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Interview Report</title>
</head>
<body style="margin:0; padding:24px; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; background-color:#f1f5f9; color:#0f172a;">
  <div style="max-width:620px; margin:0 auto; background:#ffffff; border:1px solid #e2e8f0; border-radius:12px; padding:32px 28px; box-shadow:0 4px 16px rgba(0,0,0,0.04);">
    <div style="border-bottom:1px solid #e2e8f0; padding-bottom:18px; margin-bottom:20px;">
      <h2 style="margin:0; font-size:22px; font-weight:800; color:#0284c7;">VocaMate AI Interview Practice</h2>
      <p style="margin:4px 0 0 0; font-size:12px; color:#64748b; text-transform:uppercase; font-weight:700;">Performance Evaluation Report</p>
    </div>

    <p style="font-size:15px; font-weight:600; color:#0f172a; margin:0 0 8px 0;">Hello ${escapeHtml(user.displayName || 'Candidate')},</p>
    <p style="font-size:14px; line-height:1.6; color:#475569; margin:0 0 20px 0;">
      Here is your detailed AI interview evaluation for <strong>${escapeHtml(topicTitle)}</strong> (${escapeHtml(difficulty)} level).
    </p>

    <!-- Score Card -->
    <div style="background:linear-gradient(135deg, #0284c7 0%, #0369a1 100%); border-radius:12px; padding:22px; text-align:center; color:#ffffff; margin-bottom:24px;">
      <div style="font-size:12px; text-transform:uppercase; letter-spacing:1px; opacity:0.9;">Overall Performance Score</div>
      <div style="font-size:46px; font-weight:900; letter-spacing:-1px; margin:8px 0;">${overallScore}<span style="font-size:20px; font-weight:600; opacity:0.85;">/100</span></div>
      <div style="display:inline-block; background:rgba(255,255,255,0.2); padding:4px 14px; border-radius:999px; font-size:13px; font-weight:700;">${escapeHtml(overallGrade)}</div>
    </div>

    ${summary ? `
    <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px; padding:16px; margin-bottom:20px;">
      <h4 style="margin:0 0 8px 0; font-size:14px; color:#0f172a;">Evaluator Verdict</h4>
      <p style="margin:0; font-size:13.5px; line-height:1.6; color:#334155;">${escapeHtml(summary)}</p>
    </div>
    ` : ''}

    <div style="display:grid; grid-template-columns:1fr; gap:16px; margin-bottom:24px;">
      <div style="background:#f0fdf4; border:1px solid #bbf7d0; border-radius:8px; padding:16px;">
        <h4 style="margin:0 0 8px 0; font-size:13.5px; color:#166534;">🌟 Key Strengths</h4>
        <ul style="margin:0; padding-left:20px; font-size:13px;">${strengthsHtml}</ul>
      </div>
      <div style="background:#fef2f2; border:1px solid #fecaca; border-radius:8px; padding:16px;">
        <h4 style="margin:0 0 8px 0; font-size:13.5px; color:#991b1b;">⚠️ Weaknesses & Gaps</h4>
        <ul style="margin:0; padding-left:20px; font-size:13px;">${weaknessesHtml}</ul>
      </div>
      <div style="background:#eff6ff; border:1px solid #bfdbfe; border-radius:8px; padding:16px;">
        <h4 style="margin:0 0 8px 0; font-size:13.5px; color:#1e40af;">🚀 Actionable Recommendations</h4>
        <ul style="margin:0; padding-left:20px; font-size:13px;">${improvementsHtml}</ul>
      </div>
    </div>

    ${questionsBreakdownHtml ? `
    <div style="margin-top:24px;">
      <h3 style="font-size:16px; color:#0f172a; margin:0 0 14px 0;">Question-by-Question Analysis</h3>
      ${questionsBreakdownHtml}
    </div>
    ` : ''}

    <div style="border-top:1px solid #e2e8f0; padding-top:16px; margin-top:28px; font-size:11.5px; color:#94a3b8; text-align:center; line-height:1.5;">
      VocaMate Learning Platform • AI Spoken English & Technical Interview Practice<br>
      This report was generated specifically for ${escapeHtml(user.email)}.
    </div>
  </div>
</body>
</html>
  `.trim();

  const text = `
VocaMate Interview Performance Report
Candidate: ${user.displayName || 'Candidate'} (#${user.userCode})
Topic: ${topicTitle} (${difficulty})
Overall Score: ${overallScore}/100 (${overallGrade})

Summary:
${summary}

Strengths:
${strengths.map(s => '- ' + s).join('\n')}

Weaknesses:
${weaknesses.map(w => '- ' + w).join('\n')}

Areas to Improve:
${areasToImprove.map(a => '- ' + a).join('\n')}

VocaMate Learning Platform
  `.trim();

  const sendRes = await sendEmail({
    to: user.email,
    subject,
    html,
    text,
    type: 'interview_report',
    metadata: {
      userId: user.id,
      userCode: user.userCode,
      topic: topicTitle,
      overallScore
    }
  });

  activity.logEvent({
    userCode: user.userCode,
    userId: user.id,
    email: user.email,
    displayName: user.displayName,
    category: 'interview',
    type: 'email_interview_report',
    title: `Interview Report Emailed: ${topicTitle}`,
    summary: `Sent performance report (${overallScore}/100) to ${user.email}`,
    details: { topic: topicTitle, score: overallScore, delivered: sendRes && sendRes.delivered }
  });

  return sendRes;
}

/**
 * 5. Group Discussion (GD) Invitation Email
 * Sent when a friend invites user to a private GD
 */
async function sendGdInviteEmail({ inviter, recipient, gdRoomId, topic, groupSize, appUrl }) {
  if (!recipient || !recipient.email) throw new Error('Recipient must have a valid registered email');

  const resolvedAppUrl = (appUrl || process.env.APP_URL || 'http://localhost:3000').replace(/\/+$/, '');
  const joinUrl = `${resolvedAppUrl}/#gd?room=${encodeURIComponent(gdRoomId)}`;
  const subject = `VocaMate GD Invitation: ${inviter.displayName || 'A friend'} invited you to a Group Discussion`;

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Group Discussion Invitation</title>
</head>
<body style="margin:0; padding:24px; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; background-color:#f1f5f9; color:#0f172a;">
  <div style="max-width:540px; margin:0 auto; background:#ffffff; border:1px solid #e2e8f0; border-radius:12px; padding:32px 28px; box-shadow:0 4px 16px rgba(0,0,0,0.04);">
    <div style="border-bottom:1px solid #e2e8f0; padding-bottom:18px; margin-bottom:20px;">
      <h2 style="margin:0; font-size:22px; font-weight:800; color:#0284c7;">VocaMate Group Discussion</h2>
      <p style="margin:4px 0 0 0; font-size:12px; color:#64748b; text-transform:uppercase; font-weight:700;">Live GD Session Invitation</p>
    </div>

    <p style="font-size:15px; font-weight:600; color:#0f172a; margin:0 0 12px 0;">Hello ${escapeHtml(recipient.displayName || 'Learner')},</p>
    <p style="font-size:14px; line-height:1.6; color:#475569; margin:0 0 18px 0;">
      <strong>${escapeHtml(inviter.displayName || 'A friend')}</strong> (User ID: #${inviter.userCode}) has invited you to join a <strong>${groupSize}-participant Group Discussion</strong> on VocaMate!
    </p>

    <div style="background:#f0f9ff; border:1px solid #bae6fd; border-radius:10px; padding:18px; margin-bottom:22px;">
      <div style="font-size:11.5px; font-weight:700; color:#0369a1; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:6px;">GD Topic</div>
      <div style="font-size:16px; font-weight:800; color:#0f172a; line-height:1.4;">${escapeHtml(topic || 'Trending Current Affairs & Technology')}</div>
      <div style="margin-top:10px; font-size:12.5px; color:#475569;">
        👥 Group Size: <strong>${groupSize} People</strong> • 🤖 AI Moderator: <strong>Live Moderation & Feedback</strong>
      </div>
    </div>

    <div style="text-align:center; margin:24px 0;">
      <a href="${joinUrl}" style="display:inline-block; background:#0284c7; color:#ffffff; font-size:14px; font-weight:700; text-decoration:none; padding:12px 30px; border-radius:8px;">Join Group Discussion</a>
    </div>

    <p style="font-size:12.5px; color:#64748b; text-align:center;">You can also open VocaMate and accept the invitation banner directly on your dashboard.</p>

    <div style="border-top:1px solid #e2e8f0; padding-top:16px; margin-top:24px; font-size:11.5px; color:#94a3b8; text-align:center; line-height:1.5;">
      VocaMate Learning Platform • AI Spoken English & Peer Practice<br>
      Automated invitation sent to ${escapeHtml(recipient.email)}.
    </div>
  </div>
</body>
</html>
  `.trim();

  const text = `
Hello ${recipient.displayName || 'Learner'},

${inviter.displayName} (#${inviter.userCode}) invited you to a ${groupSize}-person Group Discussion on VocaMate!

Topic: ${topic}
Join Link: ${joinUrl}

VocaMate Learning Platform
  `.trim();

  return sendEmail({
    to: recipient.email,
    subject,
    html,
    text,
    type: 'gd_invite',
    metadata: {
      inviterCode: inviter.userCode,
      recipientCode: recipient.userCode,
      gdRoomId,
      groupSize
    }
  });
}

/**
 * 6. Group Discussion (GD) Final Evaluation Report Email
 * Sent to each participant after the GD ends
 */
async function sendGdReportEmail({ user, gdData }) {
  if (!user || !user.email) throw new Error('User with registered email is required');

  const {
    topic = 'Group Discussion',
    groupSize = 4,
    participantReport = {}
  } = gdData || {};

  const {
    overallScore = 75,
    participation = 8,
    communication = 7,
    relevance = 8,
    confidence = 7,
    clarity = 8,
    leadership = 6,
    teamwork = 8,
    pointsMade = [],
    mistakes = [],
    suggestions = [],
    overallFeedback = ''
  } = participantReport;

  const subject = `VocaMate GD Report: "${topic.slice(0, 40)}" (Score: ${overallScore}/100)`;

  const pointsHtml = (pointsMade || []).map(p => `<li style="margin-bottom:6px; color:#0f172a;">${escapeHtml(p)}</li>`).join('') || '<li>Contributed substantive arguments</li>';
  const mistakesHtml = (mistakes || []).map(m => `<li style="margin-bottom:6px; color:#991b1b;">${escapeHtml(m)}</li>`).join('') || '<li>Keep working on structured transitions</li>';
  const suggestionsHtml = (suggestions || []).map(s => `<li style="margin-bottom:6px; color:#1e40af;">${escapeHtml(s)}</li>`).join('') || '<li>Take more initiative in summarizing key consensus points</li>';

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>GD Evaluation Report</title>
</head>
<body style="margin:0; padding:24px; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; background-color:#f1f5f9; color:#0f172a;">
  <div style="max-width:600px; margin:0 auto; background:#ffffff; border:1px solid #e2e8f0; border-radius:12px; padding:32px 28px; box-shadow:0 4px 16px rgba(0,0,0,0.04);">
    <div style="border-bottom:1px solid #e2e8f0; padding-bottom:18px; margin-bottom:20px;">
      <h2 style="margin:0; font-size:22px; font-weight:800; color:#0284c7;">VocaMate Group Discussion Report</h2>
      <p style="margin:4px 0 0 0; font-size:12px; color:#64748b; text-transform:uppercase; font-weight:700;">Individual AI Moderation & Performance Analysis</p>
    </div>

    <p style="font-size:15px; font-weight:600; color:#0f172a; margin:0 0 8px 0;">Hello ${escapeHtml(user.displayName || 'Participant')},</p>
    <p style="font-size:14px; line-height:1.6; color:#475569; margin:0 0 18px 0;">
      Here is your individual performance breakdown for the <strong>${groupSize}-person Group Discussion</strong> on:
      <br><strong style="color:#0f172a;">"${escapeHtml(topic)}"</strong>
    </p>

    <!-- Score Card -->
    <div style="background:linear-gradient(135deg, #0284c7 0%, #0369a1 100%); border-radius:12px; padding:20px; text-align:center; color:#ffffff; margin-bottom:22px;">
      <div style="font-size:12px; text-transform:uppercase; letter-spacing:1px; opacity:0.9;">Overall GD Performance Score</div>
      <div style="font-size:44px; font-weight:900; letter-spacing:-1px; margin:6px 0;">${overallScore}<span style="font-size:18px; font-weight:600; opacity:0.85;">/100</span></div>
    </div>

    <!-- Parameter Matrix -->
    <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:10px; padding:16px; margin-bottom:20px;">
      <h4 style="margin:0 0 12px 0; font-size:13.5px; color:#0f172a;">7-Metric Evaluation Matrix</h4>
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; font-size:12.5px;">
        <div style="padding:6px 10px; background:#fff; border-radius:6px; border:1px solid #e2e8f0;">📢 Participation: <strong>${participation}/10</strong></div>
        <div style="padding:6px 10px; background:#fff; border-radius:6px; border:1px solid #e2e8f0;">💬 Communication: <strong>${communication}/10</strong></div>
        <div style="padding:6px 10px; background:#fff; border-radius:6px; border:1px solid #e2e8f0;">🎯 Relevance: <strong>${relevance}/10</strong></div>
        <div style="padding:6px 10px; background:#fff; border-radius:6px; border:1px solid #e2e8f0;">🦁 Confidence: <strong>${confidence}/10</strong></div>
        <div style="padding:6px 10px; background:#fff; border-radius:6px; border:1px solid #e2e8f0;">💎 Clarity: <strong>${clarity}/10</strong></div>
        <div style="padding:6px 10px; background:#fff; border-radius:6px; border:1px solid #e2e8f0;">👑 Leadership: <strong>${leadership}/10</strong></div>
        <div style="padding:6px 10px; background:#fff; border-radius:6px; border:1px solid #e2e8f0; grid-column:span 2;">🤝 Listening & Teamwork: <strong>${teamwork}/10</strong></div>
      </div>
    </div>

    ${overallFeedback ? `
    <div style="background:#f0fdf4; border:1px solid #bbf7d0; border-radius:8px; padding:14px; margin-bottom:20px; font-size:13px; color:#166534; line-height:1.6;">
      <strong>Moderator Summary:</strong> ${escapeHtml(overallFeedback)}
    </div>
    ` : ''}

    <div style="margin-bottom:20px;">
      <h4 style="margin:0 0 8px 0; font-size:13.5px; color:#0f172a;">📌 Notable Points Made by You</h4>
      <ul style="margin:0; padding-left:20px; font-size:13px;">${pointsHtml}</ul>
    </div>

    <div style="margin-bottom:20px;">
      <h4 style="margin:0 0 8px 0; font-size:13.5px; color:#991b1b;">⚠️ Areas of Improvement & Mistakes</h4>
      <ul style="margin:0; padding-left:20px; font-size:13px;">${mistakesHtml}</ul>
    </div>

    <div style="margin-bottom:20px;">
      <h4 style="margin:0 0 8px 0; font-size:13.5px; color:#1e40af;">🚀 Targeted Recommendations</h4>
      <ul style="margin:0; padding-left:20px; font-size:13px;">${suggestionsHtml}</ul>
    </div>

    <div style="border-top:1px solid #e2e8f0; padding-top:16px; margin-top:24px; font-size:11.5px; color:#94a3b8; text-align:center; line-height:1.5;">
      VocaMate Learning Platform • AI Group Discussion Practice<br>
      Report dispatched to registered address ${escapeHtml(user.email)}.
    </div>
  </div>
</body>
</html>
  `.trim();

  const text = `
VocaMate GD Report
Topic: ${topic} (${groupSize} participants)
Overall Score: ${overallScore}/100

Participation: ${participation}/10 | Communication: ${communication}/10 | Relevance: ${relevance}/10
Confidence: ${confidence}/10 | Clarity: ${clarity}/10 | Leadership: ${leadership}/10 | Teamwork: ${teamwork}/10

Moderator Feedback:
${overallFeedback}

Points Made:
${(pointsMade || []).map(p => '- ' + p).join('\n')}

Suggestions:
${(suggestions || []).map(s => '- ' + s).join('\n')}

VocaMate Learning Platform
  `.trim();

  return sendEmail({
    to: user.email,
    subject,
    html,
    text,
    type: 'gd_report',
    metadata: {
      userId: user.id,
      userCode: user.userCode,
      topic,
      overallScore
    }
  });
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

module.exports = {
  sendEmail,
  sendLoginAlertEmail,
  sendPasswordResetEmail,
  sendVerificationEmail,
  sendInterviewReportEmail,
  sendGdInviteEmail,
  sendGdReportEmail,
  getEmailLogs,
  getEmailGatewayConfig,
  updateEmailGatewayConfig,
  verifyEmailGatewayConnection,
  sendTestEmail
};