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

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME = process.env.GOOGLE_SHEET_NAME || 'Users';
const HEADER = ['User ID', 'Email', 'Name', 'Signed Up (UTC)', 'Last Updated (UTC)'];

let sheetsClient = null;
let enabled = false;

function init() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const rawKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;
  if (!email || !rawKey || !SHEET_ID) {
    console.warn('⚠️  Google Sheets sync not configured (optional) — set GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY, GOOGLE_SHEET_ID in .env to enable it.');
    return;
  }
  try {
    // .env can't hold real newlines, so the private key is stored with
    // literal "\n" sequences — convert them back before use.
    const privateKey = rawKey.replace(/\\n/g, '\n');
    const auth = new google.auth.JWT(email, null, privateKey, ['https://www.googleapis.com/auth/spreadsheets']);
    sheetsClient = google.sheets({ version: 'v4', auth });
    enabled = true;
    ensureHeader();
    console.log('📊 Google Sheets sync enabled — new signups will appear automatically');
  } catch (e) {
    console.error('Google Sheets init error:', e.message);
  }
}

async function ensureHeader() {
  if (!enabled) return;
  try {
    await sheetsClient.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!A1:E1`,
      valueInputOption: 'RAW',
      requestBody: { values: [HEADER] }
    });
  } catch (e) { console.error('Sheet header setup error (check the sheet name/tab and sharing permissions):', e.message); }
}

async function findRowByUserId(userId) {
  const res = await sheetsClient.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${SHEET_NAME}!A2:A` });
  const rows = res.data.values || [];
  for (let i = 0; i < rows.length; i++) {
    if (rows[i][0] === userId) return i + 2; // +2: 1-indexed, plus the header row
  }
  return null;
}

// Adds a new row for this user, or updates their existing row if the
// row is found by their CURRENT user_code. Pass previousUserCode when
// the ID itself just changed (e.g. via "Change ID"), so we find the
// old row by its old ID and rewrite it with the new one — otherwise
// a lookup by the new ID would find nothing and create a duplicate row.
async function upsertUser(user, previousUserCode) {
  if (!enabled) return;
  try {
    const lookupId = previousUserCode || user.userCode;
    const rowNum = await findRowByUserId(lookupId);
    const nowIso = new Date().toISOString();
    const values = [[
      user.userCode,
      user.email,
      user.displayName,
      user.createdAt ? new Date(user.createdAt).toISOString() : nowIso,
      nowIso
    ]];
    if (rowNum) {
      await sheetsClient.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `${SHEET_NAME}!A${rowNum}:E${rowNum}`,
        valueInputOption: 'RAW',
        requestBody: { values }
      });
    } else {
      await sheetsClient.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: `${SHEET_NAME}!A:E`,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values }
      });
    }
  } catch (e) { console.error('Sheet upsert error:', e.message); }
}

async function deleteUserRow(userId) {
  if (!enabled) return;
  try {
    const rowNum = await findRowByUserId(userId);
    if (!rowNum) return;
    const meta = await sheetsClient.spreadsheets.get({ spreadsheetId: SHEET_ID });
    const sheet = meta.data.sheets.find(s => s.properties.title === SHEET_NAME);
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
  } catch (e) { console.error('Sheet delete error:', e.message); }
}

init();

module.exports = { upsertUser, deleteUserRow, isEnabled: () => enabled };
