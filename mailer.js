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

  const smtpHost = (cfg.smtpHost || process.env.SMTP_HOST || process.env.EMAIL_HOST || '').trim();
  const smtpUser = (cfg.smtpUser || process.env.SMTP_USER || process.env.EMAIL_USER || '').trim();
  const smtpPass = (cfg.smtpPass || process.env.SMTP_PASS || process.env.EMAIL_PASS || '').trim();
  const smtpPort = parseInt(cfg.smtpPort || process.env.SMTP_PORT || process.env.EMAIL_PORT || '587', 10);
  const smtpSecure = cfg.smtpSecure === true || process.env.SMTP_SECURE === 'true' || smtpPort === 465;

  const gmailUser = (cfg.gmailUser || process.env.GMAIL_USER || '').trim();
  // Strip whitespace from Gmail App Passwords (e.g. "abcd efgh ijkl mnop" -> "abcdefghijklmnop")
  const rawGmailPass = (cfg.gmailAppPassword || process.env.GMAIL_APP_PASSWORD || '').trim();
  const cleanGmailPass = rawGmailPass.replace(/\s+/g, '');

  if (gmailUser && cleanGmailPass) {
    smtpTransporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      family: 4, // CRITICAL FOR RENDER: forces IPv4 to avoid Render's 30s IPv6 hang
      pool: true, // Keep connection pool warm for sub-second email dispatch
      maxConnections: 3,
      maxMessages: 100,
      connectionTimeout: 5000,
      greetingTimeout: 4000,
      socketTimeout: 8000,
      auth: {
        user: gmailUser,
        pass: cleanGmailPass
      }
    });
    console.log(`📧 Gmail SMTP Transporter initialized (${gmailUser}) with pooled IPv4 ✅`);
  } else if (smtpHost && smtpUser && smtpPass) {
    smtpTransporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpSecure,
      family: 4, // Force IPv4
      pool: true,
      maxConnections: 3,
      maxMessages: 100,
      connectionTimeout: 5000,
      greetingTimeout: 4000,
      socketTimeout: 8000,
      auth: { user: smtpUser, pass: smtpPass }
    });
    console.log(`📧 SMTP Transporter initialized (${smtpHost}:${smtpPort} as ${smtpUser}) with pooled IPv4 ✅`);
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

