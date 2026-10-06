// ============================================================
// sheets.js — optional Google Sheets sync for the users table
//
// Every signup adds a row. Every "Change ID" updates that row.
// This is entirely OPTIONAL — the app works fully without it.
// PostgreSQL remains the real source of truth; the sheet is just a
// convenient, human-browsable mirror you can open in any browser
// and edit/delete rows from directly, same as any spreadsheet.
//
// Setup (see README.md for full step-by-step):
//   1. Create a Google Cloud project, enable the Sheets API.
//   2. Create a Service Account, generate a JSON key.
//   3. Create a Google Sheet, share it (Editor access) with the
//      service account's email (looks like xxx@xxx.iam.gserviceaccount.com).
//   4. Put the service account email + private key + sheet ID into
//      your .env (GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY,
//      GOOGLE_SHEET_ID).
//
// Without those three env vars set, this module quietly does
// nothing (logs one warning at startup) — the rest of the app is
// unaffected.
// ============================================================
const { google } = require('googleapis');
const crypto = require('crypto');

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME = process.env.GOOGLE_SHEET_NAME || 'Users';
const HEADER = ['User ID', 'Email', 'Name', 'Status', 'Signed Up (UTC)', 'Last Updated (UTC)'];

let sheetsClient = null;
let enabled = false;
let activeEmail = null;
let activeSheetName = SHEET_NAME;

function extractCredentials() {
  let email = (process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '').trim();
  let key = (process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || '').trim();

  // 1. If key or email contains full JSON service account, parse it
  for (const candidate of [key, email]) {
    if (candidate && candidate.startsWith('{')) {
      try {
        const obj = JSON.parse(candidate);
        if (obj.client_email) email = obj.client_email;
        if (obj.private_key) key = obj.private_key;
      } catch (e) {
        const em = candidate.match(/"client_email"\s*:\s*"([^"]+)"/);
        if (em) email = em[1];
        const km = candidate.match(/"private_key"\s*:\s*"([\s\S]*?)(?:"|\})/);
        if (km) key = km[1];
      }
    }
  }

  // 2. Fallback email extraction
  if (!email || !email.includes('@')) {
    const em = (key + ' ' + email).match(/"client_email"\s*:\s*"([^"]+)"/);
    if (em) email = em[1];
  }

  // 3. Extract and normalize PEM private key
  const pemMatch = key.match(/-----BEGIN [^-\n\r]+-----[\s\S]*?-----END [^-\n\r]+-----/);
  if (!pemMatch) {
    return { email, privateKey: null, error: 'No PEM private key block found' };
  }

  const pem = pemMatch[0];
  const header = (pem.match(/-----BEGIN [^-\n\r]+-----/) || ['-----BEGIN PRIVATE KEY-----'])[0];
  const footer = (pem.match(/-----END [^-\n\r]+-----/) || ['-----END PRIVATE KEY-----'])[0];

  // Try standard replacement first
  const stdPem = pem.replace(/\\n/g, '\n');
  try {
    crypto.createPrivateKey(stdPem);
    return { email, privateKey: stdPem };
  } catch (e) {}

  // Handle formatting anomalies (e.g. stray backslashes, \ln instead of \n)
  const lines = pem.split(/\\n|\n|\r/);
  const bodyLines = lines.slice(1, -1);
  const cleanedChunks = [];
  for (const line of bodyLines) {
    if (line.includes('\\')) {
      cleanedChunks.push(...line.split('\\').filter(Boolean));
    } else {
      cleanedChunks.push(line);
    }
  }
  const fullBase64 = cleanedChunks.join('').replace(/[^A-Za-z0-9+/=]/g, '');
  const formattedPem = header + '\n' + (fullBase64.match(/.{1,64}/g) || []).join('\n') + '\n' + footer;

  try {
    crypto.createPrivateKey(formattedPem);
    return { email, privateKey: formattedPem };
  } catch (err) {
    return { email, privateKey: null, error: err.message };
  }
}

function init() {
  if (!SHEET_ID) {
    console.warn('⚠️  Google Sheets sync not configured (optional) — set GOOGLE_SHEET_ID to enable it.');
    return;
  }

  const creds = extractCredentials();
  if (!creds.email || !creds.privateKey) {
    console.warn(`⚠️  Google Sheets sync disabled: ${creds.error || 'Missing or invalid service account credentials'}.`);
    return;
  }

  activeEmail = creds.email;

  try {
    const auth = new google.auth.JWT(activeEmail, null, creds.privateKey, ['https://www.googleapis.com/auth/spreadsheets']);
    sheetsClient = google.sheets({ version: 'v4', auth });
    enabled = true;
    ensureHeader();
    console.log('📊 Google Sheets sync enabled — new signups will appear automatically');
  } catch (e) {
    enabled = false;
    console.error('Google Sheets auth init error:', e.message);
  }
}

