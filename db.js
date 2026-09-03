// ============================================================
// db.js — lightweight local persistence layer (pure JavaScript,
// ZERO external dependencies)
//
// Why not better-sqlite3? It's a native C++ addon that has to be
// compiled on the host machine (node-gyp/make). Many hosting
// platforms (Render, some Docker images, newer Node versions) fail
// that build step with V8 API mismatches, which is exactly what
// happened here. This version uses only Node's built-in `fs` module
// and a plain JSON file, so there is nothing to compile, ever — it
// works identically on every platform.
//
// Storage: a single JSON file (english-passport-data.json) next to
// this module, holding three arrays: chatMessages, callHistory,
// userSessions. Writes are synchronous and atomic (write to a temp
// file, then rename) so a crash mid-write can't corrupt the file.
//
// Scope note: this persists chat messages and call/session records.
// User IDs themselves are still generated fresh per connection (the
// app's existing "temporary 4-digit ID" design) — this module does
// NOT add login/accounts/permanent identity. That would be a
// separate, bigger feature (auth, password/OTP, etc.).
// ============================================================
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'english-passport-data.json');
const TMP_FILE = DATA_FILE + '.tmp';
const MAX_MESSAGES = 5000; // prevent unbounded file growth over time
const MAX_CALLS = 2000;
const MAX_SESSIONS = 2000;

let data = { chatMessages: [], callHistory: [], userSessions: [], nextCallId: 1, nextSessionId: 1, nextMessageId: 1 };

function load() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      data = {
        chatMessages: Array.isArray(parsed.chatMessages) ? parsed.chatMessages : [],
        callHistory: Array.isArray(parsed.callHistory) ? parsed.callHistory : [],
        userSessions: Array.isArray(parsed.userSessions) ? parsed.userSessions : [],
        nextCallId: parsed.nextCallId || 1,
        nextSessionId: parsed.nextSessionId || 1,
        nextMessageId: parsed.nextMessageId || 1
      };
      console.log(`💾 Database loaded: ${data.chatMessages.length} messages, ${data.callHistory.length} call records`);
    } else {
      console.log('💾 No existing database file — starting fresh');
    }
  } catch (e) {
    console.error('DB load error (starting with empty store):', e.message);
  }
}

let saveScheduled = false;
function scheduleSave() {
  // Debounce writes slightly so a burst of messages doesn't hit disk
  // once per message — still effectively immediate (well under 100ms).
  if (saveScheduled) return;
  saveScheduled = true;
  setTimeout(() => {
    saveScheduled = false;
    saveNow();
  }, 50);
}

function saveNow() {
  try {
    fs.writeFileSync(TMP_FILE, JSON.stringify(data), 'utf8');
    fs.renameSync(TMP_FILE, DATA_FILE);
  } catch (e) {
    console.error('DB save error:', e.message);
  }
}

load();

function saveMessage(fromUser, toUser, fromName, text, attachment) {
  try {
    const id = data.nextMessageId++;
    const record = {
      id, fromUser, toUser, fromName: fromName || null, text,
      attachment: attachment || null, // { url, publicId, resourceType, type, filename, size, mimeType, expiresAt, deleted }
      createdAt: Date.now()
    };
    data.chatMessages.push(record);
    if (data.chatMessages.length > MAX_MESSAGES) {
      data.chatMessages.splice(0, data.chatMessages.length - MAX_MESSAGES);
    }
    scheduleSave();
    return record;
  } catch (e) { console.error('DB saveMessage error:', e.message); return null; }
}

function getConversation(userA, userB, limit = 200) {
  try {
    const matches = data.chatMessages.filter(m =>
      (m.fromUser === userA && m.toUser === userB) || (m.fromUser === userB && m.toUser === userA)
    );
    return matches.slice(-limit);
  } catch (e) { console.error('DB getConversation error:', e.message); return []; }
}

// Returns every message whose attachment has passed its expiry and
// hasn't been cleaned up yet — used by media.js's background job to
// actually delete the underlying file (not just hide it in the UI).
function getExpiredAttachments(now = Date.now()) {
  try {
    return data.chatMessages
      .filter(m => m.attachment && !m.attachment.deleted && m.attachment.expiresAt <= now)
      .map(m => ({ messageId: m.id, attachment: m.attachment }));
  } catch (e) { console.error('DB getExpiredAttachments error:', e.message); return []; }
}

// Marks a message's attachment as expired: clears the (now-deleted)
// URL but keeps filename/type so the UI can still show a meaningful
// "Attachment expired" bubble instead of a broken link.
function markAttachmentExpired(messageId) {
  try {
    const record = data.chatMessages.find(m => m.id === messageId);
    if (record && record.attachment) {
      record.attachment.deleted = true;
      record.attachment.url = null;
      scheduleSave();
    }
  } catch (e) { console.error('DB markAttachmentExpired error:', e.message); }
}

function startCallRecord(callType, mediaType, participantIds) {
  try {
    const id = data.nextCallId++;
    data.callHistory.push({
      id, callType, mediaType, participants: participantIds.join(','),
      startedAt: Date.now(), endedAt: null, durationSeconds: null
    });
    if (data.callHistory.length > MAX_CALLS) {
      data.callHistory.splice(0, data.callHistory.length - MAX_CALLS);
    }
    scheduleSave();
    return id;
  } catch (e) { console.error('DB startCallRecord error:', e.message); return null; }
}

function endCallRecord(recordId, startedAt) {
  if (!recordId) return;
  try {
    const record = data.callHistory.find(c => c.id === recordId);
    if (record) {
      record.endedAt = Date.now();
      record.durationSeconds = Math.max(0, Math.round((record.endedAt - startedAt) / 1000));
      scheduleSave();
    }
  } catch (e) { console.error('DB endCallRecord error:', e.message); }
}

function startSession(userId, userName) {
  try {
    const id = data.nextSessionId++;
    data.userSessions.push({ id, userId, userName: userName || null, connectedAt: Date.now(), disconnectedAt: null });
    if (data.userSessions.length > MAX_SESSIONS) {
      data.userSessions.splice(0, data.userSessions.length - MAX_SESSIONS);
    }
    scheduleSave();
    return id;
  } catch (e) { console.error('DB startSession error:', e.message); return null; }
}

function endSession(sessionRecordId) {
  if (!sessionRecordId) return;
  try {
    const record = data.userSessions.find(s => s.id === sessionRecordId);
    if (record) { record.disconnectedAt = Date.now(); scheduleSave(); }
  } catch (e) { console.error('DB endSession error:', e.message); }
}

function updateSessionName(sessionRecordId, userName) {
  if (!sessionRecordId) return;
  try {
    const record = data.userSessions.find(s => s.id === sessionRecordId);
    if (record) { record.userName = userName; scheduleSave(); }
  } catch (e) { console.error('DB updateSessionName error:', e.message); }
}

function getStats() {
  try {
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    return {
      totalMessages: data.chatMessages.length,
      totalCalls: data.callHistory.length,
      sessionsLast24h: data.userSessions.filter(s => s.connectedAt >= oneDayAgo).length
    };
  } catch (e) { return { totalMessages: 0, totalCalls: 0, sessionsLast24h: 0 }; }
}

// Flush any pending debounced write on graceful shutdown, so nothing
// from the last few messages before a deploy/restart is lost.
process.on('SIGTERM', saveNow);
process.on('SIGINT', saveNow);

module.exports = {
  saveMessage, getConversation,
  getExpiredAttachments, markAttachmentExpired,
  startCallRecord, endCallRecord,
  startSession, endSession, updateSessionName,
  getStats
};
