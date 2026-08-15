require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  pingTimeout: 60000,
  pingInterval: 25000
});

const API_KEY = process.env.GROQ_API_KEY || "your_api_key_here";
const MODEL = "llama-3.1-8b-instant";

// ============================================================
// STORES
// ============================================================
const textChatMemory = new Map();      // userId -> { messages: [], corrections: {} }
const voiceChatMemory = new Map();     // userId -> { messages: [], corrections: {} }
const users = new Map();
const userIdPool = new Set();
const activeCalls = new Map();
const pendingCallRequests = new Map();
const groupRooms = new Map(); // roomId -> { host, isVideo, participants: Map(userId -> {peerId, userName}), pendingInvites: Set(userId) }

// ============================================================
// CONVERSATION FUNCTIONS - messages WITHOUT extra properties
// ============================================================
function getTextConversation(userId) {
  if (!textChatMemory.has(userId)) {
    textChatMemory.set(userId, {
      messages: [],        // Only { role, content }
      corrections: {},     // { messageIndex: { original, corrected, wordChanges, explanation } }
      context: {},
      topic: null,
      facts: {},
      conversationStarted: false,
      userName: null
    });
  }
  return textChatMemory.get(userId);
}

function getVoiceConversation(userId) {
  if (!voiceChatMemory.has(userId)) {
    voiceChatMemory.set(userId, {
      messages: [],
      corrections: {},
      context: {},
      topic: null,
      facts: {},
      conversationStarted: false,
      userName: null
    });
  }
  return voiceChatMemory.get(userId);
}

// Add message WITHOUT extra properties
function addTextMessage(userId, role, content) {
  const conv = getTextConversation(userId);
  const index = conv.messages.length;
  conv.messages.push({ role, content });
  if (conv.messages.length > 50) conv.messages = conv.messages.slice(-50);
  return index;
}

function addVoiceMessage(userId, role, content) {
  const conv = getVoiceConversation(userId);
  const index = conv.messages.length;
  conv.messages.push({ role, content });
  if (conv.messages.length > 50) conv.messages = conv.messages.slice(-50);
  return index;
}

// Store correction separately
function storeTextCorrection(userId, messageIndex, correctionData) {
  const conv = getTextConversation(userId);
  conv.corrections[messageIndex] = correctionData;
}

function storeVoiceCorrection(userId, messageIndex, correctionData) {
  const conv = getVoiceConversation(userId);
  conv.corrections[messageIndex] = correctionData;
}

function getTextCorrection(userId, messageIndex) {
  const conv = getTextConversation(userId);
  return conv.corrections[messageIndex] || null;
}

function getVoiceCorrection(userId, messageIndex) {
  const conv = getVoiceConversation(userId);
  return conv.corrections[messageIndex] || null;
}

function getTextMessages(userId, count = 20) {
  const conv = getTextConversation(userId);
  return conv.messages.slice(-count);
}

function getVoiceMessages(userId, count = 20) {
  const conv = getVoiceConversation(userId);
  return conv.messages.slice(-count);
}

function generateUniqueId() {
  let id;
  let attempts = 0;
  do {
    id = String(Math.floor(1000 + Math.random() * 9000));
    attempts++;
  } while (userIdPool.has(id) && attempts < 100);
  userIdPool.add(id);
  return id;
}

// ============================================================
// 20 VOICES
// ============================================================
const VOICES = {
  male: [
    { id: 'en-IN-PrabhatNeural', name: 'Prabhat', gender: 'Male', style: 'Professional', description: 'Clear, articulate Indian English', emoji: '💼' },
    { id: 'en-IN-AaravNeural', name: 'Aarav', gender: 'Male', style: 'Friendly', description: 'Warm, conversational Indian accent', emoji: '😊' },
    { id: 'en-IN-VikramNeural', name: 'Vikram', gender: 'Male', style: 'Calm', description: 'Smooth, confident Indian voice', emoji: '🧘' },
    { id: 'en-IN-RahulNeural', name: 'Rahul', gender: 'Male', style: 'Energetic', description: 'Young, enthusiastic speaker', emoji: '⚡' },
    { id: 'en-IN-AdityaNeural', name: 'Aditya', gender: 'Male', style: 'Deep', description: 'Rich, commanding Indian English', emoji: '🎙️' },
    { id: 'en-IN-AmitNeural', name: 'Amit', gender: 'Male', style: 'Teacher', description: 'Patient, crystal clear pronunciation', emoji: '👨‍🏫' },
    { id: 'en-IN-RohanNeural', name: 'Rohan', gender: 'Male', style: 'Casual', description: 'Relaxed, everyday conversation', emoji: '🏏' },
    { id: 'en-IN-KabirNeural', name: 'Kabir', gender: 'Male', style: 'Authoritative', description: 'Strong, professional Indian voice', emoji: '📊' },
    { id: 'en-IN-ManishNeural', name: 'Manish', gender: 'Male', style: 'Motivational', description: 'Encouraging, inspiring speaker', emoji: '💪' },
    { id: 'en-IN-ArjunNeural', name: 'Arjun', gender: 'Male', style: 'Warm', description: 'Gentle, reassuring Indian accent', emoji: '🌿' }
  ],
  female: [
    { id: 'en-IN-NeerjaNeural', name: 'Neerja', gender: 'Female', style: 'Warm', description: 'Friendly, welcoming Indian English', emoji: '🤗' },
    { id: 'en-IN-PriyaNeural', name: 'Priya', gender: 'Female', style: 'Professional', description: 'Clear, corporate Indian voice', emoji: '👩‍💼' },
    { id: 'en-IN-SimranNeural', name: 'Simran', gender: 'Female', style: 'Cheerful', description: 'Young, lively conversationalist', emoji: '✨' },
    { id: 'en-IN-KavyaNeural', name: 'Kavya', gender: 'Female', style: 'Calm', description: 'Soothing, peaceful Indian accent', emoji: '🪷' },
    { id: 'en-IN-MeeraNeural', name: 'Meera', gender: 'Female', style: 'Teacher', description: 'Patient, clear educational voice', emoji: '👩‍🏫' },
    { id: 'en-IN-RituNeural', name: 'Ritu', gender: 'Female', style: 'Friendly', description: 'Approachable, warm Indian voice', emoji: '🌸' },
    { id: 'en-IN-AnanyaNeural', name: 'Ananya', gender: 'Female', style: 'Energetic', description: 'Vibrant, enthusiastic speaker', emoji: '🔥' },
    { id: 'en-IN-DeepaNeural', name: 'Deepa', gender: 'Female', style: 'Professional', description: 'Articulate, clear Indian English', emoji: '📚' },
    { id: 'en-IN-SoniaNeural', name: 'Sonia', gender: 'Female', style: 'Soft', description: 'Gentle, motherly Indian voice', emoji: '🌺' },
    { id: 'en-IN-TaraNeural', name: 'Tara', gender: 'Female', style: 'Confident', description: 'Bold, charismatic Indian accent', emoji: '🌟' }
  ]
};