function getSenderAddress(targetProvider) {
  const cfg = loadEmailConfig();
  const gmailUser = (cfg.gmailUser || process.env.GMAIL_USER || '').trim();
  const smtpUser = (cfg.smtpUser || process.env.SMTP_USER || '').trim();

  // If using SMTP/Gmail, From MUST match the authenticated user to pass SPF/DKIM/DMARC
  if (targetProvider === 'smtp' || targetProvider === 'gmail' || (!targetProvider && smtpTransporter)) {
    const user = gmailUser || smtpUser;
    if (user) {
      return `VocaMate <${user}>`;
    }
  }

  // If custom verified domain is configured
  if (cfg.fromEmail && cfg.fromEmail.trim() && !cfg.fromEmail.includes('resend.dev') && !cfg.fromEmail.includes('yourdomain.com')) {
    return cfg.fromEmail.trim();
  }
  const envFrom = (process.env.EMAIL_FROM || '').trim();
  if (envFrom && !envFrom.includes('resend.dev') && !envFrom.includes('yourdomain.com') && !envFrom.includes('example.com')) {
    return envFrom;
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
  return 'chandrashekharbansal.2006@gmail.com';
}

function getResendApiKey() {
  const cfg = loadEmailConfig();
  return (cfg.resendApiKey || process.env.RESEND_API_KEY || '').trim();
}

/**
 * Core sendEmail dispatcher with Anti-Spam compliance
 */
async function sendEmail({ to, subject, html, text, type = 'general', metadata = {} }) {
  const emailId = `mail_${Date.now()}_${nextEmailId++}`;
  const timestamp = new Date().toISOString();
  const resendApiKey = getResendApiKey();
  const replyTo = getReplyToAddress();

  const activeProvider = smtpTransporter ? 'smtp' : (resendApiKey ? 'resend' : 'console_fallback');
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

  // 1) Try SMTP first if configured (delivers to ANY recipient address worldwide)
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
        setTimeout(() => reject(new Error('SMTP send timed out after 6s')), 6000)
      );
      const info = await Promise.race([sendPromise, timeoutPromise]);
      console.log(`✅ [SMTP EMAIL DELIVERED] to: ${to} | ID: ${info.messageId} | "${subject}"`);
      logEntry.status = 'sent';
      logEntry.provider = 'smtp';
      logEntry.from = smtpFrom;
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

        // If Resend failed because of sandbox restrictions (recipient is not owner)
        // Relay a notification copy to the Resend account owner in the background
        const ownerEmail = 'chandrashekharbansal.2006@gmail.com';
        if (isSandboxRestriction && to.toLowerCase() !== ownerEmail.toLowerCase()) {
          console.log(`📨 [RESEND SANDBOX RELAY] Queuing OTP copy to owner ${ownerEmail} for user ${to}...`);
          fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${resendApiKey}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              from: 'VocaMate <onboarding@resend.dev>',
              to: ownerEmail,
              subject: `[VocaMate Relay] OTP for ${to}: ${metadata.otp || 'Action Required'}`,
              html: `
                <div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif; padding:24px; background:#f8fafc; color:#1e293b; border-radius:12px; border:1px solid #e2e8f0; max-width:520px; margin:0 auto;">
                  <h3 style="color:#0284c7; margin-top:0;">VocaMate Email Gateway Relay</h3>
                  <p style="font-size:14px; color:#475569;">A user initiated verification with email: <strong style="color:#0f172a;">${to}</strong></p>
                  <div style="background:#fffbeb; border:1px solid #fde68a; padding:12px 16px; border-radius:8px; margin:16px 0;">
                    <p style="margin:0 0 6px 0; color:#b45309; font-weight:700; font-size:13px;">Why this went to your inbox instead of ${to}:</p>
                    <p style="margin:0; font-size:12.5px; color:#78350f; line-height:1.5;">Resend is currently in free sandbox mode and only sends to your registered email (${ownerEmail}).</p>
                  </div>
                  <div style="background:#f0f9ff; border:2px dashed #38bdf8; border-radius:10px; padding:16px; text-align:center; margin:18px 0;">
                    <div style="font-size:11px; color:#64748b; text-transform:uppercase; font-weight:700; letter-spacing:1px;">6-Digit OTP for ${to}</div>
                    <div style="font-size:32px; font-weight:900; color:#0284c7; letter-spacing:6px; font-family:monospace; margin-top:6px;">${metadata.otp || 'N/A'}</div>
                  </div>
                  <p style="font-size:12px; color:#64748b; line-height:1.5;">To send directly to ANY email without restrictions, configure free <strong>Gmail SMTP</strong> in VocaMate Admin &rarr; Email Gateway.</p>
                </div>
              `
            })
          }).catch(relayErr => console.warn('⚠️ [RESEND SANDBOX RELAY FAILED]:', relayErr.message));
        }

        return {
          ok: false,
          delivered: false,
          sandboxRestricted: isSandboxRestriction,
          error: errMsg,
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
  const gmailUser = (cfg.gmailUser || process.env.GMAIL_USER || '').trim();
  const rawGmailPass = (cfg.gmailAppPassword || process.env.GMAIL_APP_PASSWORD || '').trim();
  const cleanGmailPass = rawGmailPass.replace(/\s+/g, '');

  if (gmailUser && cleanGmailPass) {
    if (!smtpTransporter) {
      initTransporters();
    }
    if (smtpTransporter) {
      try {
        const verifyPromise = smtpTransporter.verify();
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Connection check timed out after 6s')), 6000)
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
        setTimeout(() => reject(new Error('Connection check timed out after 6s')), 6000)
      );
      await Promise.race([verifyPromise, timeoutPromise]);
      return { ok: true, connected: true, provider: 'custom_smtp', message: 'Connected to custom SMTP server' };
    } catch (err) {
      return { ok: false, connected: false, provider: 'custom_smtp', error: err.message };
    }
  }
  return { ok: false, connected: false, message: 'Gmail SMTP credentials not fully configured (needs email & 16-character App Password)' };
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

module.exports = {
  sendEmail,
  sendLoginAlertEmail,
  sendPasswordResetEmail,
  sendVerificationEmail,
  getEmailLogs,
  getEmailGatewayConfig,
  updateEmailGatewayConfig,
  verifyEmailGatewayConnection,
  sendTestEmail
};