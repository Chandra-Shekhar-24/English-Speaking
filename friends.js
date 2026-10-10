// ============================================================
// friends.js — VocaMate Friendships, Requests, Blocks,
// Call History, and Web Push Subscriptions
// ============================================================
const fs = require('fs');
const path = require('path');
const webpush = require('web-push');

const FRIENDS_DATA_FILE = path.join(__dirname, 'vocamate-friends.json');
const TMP_FILE = FRIENDS_DATA_FILE + '.tmp';

// Default empty store
let data = {
  friendRequests: [],
  friendships: [],
  blocks: [],
  reports: [],
  callLogs: [],
  pushSubscriptions: [],
  vapidKeys: null,
  nextRequestId: 1,
  nextFriendshipId: 1,
  nextBlockId: 1,
  nextReportId: 1,
  nextCallLogId: 1
};

function load() {
  try {
    if (fs.existsSync(FRIENDS_DATA_FILE)) {
      const raw = fs.readFileSync(FRIENDS_DATA_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      data = {
        friendRequests: Array.isArray(parsed.friendRequests) ? parsed.friendRequests : [],
        friendships: Array.isArray(parsed.friendships) ? parsed.friendships : [],
        blocks: Array.isArray(parsed.blocks) ? parsed.blocks : [],
        reports: Array.isArray(parsed.reports) ? parsed.reports : [],
        callLogs: Array.isArray(parsed.callLogs) ? parsed.callLogs : [],
        pushSubscriptions: Array.isArray(parsed.pushSubscriptions) ? parsed.pushSubscriptions : [],
        vapidKeys: parsed.vapidKeys || null,
        nextRequestId: parsed.nextRequestId || 1,
        nextFriendshipId: parsed.nextFriendshipId || 1,
        nextBlockId: parsed.nextBlockId || 1,
        nextReportId: parsed.nextReportId || 1,
        nextCallLogId: parsed.nextCallLogId || 1
      };
      console.log(`🤝 Friends data loaded: ${data.friendships.length} friendships, ${data.friendRequests.length} requests, ${data.callLogs.length} call logs`);
    } else {
      console.log('🤝 No existing friends file — starting fresh');
    }
  } catch (e) {
    console.error('Friends load error:', e.message);
  }

  // Ensure persistent VAPID keys for Web Push
  if (!data.vapidKeys || !data.vapidKeys.publicKey || !data.vapidKeys.privateKey) {
    try {
      const generated = webpush.generateVAPIDKeys();
      data.vapidKeys = generated;
      saveNow();
      console.log('🔑 Generated fresh VAPID keys for Web Push notifications');
    } catch (ve) {
      console.warn('VAPID generation warning:', ve.message);
    }
  }

  if (data.vapidKeys && data.vapidKeys.publicKey) {
    try {
      webpush.setVapidDetails(
        'mailto:support@vocamate.app',
        data.vapidKeys.publicKey,
        data.vapidKeys.privateKey
      );
      console.log('🔔 Web Push service initialized with VAPID ✅');
    } catch (e) {
      console.warn('Web Push setVapidDetails warning:', e.message);
    }
  }
}

let saveScheduled = false;
function scheduleSave() {
  if (saveScheduled) return;
  saveScheduled = true;
  setTimeout(() => {
    saveScheduled = false;
    saveNow();
  }, 60);
}

function saveNow() {
  try {
    fs.writeFileSync(TMP_FILE, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(TMP_FILE, FRIENDS_DATA_FILE);
  } catch (e) {
    console.error('Friends save error:', e.message);
  }
}

load();

function canonicalOrder(codeA, codeB) {
  const a = String(codeA || '').trim();
  const b = String(codeB || '').trim();
  return a < b ? [a, b] : [b, a];
}

// ============================================================
// RELATIONSHIPS & FRIENDSHIPS
// ============================================================
function areFriends(userCodeA, userCodeB) {
  const [a, b] = canonicalOrder(userCodeA, userCodeB);
  if (!a || !b || a === b) return false;
  return data.friendships.some(f => f.userA === a && f.userB === b);
}

function isBlocked(userCodeA, userCodeB) {
  const a = String(userCodeA || '').trim();
  const b = String(userCodeB || '').trim();
  if (!a || !b) return false;
  return data.blocks.some(bl =>
    (bl.blocker === a && bl.blocked === b) ||
    (bl.blocker === b && bl.blocked === a)
  );
}

function getRelationship(myCode, otherCode) {
  const me = String(myCode || '').trim();
  const other = String(otherCode || '').trim();
  if (!me || !other) return 'none';
  if (me === other) return 'self';

  const blockRecord = data.blocks.find(b =>
    (b.blocker === me && b.blocked === other) ||
    (b.blocker === other && b.blocked === me)
  );
  if (blockRecord) {
    return blockRecord.blocker === me ? 'blocked_by_me' : 'blocked_by_them';
  }

  if (areFriends(me, other)) return 'friends';

  const pendingOutgoing = data.friendRequests.find(r =>
    r.fromUser === me && r.toUser === other && r.status === 'pending'
  );
  if (pendingOutgoing) return 'pending_outgoing';

  const pendingIncoming = data.friendRequests.find(r =>
    r.fromUser === other && r.toUser === me && r.status === 'pending'
  );
  if (pendingIncoming) return 'pending_incoming';

  return 'none';
}

function sendFriendRequest(fromUser, toUser, fromName, toName) {
  const from = String(fromUser || '').trim();
  const to = String(toUser || '').trim();

  if (!from || !to) throw new Error('Valid User IDs are required');
  if (from === to) throw new Error('You cannot add yourself as a friend');
  if (isBlocked(from, to)) throw new Error('Cannot connect with this user');
  if (areFriends(from, to)) throw new Error('You are already friends with this user');

  // Check existing pending request
  const existing = data.friendRequests.find(r =>
    ((r.fromUser === from && r.toUser === to) || (r.fromUser === to && r.toUser === from)) &&
    r.status === 'pending'
  );
  if (existing) {
    if (existing.fromUser === from) {
      throw new Error('Friend request already sent and pending approval');
    } else {
      // The other user already sent a request to us -> auto-accept
      return acceptFriendRequest(existing.id, from);
    }
  }

  const req = {
    id: data.nextRequestId++,
    fromUser: from,
    toUser: to,
    fromName: fromName || `User #${from}`,
    toName: toName || `User #${to}`,
    status: 'pending',
    createdAt: Date.now(),
    respondedAt: null
  };
  data.friendRequests.push(req);
  scheduleSave();
  return { ok: true, request: req, autoAccepted: false };
}

function acceptFriendRequest(requestId, myUserCode) {
  const me = String(myUserCode || '').trim();
  const req = data.friendRequests.find(r => r.id === Number(requestId) && r.toUser === me && r.status === 'pending');
  if (!req) throw new Error('Friend request not found or already handled');

  req.status = 'accepted';
  req.respondedAt = Date.now();

  const [a, b] = canonicalOrder(req.fromUser, req.toUser);
  if (!data.friendships.some(f => f.userA === a && f.userB === b)) {
    data.friendships.push({
      id: data.nextFriendshipId++,
      userA: a,
      userB: b,
      userAName: req.fromUser === a ? req.fromName : req.toName,
      userBName: req.fromUser === b ? req.fromName : req.toName,
      createdAt: Date.now()
    });
  }

  scheduleSave();
  return { ok: true, friendCode: req.fromUser, friendName: req.fromName };
}

function declineFriendRequest(requestId, myUserCode) {
  const me = String(myUserCode || '').trim();
  const req = data.friendRequests.find(r => r.id === Number(requestId) && r.toUser === me && r.status === 'pending');
  if (!req) throw new Error('Friend request not found or already handled');

  req.status = 'rejected';
  req.respondedAt = Date.now();
  scheduleSave();
  return { ok: true };
}

function cancelFriendRequest(requestId, myUserCode) {
  const me = String(myUserCode || '').trim();
  const req = data.friendRequests.find(r => r.id === Number(requestId) && r.fromUser === me && r.status === 'pending');
  if (!req) throw new Error('Pending request not found');

  req.status = 'cancelled';
  req.respondedAt = Date.now();
  scheduleSave();
  return { ok: true };
}

function removeFriend(myUserCode, friendUserCode) {
  const [a, b] = canonicalOrder(myUserCode, friendUserCode);
  const initialLen = data.friendships.length;
  data.friendships = data.friendships.filter(f => !(f.userA === a && f.userB === b));
  if (data.friendships.length !== initialLen) {
    scheduleSave();
  }
  return { ok: true };
}

function blockUser(myUserCode, targetUserCode) {
  const me = String(myUserCode || '').trim();
  const target = String(targetUserCode || '').trim();
  if (!me || !target || me === target) throw new Error('Invalid user to block');

  // Remove friendship immediately
  removeFriend(me, target);

  // Cancel any pending requests
  data.friendRequests.forEach(r => {
    if (((r.fromUser === me && r.toUser === target) || (r.fromUser === target && r.toUser === me)) && r.status === 'pending') {
      r.status = 'cancelled';
      r.respondedAt = Date.now();
    }
  });

  if (!data.blocks.some(b => b.blocker === me && b.blocked === target)) {
    data.blocks.push({
      id: data.nextBlockId++,
      blocker: me,
      blocked: target,
      createdAt: Date.now()
    });
    scheduleSave();
  }
  return { ok: true };
}

function unblockUser(myUserCode, targetUserCode) {
  const me = String(myUserCode || '').trim();
  const target = String(targetUserCode || '').trim();
  const prevLen = data.blocks.length;
  data.blocks = data.blocks.filter(b => !(b.blocker === me && b.blocked === target));
  if (data.blocks.length !== prevLen) {
    scheduleSave();
  }
  return { ok: true };
}

function reportUser(myUserCode, targetUserCode, reason, details) {
  const me = String(myUserCode || '').trim();
  const target = String(targetUserCode || '').trim();
  if (!me || !target || me === target) throw new Error('Invalid user to report');

  const report = {
    id: data.nextReportId++,
    reporter: me,
    reported: target,
    reason: String(reason || 'other').trim(),
    details: String(details || '').trim().slice(0, 500),
    createdAt: Date.now()
  };
  data.reports.push(report);
  scheduleSave();
  return { ok: true, reportId: report.id };
}

function getFriendsList(myUserCode, liveUsersMap = new Map()) {
  const me = String(myUserCode || '').trim();
  const friendRecords = data.friendships.filter(f => f.userA === me || f.userB === me);

  return friendRecords.map(f => {
    const friendCode = f.userA === me ? f.userB : f.userA;
    const defaultName = f.userA === me ? f.userBName : f.userAName;
    const liveUser = liveUsersMap.get(friendCode);

    return {
      userCode: friendCode,
      displayName: (liveUser && liveUser.userName) || defaultName || `Friend #${friendCode}`,
      online: Boolean(liveUser && liveUser.connected),
      busy: Boolean(liveUser && liveUser.busy),
      peerId: (liveUser && liveUser.peerId) || null,
      friendsSince: f.createdAt
    };
  });
}

function getFriendRequests(myUserCode) {
  const me = String(myUserCode || '').trim();
  const incoming = data.friendRequests.filter(r => r.toUser === me && r.status === 'pending');
  const outgoing = data.friendRequests.filter(r => r.fromUser === me && r.status === 'pending');

  return { incoming, outgoing };
}

function getBlockedList(myUserCode) {
  const me = String(myUserCode || '').trim();
  return data.blocks.filter(b => b.blocker === me).map(b => b.blocked);
}

// ============================================================
// CALL HISTORY & MISSED CALLS
// ============================================================
function logCallRecord({ callId, caller, target, callerName, targetName, mediaType, status, durationSeconds }) {
  try {
    const record = {
      id: data.nextCallLogId++,
      callId: callId || `call_${Date.now()}`,
      caller: String(caller || '').trim(),
      target: String(target || '').trim(),
      callerName: callerName || `User #${caller}`,
      targetName: targetName || `User #${target}`,
      mediaType: mediaType === 'video' ? 'video' : 'voice',
      status: status || 'completed', // 'completed' | 'missed' | 'declined' | 'cancelled'
      startedAt: Date.now() - (durationSeconds ? durationSeconds * 1000 : 0),
      endedAt: Date.now(),
      durationSeconds: Number(durationSeconds) || 0
    };
    data.callLogs.unshift(record);
    if (data.callLogs.length > 3000) {
      data.callLogs.splice(3000);
    }
    scheduleSave();
    return record;
  } catch (e) {
    console.error('logCallRecord error:', e.message);
    return null;
  }
}

function getCallHistory(myUserCode, limit = 50) {
  const me = String(myUserCode || '').trim();
  return data.callLogs
    .filter(c => c.caller === me || c.target === me)
    .slice(0, limit)
    .map(c => ({
      ...c,
      direction: c.caller === me ? 'outgoing' : 'incoming',
      isMissed: c.target === me && (c.status === 'missed' || c.status === 'declined'),
      peerCode: c.caller === me ? c.target : c.caller,
      peerName: c.caller === me ? c.targetName : c.callerName
    }));
}

function getMissedCallsCount(myUserCode) {
  const me = String(myUserCode || '').trim();
  return data.callLogs.filter(c => c.target === me && c.status === 'missed').length;
}

// ============================================================
// WEB PUSH & FCM SERVICE WORKER INTEGRATION
// ============================================================
function getVapidPublicKey() {
  return data.vapidKeys ? data.vapidKeys.publicKey : null;
}

function savePushSubscription(userCode, subscription) {
  const code = String(userCode || '').trim();
  if (!code || !subscription || !subscription.endpoint) return;

  // Remove existing subscription with same endpoint
  data.pushSubscriptions = data.pushSubscriptions.filter(s => s.endpoint !== subscription.endpoint);
  data.pushSubscriptions.push({
    userCode: code,
    endpoint: subscription.endpoint,
    subscription,
    updatedAt: Date.now()
  });
  scheduleSave();
}

function removePushSubscription(endpoint) {
  if (!endpoint) return;
  const initial = data.pushSubscriptions.length;
  data.pushSubscriptions = data.pushSubscriptions.filter(s => s.endpoint !== endpoint);
  if (data.pushSubscriptions.length !== initial) {
    scheduleSave();
  }
}

async function sendCallPushNotification(targetUserCode, { callId, fromUser, fromName, isVideo }) {
  const target = String(targetUserCode || '').trim();
  const subs = data.pushSubscriptions.filter(s => s.userCode === target);
  if (subs.length === 0) return { deliveredCount: 0 };

  const payload = JSON.stringify({
    title: `📞 Incoming ${isVideo ? 'Video' : 'Voice'} Call`,
    body: `${fromName || 'Friend'} (#${fromUser}) is calling you on VocaMate`,
    icon: '/favicon.ico',
    badge: '/favicon.ico',
    tag: `incoming-call-${callId}`,
    requireInteraction: true,
    data: {
      callId,
      fromUser,
      fromName,
      isVideo: Boolean(isVideo),
      type: 'incoming_call',
      url: `/?answerCall=${encodeURIComponent(callId)}`
    }
  });

  let deliveredCount = 0;
  for (const item of subs) {
    try {
      await webpush.sendNotification(item.subscription, payload, {
        TTL: 45 // 45 seconds ringing TTL
      });
      deliveredCount++;
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        // Expired subscription -> clean up
        removePushSubscription(item.endpoint);
      }
    }
  }

  return { deliveredCount };
}

function getProfile(myUserCode, targetUserCode, liveUser = null, dbUser = null) {
  const me = String(myUserCode || '').trim();
  const target = String(targetUserCode || '').trim();
  const rel = getRelationship(me, target);

  let pendingRequestId = null;
  if (rel === 'pending_incoming' || rel === 'pending_outgoing') {
    const req = data.friendRequests.find(r =>
      ((r.fromUser === me && r.toUser === target) || (r.fromUser === target && r.toUser === me)) &&
      r.status === 'pending'
    );
    if (req) pendingRequestId = req.id;
  }

  const isFriend = rel === 'friends';
  return {
    userCode: target,
    displayName: (liveUser && liveUser.userName) || (dbUser && dbUser.display_name) || `User #${target}`,
    online: Boolean(liveUser && liveUser.connected),
    busy: Boolean(liveUser && liveUser.busy),
    peerId: (liveUser && liveUser.peerId) || null,
    relationship: rel,
    isFriend,
    canCall: isFriend && Boolean(liveUser && liveUser.connected && !liveUser.busy),
    pendingRequestId
  };
}

process.on('SIGTERM', saveNow);
process.on('SIGINT', saveNow);

module.exports = {
  areFriends,
  isBlocked,
  getRelationship,
  getProfile,
  sendFriendRequest,
  acceptFriendRequest,
  declineFriendRequest,
  cancelFriendRequest,
  removeFriend,
  blockUser,
  unblockUser,
  reportUser,
  getFriendsList,
  getFriendRequests,
  getBlockedList,
  logCallRecord,
  getCallHistory,
  getMissedCallsCount,
  getVapidPublicKey,
  savePushSubscription,
  removePushSubscription,
  sendCallPushNotification
};