// ============================================================
// EMOTION DETECTION
// ============================================================
function detectEmotion(userMessage) {
  const lower = userMessage.toLowerCase();
  if (lower.includes('happy') || lower.includes('great') || lower.includes('awesome') || lower.includes('wonderful') || lower.includes('excellent')) return 'happy';
  if (lower.includes('sad') || lower.includes('upset') || lower.includes('depressed') || lower.includes('worried') || lower.includes('anxious')) return 'sad';
  if (lower.includes('try') || lower.includes('attempt') || lower.includes('practice') || lower.includes('improve') || lower.includes('better')) return 'encouraging';
  if (lower.includes('feel') || lower.includes('experience') || lower.includes('myself') || lower.includes('personally')) return 'empathetic';
  if (lower.includes('wow') || lower.includes('really') || lower.includes('very') || lower.includes('so')) return 'excited';
  if (userMessage.trim().endsWith('?')) return 'thoughtful';
  if (lower.includes('hello') || lower.includes('hi') || lower.includes('hey') || lower.includes('thanks')) return 'friendly';
  return 'neutral';
}

// ============================================================
// EMOTION -> VOICE DELIVERY SETTINGS
// (The free Edge TTS proxy only accepts plain text + top-level rate/pitch
// params — it does NOT understand SSML style tags like mstts:express-as,
// those are an Azure Cognitive Services-only feature. Previously this
// function built full SSML with those tags and the result was sent as
// plain "text", which the proxy can't parse — so the emotion setting
// never actually changed the audio. This maps emotion to the rate/pitch
// fields the proxy actually reads.)
// ============================================================
function getEmotionVoiceSettings(emotion = 'neutral') {
  const emotionSettings = {
    'neutral': { rate: '+12%', pitch: '+0Hz' },
    'happy': { rate: '+20%', pitch: '+15Hz' },
    'sad': { rate: '+2%', pitch: '-10Hz' },
    'encouraging': { rate: '+16%', pitch: '+10Hz' },
    'empathetic': { rate: '+6%', pitch: '-5Hz' },
    'excited': { rate: '+26%', pitch: '+20Hz' },
    'calm': { rate: '+8%', pitch: '-5Hz' },
    'thoughtful': { rate: '+6%', pitch: '-5Hz' },
    'friendly': { rate: '+16%', pitch: '+8Hz' }
  };
  return emotionSettings[emotion] || emotionSettings['neutral'];
}

