// ============================================================
// db.js — lightweight local persistence layer (pure JavaScript,
// ZERO external dependencies)
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
      attachment: attachment || null,
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

function getExpiredAttachments(now = Date.now()) {
  try {
    return data.chatMessages
      .filter(m => m.attachment && !m.attachment.deleted && m.attachment.expiresAt <= now)
      .map(m => ({ messageId: m.id, attachment: m.attachment }));
  } catch (e) { console.error('DB getExpiredAttachments error:', e.message); return []; }
}

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

process.on('SIGTERM', saveNow);
process.on('SIGINT', saveNow);

module.exports = {
  saveMessage, getConversation,
  getExpiredAttachments, markAttachmentExpired,
  startCallRecord, endCallRecord,
  startSession, endSession, updateSessionName,
  getStats
};