async function ensureHeader() {
  if (!enabled || !sheetsClient) return;
  try {
    // Check if the configured sheet tab exists
    try {
      const meta = await sheetsClient.spreadsheets.get({ spreadsheetId: SHEET_ID });
      const sheetsList = meta.data.sheets || [];
      const hasTarget = sheetsList.some(s => s.properties && s.properties.title === activeSheetName);
      if (!hasTarget && sheetsList.length > 0) {
        // Try creating the tab, or fallback to the first existing tab
        try {
          await sheetsClient.spreadsheets.batchUpdate({
            spreadsheetId: SHEET_ID,
            requestBody: {
              requests: [{ addSheet: { properties: { title: activeSheetName } } }]
            }
          });
        } catch (addErr) {
          activeSheetName = sheetsList[0].properties.title;
        }
      }
    } catch (metaErr) {
      // If meta fetch fails, handle in main error block
      throw metaErr;
    }

    await sheetsClient.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${activeSheetName}!A1:F1`,
      valueInputOption: 'RAW',
      requestBody: { values: [HEADER] }
    });
  } catch (e) {
    const msg = e.message || '';
    if (msg.includes('Google Sheets API has not been used') || msg.includes('disabled')) {
      const urlMatch = msg.match(/https:\/\/[^\s]+/);
      console.warn(`⚠️  Google Sheets API is not enabled in your Google Cloud project. Enable it at: ${urlMatch ? urlMatch[0] : 'https://console.developers.google.com/apis/api/sheets.googleapis.com/overview'}`);
    } else if (msg.includes('The caller does not have permission') || msg.includes('403')) {
      console.warn(`⚠️  Google Sheets permission error. Please share your Google Sheet (Editor access) with the service account: ${activeEmail}`);
    } else if (msg.includes('Requested entity was not found') || msg.includes('404')) {
      console.warn(`⚠️  Google Sheet not found. Please verify GOOGLE_SHEET_ID: ${SHEET_ID}`);
    } else {
      console.warn('⚠️  Google Sheet header setup notice:', msg);
    }
    // Disable active sync on setup failure so repeated operations don't throw errors
    enabled = false;
  }
}

async function findRowByUserId(userId) {
  if (!enabled || !sheetsClient) return null;
  try {
    const res = await sheetsClient.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${activeSheetName}!A2:A` });
    const rows = res.data.values || [];
    for (let i = 0; i < rows.length; i++) {
      if (rows[i][0] === userId) return i + 2; // +2: 1-indexed, plus the header row
    }
  } catch (e) {
    // Quietly ignore lookup failure
  }
  return null;
}

// Adds a new row for this user, or updates their existing row if the
// row is found by their CURRENT user_code.
async function upsertUser(user, previousUserCode) {
  if (!enabled || !sheetsClient) return;
  try {
    const lookupId = previousUserCode || user.userCode;
    const rowNum = await findRowByUserId(lookupId);
    const nowIso = new Date().toISOString();
    const status = user.isVerified ? 'Active/Verified' : 'Pending OTP';
    const values = [[
      user.userCode,
      user.email,
      user.displayName,
      status,
      user.createdAt ? new Date(user.createdAt).toISOString() : nowIso,
      nowIso
    ]];
    if (rowNum) {
      await sheetsClient.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `${activeSheetName}!A${rowNum}:F${rowNum}`,
        valueInputOption: 'RAW',
        requestBody: { values }
      });
    } else {
      await sheetsClient.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: `${activeSheetName}!A:F`,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values }
      });
    }
  } catch (e) {
    // Non-blocking sync error
  }
}

async function deleteUserRow(userId) {
  if (!enabled || !sheetsClient) return;
  try {
    const rowNum = await findRowByUserId(userId);
    if (!rowNum) return;
    const meta = await sheetsClient.spreadsheets.get({ spreadsheetId: SHEET_ID });
    const sheet = meta.data.sheets.find(s => s.properties.title === activeSheetName);
    if (!sheet) return;
    await sheetsClient.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: {
        requests: [{
          deleteDimension: {
            range: { sheetId: sheet.properties.sheetId, dimension: 'ROWS', startIndex: rowNum - 1, endIndex: rowNum }
          }
        }]
      }
    });
  } catch (e) {
    // Non-blocking delete error
  }
}

init();

module.exports = { upsertUser, deleteUserRow, isEnabled: () => enabled };