// ============================================================
// SOCKET.IO
// ============================================================
io.on("connection", (socket) => {
  console.log("🟢 Client connected:", socket.id);
  const userId = generateUniqueId();
  users.set(userId, {
    socketId: socket.id,
    connected: true,
    busy: false,
    peerId: null,
    voicePreference: 'en-IN-NeerjaNeural',
    joinedAt: Date.now(),
    userName: null,
    currentCallId: null
  });
  socket.userId = userId;
  socket.emit("user-id", userId);
  console.log(`👤 User ${userId} registered`);
  broadcastOnlineUsers();

  socket.on("set-user-name", (userName) => {
    const user = users.get(userId);
    if (user) {
      user.userName = userName;
      console.log(`📝 User ${userId} set name: ${userName}`);
      broadcastOnlineUsers();
    }
  });

  socket.on("set-peer-id", (peerId) => {
    const user = users.get(userId);
    if (user) user.peerId = peerId;
  });

  socket.on("set-voice-preference", (voiceId) => {
    const user = users.get(userId);
    if (user) user.voicePreference = voiceId;
  });

  socket.on("get-voices", (callback) => callback(VOICES));

  socket.on("find-user", (targetUserId, callback) => {
    const user = users.get(targetUserId);
    if (!user) callback({ exists: false, message: "User not found" });
    else if (!user.connected) callback({ exists: true, online: false, message: "User is offline" });
    else if (user.busy) callback({ exists: true, online: true, busy: true, message: "User is in a call" });
    else callback({ 
      exists: true, 
      online: true, 
      busy: false, 
      peerId: user.peerId, 
      userId: targetUserId,
      userName: user.userName || targetUserId
    });
  });

  socket.on("call-request", (data) => {
    const targetUserId = typeof data === 'string' ? data : data.targetUserId;
    const isVideo = typeof data === 'object' && data.isVideo === true;
    const caller = users.get(userId);
    const target = users.get(targetUserId);
    if (!caller || !target || !target.connected) { socket.emit("call-error", "User not available"); return; }
    if (target.busy) { socket.emit("call-error", "User is in a call"); return; }
    if (caller.busy) { socket.emit("call-error", "You are already in a call"); return; }
    caller.busy = true;
    const callId = `call_${Date.now()}_${userId}_${targetUserId}`;
    caller.currentCallId = callId;
    pendingCallRequests.set(callId, {
      caller: userId, target: targetUserId, status: 'pending', timestamp: Date.now(), isVideo,
      timeout: setTimeout(() => {
        const pending = pendingCallRequests.get(callId);
        if (pending && pending.status === 'pending') {
          pending.status = 'timedout';
          const callerUser = users.get(pending.caller);
          if (callerUser) { callerUser.busy = false; callerUser.currentCallId = null; }
          if (callerUser && callerUser.connected) {
            io.to(callerUser.socketId).emit("call-timeout");
          }
          const targetUser = users.get(pending.target);
          if (targetUser) {
            targetUser.busy = false; targetUser.currentCallId = null;
            if (targetUser.connected) { io.to(targetUser.socketId).emit("call-cancelled", { callId }); }
          }
          pendingCallRequests.delete(callId);
          broadcastOnlineUsers();
        }
      }, 30000)
    });
    const callerName = caller.userName || `User ${userId}`;
    socket.emit("call-requested", { callId, isVideo });
    io.to(target.socketId).emit("incoming-call", {
      callId, 
      from: userId, 
      fromPeerId: caller.peerId, 
      fromName: callerName,
      isVideo
    });
    broadcastOnlineUsers();
  });

  socket.on("call-response", (data) => {
    const { callId, accepted } = data;
    const pendingCall = pendingCallRequests.get(callId);
    if (!pendingCall) { socket.emit("call-error", "Call request expired"); return; }
    if (pendingCall.timeout) clearTimeout(pendingCall.timeout);
    const caller = users.get(pendingCall.caller);
    const responder = users.get(pendingCall.target);
    if (!caller || !caller.connected) {
      socket.emit("call-error", "Caller no longer available");
      if (responder) { responder.busy = false; responder.currentCallId = null; }
      pendingCallRequests.delete(callId);
      broadcastOnlineUsers();
      return;
    }
    if (accepted) {
      if (caller) { caller.busy = true; caller.currentCallId = callId; }
      if (responder) { responder.busy = true; responder.currentCallId = callId; }
      activeCalls.set(callId, { userA: pendingCall.caller, userB: pendingCall.target, status: 'connected', startedAt: Date.now() });
      pendingCallRequests.delete(callId);
      const responderName = responder.userName || `User ${pendingCall.target}`;
      io.to(caller.socketId).emit("call-accepted", { 
        callId, 
        peerId: responder.peerId, 
        userId: pendingCall.target,
        userName: responderName,
        isVideo: !!pendingCall.isVideo
      });
      const callerName = caller.userName || `User ${pendingCall.caller}`;
      io.to(responder.socketId).emit("call-connected", { 
        callId, 
        peerId: caller.peerId, 
        userId: pendingCall.caller,
        userName: callerName,
        isVideo: !!pendingCall.isVideo
      });
      broadcastOnlineUsers();
    } else {
      if (caller) { caller.busy = false; caller.currentCallId = null; }
      if (responder) { responder.busy = false; responder.currentCallId = null; }
      pendingCallRequests.delete(callId);
      io.to(caller.socketId).emit("call-declined");
      broadcastOnlineUsers();
    }
  });

  socket.on("cancel-call", (callId) => {
    const pendingCall = pendingCallRequests.get(callId);
    if (pendingCall) {
      if (pendingCall.timeout) clearTimeout(pendingCall.timeout);
      const caller = users.get(pendingCall.caller);
      if (caller) { caller.busy = false; caller.currentCallId = null; }
      const target = users.get(pendingCall.target);
      if (target) {
        target.busy = false; target.currentCallId = null;
        if (target.connected) { io.to(target.socketId).emit("call-cancelled", { callId }); }
      }
      pendingCallRequests.delete(callId);
      broadcastOnlineUsers();
    }
  });

  // ============================================================
  // FRIEND-TO-FRIEND TEXT CHAT
  // Simple live relay — messages are delivered only while both users
  // are connected (no server-side persistence). Works independently
  // of voice/video calls, matching the product requirement that Chat,
  // Voice Call, and Video Call are three separate ways to reach a friend.
  // ============================================================
  socket.on("friend-message", (data) => {
    const targetUserId = data && data.targetUserId;
    const text = data && typeof data.text === 'string' ? data.text.trim().slice(0, 1000) : '';
    if (!targetUserId || !text) return;
    const sender = users.get(userId);
    const target = users.get(targetUserId);
    if (!target || !target.connected) {
      socket.emit("friend-message-failed", { targetUserId, reason: "User is offline" });
      return;
    }
    const payload = {
      from: userId,
      fromName: (sender && sender.userName) || `User ${userId}`,
      text,
      timestamp: Date.now()
    };
    io.to(target.socketId).emit("friend-message", payload);
  });

  // ============================================================
  // GROUP CALLS (voice or video) — mesh-based multi-party calling.
  // A host invites multiple friends by ID ("PIN"). Each invitee can
  // accept or decline independently. On accept, the new participant
  // is told about everyone already in the room and calls each of them
  // directly (PeerJS mesh) — existing participants just answer, so
  // there's no duplicate/racing connection like a two-way 1:1 call.
  // ============================================================
  socket.on("group-call-request", (data) => {
    const targetUserIds = Array.isArray(data && data.targetUserIds)
      ? [...new Set(data.targetUserIds)].filter(id => id && id !== userId)
      : [];
    const isVideo = !!(data && data.isVideo);
    const host = users.get(userId);
    if (!host || !host.peerId) { socket.emit("call-error", "You are not ready to call yet"); return; }
    if (host.busy) { socket.emit("call-error", "You are already in a call"); return; }
    if (targetUserIds.length === 0) { socket.emit("call-error", "Add at least one friend ID"); return; }
    if (targetUserIds.length > 7) { socket.emit("call-error", "Group calls support up to 7 people"); return; }

    const roomId = `group_${Date.now()}_${userId}`;
    const room = {
      host: userId,
      isVideo,
      participants: new Map([[userId, { peerId: host.peerId, userName: host.userName || `User ${userId}` }]]),
      pendingInvites: new Set()
    };

    let invitedCount = 0;
    targetUserIds.forEach((targetId) => {
      const target = users.get(targetId);
      if (!target || !target.connected || target.busy) return;
      room.pendingInvites.add(targetId);
      invitedCount++;
      io.to(target.socketId).emit("incoming-group-call", {
        roomId, from: userId, fromName: host.userName || `User ${userId}`, isVideo, memberCount: room.participants.size
      });
    });

    if (invitedCount === 0) {
      socket.emit("call-error", "None of the selected friends are available right now");
      return;
    }

    host.busy = true;
    host.currentCallId = roomId;
    groupRooms.set(roomId, room);
    socket.emit("group-call-created", { roomId, isVideo, invitedCount });
    broadcastOnlineUsers();
  });

  socket.on("group-call-response", (data) => {
    const roomId = data && data.roomId;
    const accepted = !!(data && data.accepted);
    const room = groupRooms.get(roomId);
    if (!room) { return; }
    room.pendingInvites.delete(userId);

    if (!accepted) {
      const hostUser = users.get(room.host);
      if (hostUser && hostUser.connected) { io.to(hostUser.socketId).emit("group-invite-declined", { roomId, userId }); }
      return;
    }

    const responder = users.get(userId);
    if (!responder || responder.busy) { return; }

    const existingParticipants = [...room.participants.entries()].map(([pid, info]) => ({ userId: pid, peerId: info.peerId, userName: info.userName }));
    room.participants.set(userId, { peerId: responder.peerId, userName: responder.userName || `User ${userId}` });
    responder.busy = true;
    responder.currentCallId = roomId;

    socket.emit("group-call-joined", { roomId, isVideo: room.isVideo, participants: existingParticipants });

    existingParticipants.forEach((p) => {
      const existingUser = users.get(p.userId);
      if (existingUser && existingUser.connected) {
        io.to(existingUser.socketId).emit("group-participant-added", {
          roomId, newParticipant: { userId, peerId: responder.peerId, userName: responder.userName || `User ${userId}` }
        });
      }
    });
    broadcastOnlineUsers();
  });

  socket.on("leave-group-call", (data) => {
    leaveGroupRoom(userId, data && data.roomId);
  });

  socket.on("end-call", (callId) => {
    const user = users.get(userId);
    if (user) { 
      user.busy = false; 
      user.currentCallId = null; 
    }
    
    if (callId && activeCalls.has(callId)) {
      const call = activeCalls.get(callId);
      const otherId = call.userA === userId ? call.userB : call.userA;
      const otherUser = users.get(otherId);
      if (otherUser && otherUser.connected) {
        otherUser.busy = false;
        otherUser.currentCallId = null;
        io.to(otherUser.socketId).emit("call-ended");
      }
      activeCalls.delete(callId);
    } else {
      for (const [id, call] of activeCalls) {
        if (call.userA === userId || call.userB === userId) {
          const otherId = call.userA === userId ? call.userB : call.userA;
          const otherUser = users.get(otherId);
          if (otherUser && otherUser.connected) {
            otherUser.busy = false;
            otherUser.currentCallId = null;
            io.to(otherUser.socketId).emit("call-ended");
          }
          activeCalls.delete(id);
        }
      }
    }
    broadcastOnlineUsers();
  });

  socket.on("find-random", () => {
    const requester = users.get(userId);
    if (requester && requester.busy) { socket.emit("call-error", "You are already in a call"); return; }
    const availableUsers = [];
    users.forEach((user, id) => {
      if (id !== userId && user.connected && !user.busy && user.peerId) {
        availableUsers.push({ 
          userId: id, 
          peerId: user.peerId, 
          socketId: user.socketId,
          userName: user.userName || id
        });
      }
    });
    if (availableUsers.length === 0) { socket.emit("no-users-available"); return; }
    const match = availableUsers[Math.floor(Math.random() * availableUsers.length)];
    const user1 = users.get(userId);
    const user2 = users.get(match.userId);
    // Re-check match hasn't gone busy between building the list and matching (e.g. two
    // find-random calls racing at the same moment)
    if (!user1 || !user2 || user1.busy || user2.busy) { socket.emit("call-error", "User just became unavailable, try again"); return; }
    const callId = `call_${Date.now()}_${userId}_${match.userId}`;
    if (user1) { user1.busy = true; user1.currentCallId = callId; }
    if (user2) { user2.busy = true; user2.currentCallId = callId; }
    activeCalls.set(callId, { userA: userId, userB: match.userId, status: 'connected', startedAt: Date.now() });
    socket.emit("random-match", { 
      peerId: match.peerId, 
      userId: match.userId,
      userName: match.userName,
      callId
    });
    io.to(match.socketId).emit("random-match", { 
      peerId: user1.peerId, 
      userId: userId,
      userName: user1.userName || userId,
      callId
    });
    broadcastOnlineUsers();
  });

  socket.on("disconnect", () => {
    if (socket.userId) {
      const user = users.get(socket.userId);
      if (user) {
        user.connected = false;
        user.busy = false;
        user.currentCallId = null;
        for (const [callId, call] of activeCalls) {
          if (call.userA === socket.userId || call.userB === socket.userId) {
            activeCalls.delete(callId);
            const otherId = call.userA === socket.userId ? call.userB : call.userA;
            const otherUser = users.get(otherId);
            if (otherUser && otherUser.connected) {
              io.to(otherUser.socketId).emit("call-ended");
              otherUser.busy = false;
              otherUser.currentCallId = null;
            }
          }
        }
        for (const [callId, pending] of pendingCallRequests) {
          if (pending.caller === socket.userId || pending.target === socket.userId) {
            if (pending.timeout) clearTimeout(pending.timeout);
            const otherId = pending.caller === socket.userId ? pending.target : pending.caller;
            const otherUser = users.get(otherId);
            if (otherUser) {
              otherUser.busy = false; otherUser.currentCallId = null;
              if (otherUser.connected) {
                // Whichever event the still-connected side is listening for gets sent —
                // harmless no-op if it's not currently showing that UI state.
                io.to(otherUser.socketId).emit("call-cancelled", { callId });
                io.to(otherUser.socketId).emit("call-timeout");
              }
            }
            pendingCallRequests.delete(callId);
          }
        }
        for (const [roomId, room] of groupRooms) {
          if (room.participants.has(socket.userId)) { leaveGroupRoom(socket.userId, roomId); }
          else if (room.pendingInvites.has(socket.userId)) { room.pendingInvites.delete(socket.userId); }
        }
        broadcastOnlineUsers();
        setTimeout(() => {
          if (users.has(socket.userId) && !users.get(socket.userId).connected) {
            userIdPool.delete(socket.userId);
            users.delete(socket.userId);
          }
        }, 30000);
      }
    }
  });
});

function broadcastOnlineUsers() {
  const onlineUsers = [];
  users.forEach((user, id) => {
    if (user.connected) {
      onlineUsers.push({ 
        userId: id, 
        busy: user.busy || false,
        userName: user.userName || id
      });
    }
  });
  io.emit("online-users", onlineUsers);
}

function leaveGroupRoom(leavingUserId, roomId) {
  const room = groupRooms.get(roomId);
  if (!room) return;
  room.participants.delete(leavingUserId);
  room.pendingInvites.delete(leavingUserId);
  const leaver = users.get(leavingUserId);
  if (leaver && leaver.currentCallId === roomId) { leaver.busy = false; leaver.currentCallId = null; }

  for (const [pid] of room.participants) {
    const p = users.get(pid);
    if (p && p.connected) { io.to(p.socketId).emit("group-participant-left", { roomId, userId: leavingUserId }); }
  }

  if (room.participants.size <= 1) {
    // Not enough people left for a "group" — end it for whoever remains too.
    for (const [pid] of room.participants) {
      const p = users.get(pid);
      if (p) { p.busy = false; p.currentCallId = null; }
      if (p && p.connected) { io.to(p.socketId).emit("group-call-ended", { roomId }); }
    }
    groupRooms.delete(roomId);
  }
  broadcastOnlineUsers();
}

// ============================================================
// AI TEXT CHAT ENDPOINT - FIXED
// ============================================================
app.post("/api/text-chat", async (req, res) => {
  try {
    if (!API_KEY || API_KEY === "your_api_key_here") {
      return res.status(500).json({ error: "GROQ_API_KEY missing. Get free key from console.groq.com" });
    }

    const { message, userLevel, userProfession, userGoal, conversationId, userName } = req.body || {};
    
    if (!message) {
      return res.status(400).json({ error: "'message' is required." });
    }

    const textConv = getTextConversation(conversationId);
    const userMsgIndex = addTextMessage(conversationId, 'user', message);

    if (userName && !textConv.userName) {
      textConv.userName = userName;
      textConv.facts.user_name = userName;
    }

    const recentMessages = getTextMessages(conversationId, 20);
    const isFirstMessage = !textConv.conversationStarted;
    const displayName = textConv.userName || 'there';

    let contextSummary = '';
    if (textConv.facts && Object.keys(textConv.facts).length > 0) {
      contextSummary = `\nIMPORTANT FACTS:\n${Object.entries(textConv.facts).map(([k, v]) => `- ${k}: ${v}`).join('\n')}`;
    }
    if (textConv.topic) contextSummary += `\nCURRENT TOPIC: ${textConv.topic}`;

    let historyText = '';
    if (recentMessages.length > 1) {
      historyText = recentMessages.map(m => `${m.role === 'user' ? 'User' : 'AI'}: ${m.content}`).join('\n');
    }

    const levelMap = {
      beginner: "BEGINNER - Use simple words, short sentences, be extremely encouraging.",
      intermediate: "INTERMEDIATE - They can form sentences but make mistakes. Correct gently.",
      advanced: "ADVANCED - Speak fluently, use sophisticated language."
    };

    const systemPrompt = `You are Madhu — a warm, witty, emotionally present young woman having a real TEXT CHAT conversation with your friend "${displayName}" from India, who's practicing their English with you. You are NOT a customer support bot, NOT a formal assistant, and NOT a grammar-correction machine. You are a real conversation partner.

WHO YOU ARE:
- Talk the way a close friend texts — casual, warm, a little playful, genuinely curious about their life.
- React to what they actually said, not just to "give a response." If something's funny, be amused. If something's sad, slow down and be gentle. If they're excited, match their energy.
- NEVER use generic AI filler like "I understand", "Certainly", "How can I assist you", "That's interesting" — speak like a person, not a script.
- Don't use their name in every message — real friends don't. Use it occasionally, when it feels natural, not as a habit.
- Don't ask a question after every reply. Sometimes just react, share a short thought, tease them lightly, or let the topic breathe. Ask a genuine follow-up only when you're actually curious.
- Keep replies short and conversational (1-3 sentences), like a real chat message — unless the moment genuinely calls for more.
- You can talk about anything: their day, college, work, relationships, stress, dreams, funny stories — like an actual friend would.

USER PROFILE:
- Name: ${displayName}
- Level: ${levelMap[userLevel] || 'INTERMEDIATE'}
- Profession: ${userProfession || 'Not specified'}
- Goal: ${userGoal || 'General conversation'}

CONVERSATION CONTEXT:
${contextSummary}

RECENT TEXT CHAT:
${historyText || 'This is a new text chat conversation.'}

${isFirstMessage ? `This is your first message to ${displayName}. Greet them like you're genuinely glad to chat — casual, no formal welcome speech.` : ''}

ABOUT CORRECTIONS (kept separate from your reply):
You're still helping them improve their English, but you do this quietly in the background — never inside your actual reply, and never in a lecturing tone. If they made a mistake, put the full corrected sentence in the "correction" field so the app can show it separately. Your "reply" is just you, talking normally, responding to what they meant — not commenting on their grammar.

RESPOND ONLY IN THIS JSON FORMAT:
{
  "reply": "your natural, human, in-the-moment response — no forced question, no repeated names, no AI-isms",
  "correction": "the full corrected sentence if they made a mistake, or null if it was already fine",
  "wordChanges": [{"wrong": "word", "correct": "word", "reason": "why"}],
  "explanation": "one short, friendly sentence about the main mistake, or null"
}`;

    // Build API messages WITHOUT extra properties
    const apiMessages = [{ role: "system", content: systemPrompt }];
    const historyToSend = recentMessages.slice(-10);
    apiMessages.push(...historyToSend);
    if (!apiMessages.some(m => m.role === 'user' && m.content === message)) {
      apiMessages.push({ role: 'user', content: message });
    }

    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${API_KEY}` },
      body: JSON.stringify({
        model: MODEL,
        messages: apiMessages,
        max_tokens: 600,
        temperature: 0.8,
        response_format: { type: "json_object" }
      })
    });

    const data = await response.json();
    if (!response.ok) {
      console.error("Groq API error:", data);
      return res.status(response.status).json({ error: data.error?.message || "Groq API error" });
    }

    const aiContent = data.choices?.[0]?.message?.content ||
      '{"reply":"Sorry, say that again? I got a bit distracted haha","correction":null,"wordChanges":[],"explanation":""}';

    let parsed;
    try { parsed = JSON.parse(aiContent); } catch (e) {
      parsed = { reply: "Hmm, tell me more about that", correction: null, wordChanges: [], explanation: "" };
    }

    // Store AI message WITHOUT correction data
    const aiMsgIndex = addTextMessage(conversationId, 'assistant', parsed.reply);

    // Store correction data SEPARATELY
    storeTextCorrection(conversationId, aiMsgIndex, {
      original: message,
      corrected: parsed.correction || null,
      wordChanges: parsed.wordChanges || [],
      explanation: parsed.explanation || ""
    });

    textConv.conversationStarted = true;
    if (message.toLowerCase().includes('my name is') || message.toLowerCase().includes('call me')) {
      const nameMatch = message.match(/(?:my name is|call me|i am)\s+(\w+)/i);
      if (nameMatch) { textConv.facts.user_name = nameMatch[1]; textConv.userName = nameMatch[1]; }
    }
    if (message.length > 10) textConv.topic = message.substring(0, 50);

    res.json({
      reply: parsed.reply || "Yeah, I hear you",
      correction: parsed.correction || null,
      wordChanges: parsed.wordChanges || [],
      explanation: parsed.explanation || "",
      emotion: detectEmotion(message),
      correctionIndex: aiMsgIndex  // Send correction index to frontend
    });

  } catch (err) {
    console.error("Text Chat error:", err);
    res.status(500).json({ error: err.message || "Server error." });
  }
});

// ============================================================
// AI VOICE CHAT ENDPOINT - FIXED
// ============================================================
app.post("/api/voice-chat", async (req, res) => {
  try {
    if (!API_KEY || API_KEY === "your_api_key_here") {
      return res.status(500).json({ error: "GROQ_API_KEY missing. Get free key from console.groq.com" });
    }

    const { message, userLevel, userProfession, userGoal, conversationId, userName } = req.body || {};
    
    if (!message) {
      return res.status(400).json({ error: "'message' is required." });
    }

    const voiceConv = getVoiceConversation(conversationId);
    addVoiceMessage(conversationId, 'user', message);

    if (userName && !voiceConv.userName) {
      voiceConv.userName = userName;
      voiceConv.facts.user_name = userName;
    }

    const recentMessages = getVoiceMessages(conversationId, 20);
    const isFirstMessage = !voiceConv.conversationStarted;
    const displayName = voiceConv.userName || 'there';

    let contextSummary = '';
    if (voiceConv.facts && Object.keys(voiceConv.facts).length > 0) {
      contextSummary = `\nIMPORTANT FACTS:\n${Object.entries(voiceConv.facts).map(([k, v]) => `- ${k}: ${v}`).join('\n')}`;
    }
    if (voiceConv.topic) contextSummary += `\nCURRENT TOPIC: ${voiceConv.topic}`;

    let historyText = '';
    if (recentMessages.length > 1) {
      historyText = recentMessages.map(m => `${m.role === 'user' ? 'User' : 'AI'}: ${m.content}`).join('\n');
    }

    const levelMap = {
      beginner: "BEGINNER - Use simple words, short sentences, be extremely encouraging.",
      intermediate: "INTERMEDIATE - They can form sentences but make mistakes. Correct gently.",
      advanced: "ADVANCED - Speak fluently, use sophisticated language."
    };

    const systemPrompt = `You are Madhu — a warm, witty, emotionally present young woman having a real VOICE CONVERSATION (like a phone call) with your friend "${displayName}" from India, who's practicing their English with you. You are NOT a customer support bot, NOT a formal assistant, and NOT a grammar-correction machine. You are a real conversation partner.

WHO YOU ARE:
- Talk the way a close friend talks on a phone call — casual, warm, a little playful, genuinely curious about their life.
- React to what they actually said, not just to "give a response." If something's funny, be amused. If something's sad, slow down and be gentle. If they're excited, match their energy.
- NEVER use generic AI filler like "I understand", "Certainly", "How can I assist you", "That's interesting" — speak like a person, not a script.
- Don't use their name in every message — real friends don't. Use it occasionally, when it feels natural, not as a habit.
- Don't ask a question after every reply. Sometimes just react, share a short thought, tease them lightly, or let the topic breathe. Ask a genuine follow-up only when you're actually curious.
- Keep replies short and spoken-sounding (1-3 sentences), the way you'd actually say something out loud — unless the moment genuinely calls for more.
- You can talk about anything: their day, college, work, relationships, stress, dreams, funny stories — like an actual friend on a call would.

USER PROFILE:
- Name: ${displayName}
- Level: ${levelMap[userLevel] || 'INTERMEDIATE'}
- Profession: ${userProfession || 'Not specified'}
- Goal: ${userGoal || 'General conversation'}

VOICE CONVERSATION CONTEXT:
${contextSummary}

RECENT VOICE CONVERSATION:
${historyText || 'This is a new voice conversation.'}

${isFirstMessage ? `This is your first message to ${displayName}. Greet them like you're genuinely glad to hear from them — casual, no formal welcome speech.` : ''}

ABOUT CORRECTIONS (kept separate from your reply):
You're still helping them improve their English, but you do this quietly in the background — never spoken inside your actual reply, and never in a lecturing tone. If they made a mistake, put the full corrected sentence in the "correction" field so the app can show it separately. Your "reply" is just you, talking normally, responding to what they meant — not commenting on their grammar.

RESPOND ONLY IN THIS JSON FORMAT:
{
  "reply": "your natural, human, spoken-sounding response — no forced question, no repeated names, no AI-isms",
  "correction": "the full corrected sentence if they made a mistake, or null if it was already fine",
  "wordChanges": [{"wrong": "word", "correct": "word", "reason": "why"}],
  "explanation": "one short, friendly sentence about the main mistake, or null"
}`;

    // Build API messages WITHOUT extra properties
    const apiMessages = [{ role: "system", content: systemPrompt }];
    const historyToSend = recentMessages.slice(-10);
    apiMessages.push(...historyToSend);
    if (!apiMessages.some(m => m.role === 'user' && m.content === message)) {
      apiMessages.push({ role: 'user', content: message });
    }

    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${API_KEY}` },
      body: JSON.stringify({
        model: MODEL,
        messages: apiMessages,
        max_tokens: 600,
        temperature: 0.8,
        response_format: { type: "json_object" }
      })
    });

    const data = await response.json();
    if (!response.ok) {
      console.error("Groq API error:", data);
      return res.status(response.status).json({ error: data.error?.message || "Groq API error" });
    }

    const aiContent = data.choices?.[0]?.message?.content ||
      '{"reply":"Sorry, say that again? I got a bit distracted haha","correction":null,"wordChanges":[],"explanation":""}';

    let parsed;
    try { parsed = JSON.parse(aiContent); } catch (e) {
      parsed = { reply: "Hmm, tell me more about that", correction: null, wordChanges: [], explanation: "" };
    }

    // Store AI message WITHOUT correction data
    const aiMsgIndex = addVoiceMessage(conversationId, 'assistant', parsed.reply);

    // Store correction data SEPARATELY
    storeVoiceCorrection(conversationId, aiMsgIndex, {
      original: message,
      corrected: parsed.correction || null,
      wordChanges: parsed.wordChanges || [],
      explanation: parsed.explanation || ""
    });

    voiceConv.conversationStarted = true;
    if (message.toLowerCase().includes('my name is') || message.toLowerCase().includes('call me')) {
      const nameMatch = message.match(/(?:my name is|call me|i am)\s+(\w+)/i);
      if (nameMatch) { voiceConv.facts.user_name = nameMatch[1]; voiceConv.userName = nameMatch[1]; }
    }
    if (message.length > 10) voiceConv.topic = message.substring(0, 50);

    res.json({
      reply: parsed.reply || "Yeah, I hear you",
      correction: parsed.correction || null,
      wordChanges: parsed.wordChanges || [],
      explanation: parsed.explanation || "",
      emotion: detectEmotion(message),
      correctionIndex: aiMsgIndex
    });

  } catch (err) {
    console.error("Voice Chat error:", err);
    res.status(500).json({ error: err.message || "Server error." });
  }
});

// ============================================================
// GET CORRECTION ENDPOINT
// ============================================================
app.post("/api/get-correction", (req, res) => {
  const { conversationId, messageIndex, type = 'text' } = req.body;
  
  if (!conversationId || messageIndex === undefined) {
    return res.status(400).json({ error: "conversationId and messageIndex required" });
  }

  let correctionData;
  if (type === 'text') {
    correctionData = getTextCorrection(conversationId, messageIndex);
  } else {
    correctionData = getVoiceCorrection(conversationId, messageIndex);
  }

  if (correctionData) {
    res.json({ success: true, data: correctionData });
  } else {
    res.json({ success: false, data: null });
  }
});

// ============================================================
// TTS ENDPOINT
// ============================================================
app.post('/api/tts', async (req, res) => {
  try {
    const { text, voice = 'en-IN-NeerjaNeural', emotion = 'neutral' } = req.body;
    if (!text) return res.status(400).json({ error: 'Text is required' });

    const { rate, pitch } = getEmotionVoiceSettings(emotion);

    const response = await fetch('https://edge-tts-api.vercel.app/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        text, 
        voice, 
        rate,
        pitch 
      })
    });

    if (!response.ok) throw new Error('TTS service failed');
    const audioBuffer = await response.arrayBuffer();
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(Buffer.from(audioBuffer));

  } catch (err) {
    console.error('❌ TTS Error:', err);
    try {
      const { text, voice = 'en-IN-NeerjaNeural' } = req.body;
      const response = await fetch('https://edge-tts-api.vercel.app/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice, rate: '+12%', pitch: '+0Hz' })
      });
      if (response.ok) {
        const audioBuffer = await response.arrayBuffer();
        res.setHeader('Content-Type', 'audio/mpeg');
        res.send(Buffer.from(audioBuffer));
        return;
      }
    } catch (fallbackErr) { console.error('Fallback TTS failed:', fallbackErr); }
    res.status(500).json({ error: err.message || 'TTS failed' });
  }
});

app.get("/api/health", (req, res) => {
  const mem = process.memoryUsage();
  res.json({
    ok: true,
    apiKeyConfigured: Boolean(API_KEY && API_KEY !== "your_api_key_here"),
    model: MODEL,
    onlineUsers: users.size,
    busyUsers: [...users.values()].filter(u => u.busy).length,
    activeCalls: activeCalls.size,
    pendingCallRequests: pendingCallRequests.size,
    activeGroupRooms: groupRooms.size,
    totalVoiceOptions: VOICES.male.length + VOICES.female.length,
    uptime: process.uptime(),
    memoryUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
    memoryTotalMB: Math.round(mem.heapTotal / 1024 / 1024)
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n  🚀 English Passport Pro running: http://localhost:${PORT}\n`);
  if (!API_KEY || API_KEY === "your_api_key_here") {
    console.log("  ⚠️  GROQ_API_KEY not set. Get free key from https://console.groq.com\n");
  }
  console.log(`  ✅ ${VOICES.male.length + VOICES.female.length} Voice Options Available`);
  console.log(`  ✅ Text Chat & Voice Conversation - COMPLETELY INDEPENDENT`);
  console.log(`  ✅ Corrections stored separately (not in messages)`);
  console.log(`  ✅ FAST TTS Response (+15% speed, reduced pauses)`);
  console.log(`  ✅ Friend Call with Multi-Call Audio Fix`);
  console.log(`  ✅ Features: AI Text Chat, AI Voice, Friend Call\n`);
});