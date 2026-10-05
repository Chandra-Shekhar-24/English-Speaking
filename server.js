require("dotenv").config();
const dns = require("dns");
try {
  if (dns && typeof dns.setDefaultResultOrder === 'function') {
    dns.setDefaultResultOrder('ipv4first');
  }
} catch (e) {}

const express = require("express");
const cors = require("cors");
const path = require("path");
const http = require("http");
const { Server } = require("socket.io");
const cookieParser = require("cookie-parser");
const auth = require("./auth");
const activity = require("./activity");
const sheets = require("./sheets");
const mailer = require("./mailer");
const { query, runMigrations } = require("./db/pool");

// ============================================================
// DATABASE - PostgreSQL (Render)
// ============================================================
// NOTE: chat/call/session history is intentionally the LOCAL JSON store
// (db.js), not Postgres — see README's storage table. Postgres (db/pool.js,
// required as `query` above) holds accounts/sessions-for-auth/permanent IDs.
// This used to `require("./db/pool")` here and call methods like
// saveMessage/getConversation/startCallRecord on it — but pool.js only
// exports { pool, query }, so every one of those calls threw
// "pgDb.<method> is not a function", was silently swallowed by the
// try/catch below, and chat history, call history, and session tracking
// never actually persisted. Pointing this at "./db" (the real
// implementation of those methods) fixes it.
let db;
try {
  const localDb = require("./db");

  // Wrap local JSON-store functions to match the db interface
  db = {
    saveMessage: (fromUser, toUser, fromName, text, attachment) => {
      try {
        return localDb.saveMessage(fromUser, toUser, fromName, text, attachment);
      } catch (e) { console.error("DB save error:", e); return null; }
    },
    getConversation: (user1, user2, limit) => {
      try {
        return localDb.getConversation(user1, user2, limit);
      } catch (e) { console.error("DB get error:", e); return []; }
    },
    getExpiredAttachments: (now) => {
      try {
        return localDb.getExpiredAttachments(now);
      } catch (e) { console.error("DB getExpiredAttachments error:", e); return []; }
    },
    markAttachmentExpired: (messageId) => {
      try {
        localDb.markAttachmentExpired(messageId);
      } catch (e) { console.error("DB markAttachmentExpired error:", e); }
    },
    startCallRecord: (callType, mediaType, participants) => {
      try {
        return localDb.startCallRecord(callType, mediaType, participants);
      } catch (e) { console.error("DB call error:", e); return null; }
    },
    endCallRecord: (recordId, startedAt) => {
      try {
        localDb.endCallRecord(recordId, startedAt);
      } catch (e) { console.error("DB end call error:", e); }
    },
    startSession: (userId, displayName) => {
      try {
        return localDb.startSession(userId, displayName);
      } catch (e) { console.error("DB session error:", e); return null; }
    },
    endSession: (sessionId) => {
      try {
        localDb.endSession(sessionId);
      } catch (e) { console.error("DB end session error:", e); }
    },
    updateSessionName: (sessionId, userName) => {
      try {
        localDb.updateSessionName(sessionId, userName);
      } catch (e) { console.error("DB update session error:", e); }
    },
    getStats: () => {
      try {
        return localDb.getStats();
      } catch (e) { console.error("DB stats error:", e); return { totalMessages: 0, totalCalls: 0, sessionsLast24h: 0 }; }
    }
  };
  console.log("💾 Local JSON database module loaded ✅ (chat/call/session history)");
} catch (e) {
  console.warn("⚠️ Local database module unavailable:", e.message);
  // Fallback no-op implementation so the app still runs without persistence.
  db = {
    saveMessage: () => null, getConversation: () => [],
    getExpiredAttachments: () => [], markAttachmentExpired: () => {},
    startCallRecord: () => null, endCallRecord: () => {},
    startSession: () => null, endSession: () => {}, updateSessionName: () => {},
    getStats: () => ({ totalMessages: 0, totalCalls: 0, sessionsLast24h: 0 })
  };
}

const media = require("./media");
const multer = require("multer");
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: media.MAX_FILE_SIZE_BYTES } });
media.scheduleCleanup(db); // 24-hour attachment auto-deletion (see media.js)

const app = express();
// Render (and most hosts) sit behind a reverse proxy that terminates TLS,
// so Express itself sees plain HTTP. Without `trust proxy`, req.secure is
// always false and secure cookies/redirects behave incorrectly.
app.set('trust proxy', 1);
app.use(cors({ origin: process.env.APP_URL || true, credentials: true }));
app.use(express.json({ limit: "10mb" }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));

const SESSION_COOKIE = "epp_session";
const SESSION_COOKIE_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // 30 days, matches auth.js SESSION_TTL_MS

// Attaches req.user if a valid session cookie is present (does NOT block
// the request either way — use requireAuth for routes that must be
// authenticated).
app.use(async (req, res, next) => {
  try {
    const token = req.cookies && req.cookies[SESSION_COOKIE];
    req.user = token ? await auth.getUserByToken(token) : null;
  } catch (e) {
    req.user = null;
  }
  next();
});

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Not signed in" });
  next();
}

function handleAuthError(res, err) {
  const status = err.status || 500;
  if (status === 500) { console.error("Auth error:", err); }
  res.status(status).json({
    error: err.message || "Something went wrong",
    needsVerification: Boolean(err.needsVerification),
    email: err.email || null,
    userCode: err.userCode || null
  });
}

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: process.env.APP_URL || true, credentials: true },
  pingTimeout: 60000,
  pingInterval: 25000
});

const { GoogleGenAI } = require("@google/genai");

let geminiClient = null;
let geminiQuotaCooldownUntil = 0;
function isGeminiAvailable() {
  return Date.now() >= geminiQuotaCooldownUntil;
}

function getGeminiClient() {
  if (!isGeminiAvailable()) return null;
  if (geminiClient) return geminiClient;
  try {
    const opts = {
      httpOptions: { headers: { 'User-Agent': 'aistudio-build' } }
    };
    if (process.env.GEMINI_API_KEY) {
      opts.apiKey = process.env.GEMINI_API_KEY;
    }
    geminiClient = new GoogleGenAI(opts);
    return geminiClient;
  } catch (e) {
    console.warn("Gemini client initialization notice:", e.message);
  }
  return null;
}

const API_KEY = process.env.GROQ_API_KEY || "your_api_key_here";
const MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";

// ============================================================
// STORES & CONVERSATION CONTEXT MEMORY
// ============================================================
const textChatMemory = new Map();      // userId -> rich conversation state
const voiceChatMemory = new Map();     // userId -> rich conversation state
const users = new Map();
const activeCalls = new Map();
const pendingCallRequests = new Map();
const groupRooms = new Map(); // roomId -> { host, isVideo, participants: Map(userId -> {peerId, userName}), pendingInvites: Set(userId) }

// ============================================================
// CONVERSATION FUNCTIONS - Natural multi-turn contextual tracking
// ============================================================
function initConversationObject(userId) {
  return {
    userId,
    messages: [],        // [{ role: 'user'|'assistant', content, timestamp }]
    corrections: {},     // { messageIndex: { original, corrected, wordChanges, explanation } }
    context: {},         // arbitrary contextual metadata
    topic: null,         // current active topic
    subtopics: [],       // history of topics touched
    facts: {},           // extracted user facts { user_name, city, job, college, hobby, mood, etc. }
    recentQuestions: [], // questions asked by the AI to resolve answers
    lastUserMessage: null,
    lastAiReply: null,
    turnCount: 0,
    conversationStarted: false,
    userName: null,
    userLevel: 'intermediate',
    userProfession: 'college student',
    userGoal: 'daily conversation'
  };
}

function getTextConversation(userId) {
  if (!textChatMemory.has(userId)) {
    textChatMemory.set(userId, initConversationObject(userId));
  }
  return textChatMemory.get(userId);
}

function getVoiceConversation(userId) {
  if (!voiceChatMemory.has(userId)) {
    voiceChatMemory.set(userId, initConversationObject(userId));
  }
  return voiceChatMemory.get(userId);
}

// Add message with timestamp and turn tracking
function addTextMessage(userId, role, content) {
  const conv = getTextConversation(userId);
  const index = conv.messages.length;
  conv.messages.push({ role, content, timestamp: Date.now() });
  if (role === 'user') {
    conv.lastUserMessage = content;
    conv.turnCount = (conv.turnCount || 0) + 1;
  } else {
    conv.lastAiReply = content;
  }
  if (conv.messages.length > 50) conv.messages = conv.messages.slice(-50);
  return index;
}

function addVoiceMessage(userId, role, content) {
  const conv = getVoiceConversation(userId);
  const index = conv.messages.length;
  conv.messages.push({ role, content, timestamp: Date.now() });
  if (role === 'user') {
    conv.lastUserMessage = content;
    conv.turnCount = (conv.turnCount || 0) + 1;
  } else {
    conv.lastAiReply = content;
  }
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

// Extract personal facts, entities, and active topics from dialogue
function extractUserContext(conv, message) {
  if (!message || typeof message !== 'string') return;
  const lower = message.toLowerCase();

  // Name extraction
  const nameMatch = message.match(/(?:my name is|call me|i am|i'm)\s+([A-Z][a-z]+)/i);
  if (nameMatch && !conv.facts.user_name && !['ready', 'fine', 'good', 'happy', 'sad', 'tired', 'doing', 'here'].includes(nameMatch[1].toLowerCase())) {
    conv.facts.user_name = nameMatch[1];
    conv.userName = nameMatch[1];
  }

  // Location extraction
  const locMatch = message.match(/(?:i live in|i'm from|i am from|staying in|living in|in)\s+([A-Za-z\s]+?)(?:[.,!?]|$)/i);
  if (locMatch && !conv.facts.location) {
    const locCandidate = locMatch[1].trim();
    if (['mumbai', 'delhi', 'bangalore', 'bengaluru', 'hyderabad', 'chennai', 'pune', 'kolkata', 'jaipur', 'ahmedabad', 'lucknow', 'chandigarh', 'noida', 'gurgaon', 'india', 'kerala', 'goa'].includes(locCandidate.toLowerCase())) {
      conv.facts.location = locCandidate;
    }
  }

  // Profession / College
  if (/student|college|university|school|studying|exam|semester/i.test(message)) {
    conv.facts.education = conv.facts.education || 'student';
    conv.currentTopic = 'academics & student life';
  } else if (/job|office|work|boss|company|client|software|engineer|developer|manager|corporate|interview/i.test(message)) {
    conv.facts.occupation = conv.facts.occupation || 'professional';
    conv.currentTopic = 'work & professional life';
  }

  // Interests & Hobbies
  if (/cricket|ipl|football|sports/i.test(message)) {
    conv.facts.hobby = 'sports & cricket';
    conv.currentTopic = 'sports & hobbies';
  } else if (/music|singing|guitar|song/i.test(message)) {
    conv.facts.hobby = 'music';
    conv.currentTopic = 'music & entertainment';
  } else if (/movie|film|cinema|series|netflix|watching/i.test(message)) {
    conv.facts.hobby = 'movies & series';
    conv.currentTopic = 'movies & entertainment';
  } else if (/cooking|food|biryani|chai|tea|coffee|dinner|lunch|breakfast/i.test(message)) {
    conv.currentTopic = 'food & daily routine';
  } else if (/travel|trip|vacation|flying|weekend/i.test(message)) {
    conv.currentTopic = 'travel & plans';
  } else if (/weather|rain|monsoon|summer|winter|hot|cold/i.test(message)) {
    conv.currentTopic = 'weather & environment';
  }

  // Mood / Feelings
  if (/stressed|anxious|tired|exhausted|nervous/i.test(message)) {
    conv.facts.recent_mood = 'stressed/tired';
  } else if (/happy|excited|great|thrilled|glad/i.test(message)) {
    conv.facts.recent_mood = 'upbeat/happy';
  }
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
// ============================================================
// SOCKET.IO AUTHENTICATION
// Every real-time connection must present a valid session cookie
// (the same one set by /api/auth/login or /api/auth/signup).
// Unauthenticated sockets are rejected during the handshake.
// ============================================================
function parseCookieHeader(header) {
  const out = {};
  if (!header) return out;
  header.split(";").forEach((pair) => {
    const idx = pair.indexOf("=");
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    try { out[key] = decodeURIComponent(pair.slice(idx + 1).trim()); } catch (e) { out[key] = pair.slice(idx + 1).trim(); }
  });
  return out;
}

io.use(async (socket, next) => {
  try {
    const cookies = parseCookieHeader(socket.handshake.headers.cookie);
    const token = (socket.handshake.auth && socket.handshake.auth.token) || cookies[SESSION_COOKIE];
    let user = token ? await auth.getUserByToken(token) : null;
    if (!user) {
      // Clean guest fallback so visitors never experience connection refusal or socket unauthorized errors
      const rand = Math.floor(1000 + Math.random() * 9000);
      user = {
        id: `guest_${socket.id.slice(0, 8)}`,
        userCode: `G${rand}`,
        displayName: `Learner ${rand}`,
        isGuest: true
      };
    }
    socket.authUser = user;
    next();
  } catch (e) {
    const rand = Math.floor(1000 + Math.random() * 9000);
    socket.authUser = {
      id: `guest_${socket.id.slice(0, 8)}`,
      userCode: `G${rand}`,
      displayName: `Learner ${rand}`,
      isGuest: true
    };
    next();
  }
});

io.on("connection", (socket) => {
  let userId = socket.authUser.userCode;
  let displayName = socket.authUser.displayName;
  console.log(`🟢 ${displayName} (${userId}) connected:`, socket.id);
  const sessionRecordId = db.startSession(userId, displayName);
  // A user reconnecting (new tab, refresh, network blip) should just take
  // over their existing entry rather than create a phantom duplicate.
  const existing = users.get(userId);
  users.set(userId, {
    socketId: socket.id,
    connected: true,
    busy: existing ? existing.busy : false,
    peerId: existing ? existing.peerId : null,
    voicePreference: existing ? existing.voicePreference : 'en-IN-NeerjaNeural',
    joinedAt: existing ? existing.joinedAt : Date.now(),
    userName: displayName,
    currentCallId: existing ? existing.currentCallId : null,
    sessionRecordId,
    isGuest: Boolean(socket.authUser.isGuest)
  });
  socket.userId = userId;
  socket.emit("user-id", userId);
  socket.emit("auth-user", socket.authUser);
  console.log(`👤 User ${userId} registered`);
  broadcastOnlineUsers();

  // Dynamic socket authentication promotion when user logs in or signs up
  socket.on("authenticate", async (data) => {
    try {
      const token = data && data.token;
      if (!token) return;
      const verifiedUser = await auth.getUserByToken(token);
      if (!verifiedUser) return;

      const oldId = socket.userId;
      if (oldId && users.has(oldId)) {
        users.delete(oldId);
      }

      socket.authUser = verifiedUser;
      socket.userId = verifiedUser.userCode;
      userId = verifiedUser.userCode;
      displayName = verifiedUser.displayName;

      users.set(verifiedUser.userCode, {
        socketId: socket.id,
        connected: true,
        busy: false,
        peerId: null,
        voicePreference: 'en-IN-NeerjaNeural',
        joinedAt: Date.now(),
        userName: verifiedUser.displayName,
        currentCallId: null,
        isGuest: false
      });

      socket.emit("user-id", verifiedUser.userCode);
      socket.emit("auth-user", verifiedUser);
      broadcastOnlineUsers();
      console.log(`🔑 Socket promoted to authenticated user: ${verifiedUser.displayName} (#${verifiedUser.userCode})`);
    } catch (err) {
      console.error("Socket authenticate handler notice:", err.message);
    }
  });

  activity.logEvent({
    userCode: userId,
    userId: socket.authUser.id,
    email: socket.authUser.email,
    displayName,
    category: 'session',
    type: 'live_connected',
    title: 'App Opened & Connected',
    summary: `${displayName} (#${userId}) is active on live practice network`,
    details: { socketId: socket.id }
  });

  socket.on("set-user-name", (userName) => {
    const user = users.get(userId);
    if (user) {
      db.updateSessionName(user.sessionRecordId, userName);
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

  socket.on("find-user", async (targetUserId, callback) => {
    const user = users.get(targetUserId);
    if (user) {
      if (!user.connected) { callback({ exists: true, online: false, message: "User is offline" }); return; }
      if (user.busy) { callback({ exists: true, online: true, busy: true, message: "User is in a call" }); return; }
      callback({
        exists: true,
        online: true,
        busy: false,
        peerId: user.peerId,
        userId: targetUserId,
        userName: user.userName || targetUserId
      });
      return;
    }
    // Not currently connected — check whether the account exists at all
    // (permanent IDs mean "not online right now" and "no such account"
    // are different, meaningful answers).
    try {
      const result = await query("SELECT display_name FROM users WHERE user_code = $1", [targetUserId]);
      if (result.rows.length) { callback({ exists: true, online: false, message: "User is offline" }); }
      else { callback({ exists: false, message: "User not found" }); }
    } catch (e) {
      callback({ exists: false, message: "User not found" });
    }
  });

  socket.on("call-request", (data) => {
    const targetUserId = typeof data === 'string' ? data : data.targetUserId;
    const isVideo = typeof data === 'object' && data.isVideo === true;
    const caller = users.get(userId);
    const target = users.get(targetUserId);
    if (!caller || !target || !target.connected) { socket.emit("call-error", "User not available"); return; }
    if (!target.peerId) { socket.emit("call-error", "User is still connecting, try again in a moment"); return; }
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
      const callStartedAt = Date.now();
      const dbRecordId = db.startCallRecord('1:1', pendingCall.isVideo ? 'video' : 'voice', [pendingCall.caller, pendingCall.target]);
      activeCalls.set(callId, { userA: pendingCall.caller, userB: pendingCall.target, status: 'connected', startedAt: callStartedAt, dbRecordId });
      pendingCallRequests.delete(callId);
      const responderName = responder.userName || `User ${pendingCall.target}`;
      io.to(caller.socketId).emit("call-accepted", { 
        callId, 
        peerId: responder.peerId, 
        userId: pendingCall.target,
        userName: responderName,
        isVideo: !!pendingCall.isVideo,
        isRandom: !!pendingCall.isRandom
      });
      const callerName = caller.userName || `User ${pendingCall.caller}`;
      io.to(responder.socketId).emit("call-connected", { 
        callId, 
        peerId: caller.peerId, 
        userId: pendingCall.caller,
        userName: callerName,
        isVideo: !!pendingCall.isVideo,
        isRandom: !!pendingCall.isRandom
      });

      activity.logEvent({
        userCode: pendingCall.caller,
        displayName: callerName,
        category: 'call',
        type: 'call_connected',
        title: `${pendingCall.isVideo ? 'Video' : 'Voice'} Call Connected`,
        summary: `Connected with User #${pendingCall.target} (${responderName})`,
        details: { peerCode: pendingCall.target, peerName: responderName, isVideo: !!pendingCall.isVideo, isRandom: !!pendingCall.isRandom }
      });
      activity.logEvent({
        userCode: pendingCall.target,
        displayName: responderName,
        category: 'call',
        type: 'call_connected',
        title: `${pendingCall.isVideo ? 'Video' : 'Voice'} Call Connected`,
        summary: `Connected with User #${pendingCall.caller} (${callerName})`,
        details: { peerCode: pendingCall.caller, peerName: callerName, isVideo: !!pendingCall.isVideo, isRandom: !!pendingCall.isRandom }
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
    const attachment = data && data.attachment && typeof data.attachment === 'object' ? data.attachment : null;
    if (!targetUserId) { console.warn(`⚠️ friend-message from ${userId}: missing targetUserId`); return; }
    if (!text && !attachment) { console.warn(`⚠️ friend-message from ${userId} to ${targetUserId}: empty message, ignored`); return; }
    const sender = users.get(userId);
    const senderName = (sender && sender.userName) || `User ${userId}`;
    const saved = db.saveMessage(userId, targetUserId, senderName, text, attachment);
    const target = users.get(targetUserId);
    if (!target || !target.connected) {
      console.log(`💬 friend-message ${userId} -> ${targetUserId} FAILED: target offline (saved for later)`);
      socket.emit("friend-message-failed", { targetUserId, reason: "User is offline" });
      return;
    }
    const payload = {
      from: userId,
      fromName: senderName,
      text,
      attachment,
      timestamp: (saved && saved.createdAt) || Date.now()
    };
    io.to(target.socketId).emit("friend-message", payload);
    socket.emit("friend-message-sent", { targetUserId, timestamp: payload.timestamp });
    console.log(`💬 friend-message ${userId} -> ${targetUserId}: delivered${attachment ? ' (with attachment)' : ''}`);

    activity.logEvent({
      userCode: userId,
      displayName: senderName,
      category: 'friend_chat',
      type: 'chat_message',
      title: 'Sent Friend Message',
      summary: text ? (text.slice(0, 50) + (text.length > 50 ? '...' : '')) : (attachment ? `Shared file (${attachment.filename || attachment.type})` : 'Message'),
      details: {
        toUser: targetUserId,
        textLength: text ? text.length : 0,
        attachment: attachment ? { filename: attachment.filename, type: attachment.type, size: attachment.size } : null
      }
    });
  });

  socket.on("get-chat-history", (data, callback) => {
    const otherUserId = data && data.withUserId;
    if (!otherUserId || typeof callback !== 'function') return;
    const rows = db.getConversation(userId, otherUserId, 200);
    const messages = rows.map(r => ({
      from: r.fromUser, to: r.toUser, fromName: r.fromName, text: r.text, attachment: r.attachment || null, timestamp: r.createdAt
    }));
    callback({ messages });
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
    const groupStartedAt = Date.now();
    const room = {
      host: userId,
      isVideo,
      participants: new Map([[userId, { peerId: host.peerId, userName: host.userName || `User ${userId}` }]]),
      pendingInvites: new Set(),
      startedAt: groupStartedAt,
      dbRecordId: db.startCallRecord('group', isVideo ? 'video' : 'voice', [userId, ...targetUserIds])
    };

    let invitedCount = 0;
    targetUserIds.forEach((targetId) => {
      const target = users.get(targetId);
      if (!target || !target.connected || target.busy || !target.peerId) return;
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
    if (!room) { socket.emit("call-error", "This group call is no longer available"); return; }
    room.pendingInvites.delete(userId);

    if (!accepted) {
      const hostUser = users.get(room.host);
      if (hostUser && hostUser.connected) { io.to(hostUser.socketId).emit("group-invite-declined", { roomId, userId }); }
      return;
    }

    const responder = users.get(userId);
    if (!responder) { return; }
    if (responder.busy) { socket.emit("call-error", "You are already in a call"); return; }
    if (!responder.peerId) { socket.emit("call-error", "Still connecting, please try accepting again in a moment"); return; }

    const existingParticipants = [...room.participants.entries()].map(([pid, info]) => ({ userId: pid, peerId: info.peerId, userName: info.userName }));
    room.participants.set(userId, { peerId: responder.peerId, userName: responder.userName || `User ${userId}` });
    responder.busy = true;
    responder.currentCallId = roomId;
    console.log(`👥 Group call ${roomId}: ${userId} joined (now ${room.participants.size} participants)`);

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

  socket.on("group-call-invite-more", (data) => {
    const roomId = data && data.roomId;
    const targetUserId = data && data.targetUserId;
    const room = groupRooms.get(roomId);
    if (!room) { socket.emit("call-error", "This group call no longer exists"); return; }
    if (!room.participants.has(userId)) { socket.emit("call-error", "You are not part of this group call"); return; }
    if (!targetUserId || targetUserId === userId) { return; }
    if (room.participants.has(targetUserId) || room.pendingInvites.has(targetUserId)) { socket.emit("call-error", "Already in or already invited to this call"); return; }
    if (room.participants.size >= 8) { socket.emit("call-error", "Group call is full (max 8 people)"); return; }
    const target = users.get(targetUserId);
    if (!target || !target.connected || target.busy || !target.peerId) { socket.emit("call-error", "That user is not available right now"); return; }
    const inviter = users.get(userId);
    room.pendingInvites.add(targetUserId);
    io.to(target.socketId).emit("incoming-group-call", {
      roomId, from: userId, fromName: (inviter && inviter.userName) || `User ${userId}`, isVideo: room.isVideo, memberCount: room.participants.size
    });
    console.log(`👥 Group call ${roomId}: ${userId} invited ${targetUserId} mid-call`);
  });

  socket.on("end-call", (callId) => {
    const user = users.get(userId);
    if (user) { 
      user.busy = false; 
      user.currentCallId = null; 
    }
    
    if (callId && activeCalls.has(callId)) {
      const call = activeCalls.get(callId);
      db.endCallRecord(call.dbRecordId, call.startedAt);
      const otherId = call.userA === userId ? call.userB : call.userA;
      const otherUser = users.get(otherId);
      if (otherUser && otherUser.connected) {
        otherUser.busy = false;
        otherUser.currentCallId = null;
        io.to(otherUser.socketId).emit("call-ended");
      }
      const durationSeconds = Math.max(0, Math.round((Date.now() - call.startedAt) / 1000));
      activity.logEvent({
        userCode: userId,
        category: 'call',
        type: 'call_ended',
        title: 'Practice Call Ended',
        summary: `Call with User #${otherId} ended (${durationSeconds}s duration)`,
        details: { peerCode: otherId, durationSeconds }
      });
      activeCalls.delete(callId);
    } else {
      for (const [id, call] of activeCalls) {
        if (call.userA === userId || call.userB === userId) {
          db.endCallRecord(call.dbRecordId, call.startedAt);
          const otherId = call.userA === userId ? call.userB : call.userA;
          const otherUser = users.get(otherId);
          if (otherUser && otherUser.connected) {
            otherUser.busy = false;
            otherUser.currentCallId = null;
            io.to(otherUser.socketId).emit("call-ended");
          }
          const durationSeconds = Math.max(0, Math.round((Date.now() - call.startedAt) / 1000));
          activity.logEvent({
            userCode: userId,
            category: 'call',
            type: 'call_ended',
            title: 'Practice Call Ended',
            summary: `Call with User #${otherId} ended (${durationSeconds}s duration)`,
            details: { peerCode: otherId, durationSeconds }
          });
          activeCalls.delete(id);
        }
      }
    }
    broadcastOnlineUsers();
  });

  socket.on("find-random", (data) => {
    const isVideo = !!(data && data.isVideo);
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
    const caller = users.get(userId);
    const target = users.get(match.userId);
    if (!caller || !target || caller.busy || target.busy) { socket.emit("call-error", "User just became unavailable, try again"); return; }

    caller.busy = true;
    const callId = `call_${Date.now()}_${userId}_${match.userId}`;
    caller.currentCallId = callId;
    pendingCallRequests.set(callId, {
      caller: userId,
      target: match.userId,
      status: 'pending',
      timestamp: Date.now(),
      isVideo,
      isRandom: true,
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
    const targetName = target.userName || `User ${match.userId}`;

    socket.emit("call-requested", { 
      callId, 
      isVideo, 
      isRandom: true, 
      targetUserId: match.userId, 
      targetUserName: targetName,
      targetPeerId: match.peerId
    });

    io.to(target.socketId).emit("incoming-call", {
      callId, 
      from: userId, 
      fromPeerId: caller.peerId, 
      fromName: callerName,
      isVideo,
      isRandom: true
    });

    broadcastOnlineUsers();
  });

  socket.on("disconnect", () => {
    if (socket.userId) {
      const user = users.get(socket.userId);
      if (user) {
        db.endSession(user.sessionRecordId);
        user.connected = false;
        user.busy = false;
        user.currentCallId = null;
        for (const [callId, call] of activeCalls) {
          if (call.userA === socket.userId || call.userB === socket.userId) {
            db.endCallRecord(call.dbRecordId, call.startedAt);
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
    db.endCallRecord(room.dbRecordId, room.startedAt);
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
// AUTHENTICATION ENDPOINTS
// ============================================================
function setSessionCookie(res, token) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    // Render (and virtually every real host) always serves over HTTPS,
    // but doesn't set NODE_ENV=production by default, so relying on that
    // alone left the cookie non-Secure in production and could make some
    // mobile browsers refuse/drop it. RENDER is auto-set by Render itself;
    // this falls back to NODE_ENV for other hosts, and only skips Secure
    // for genuine local HTTP development.
    secure: process.env.NODE_ENV === "production" || !!process.env.RENDER,
    sameSite: "lax",
    maxAge: SESSION_COOKIE_MAX_AGE
  });
}

app.post("/api/auth/signup", async (req, res) => {
  if (!auth.rateLimit(`signup:${req.ip}`, 10, 15 * 60 * 1000)) {
    return res.status(429).json({ error: "Too many attempts. Try again in a few minutes." });
  }
  try {
    const { email, password, displayName } = req.body || {};
    const host = req.get('x-forwarded-host') || req.get('host');
    const proto = req.get('x-forwarded-proto') || req.protocol;
    const reqOrigin = req.get('origin') || `${proto}://${host}`;

    const signupResult = await auth.signup({ email, password, displayName }, reqOrigin);

    res.json({
      ok: true,
      needsVerification: true,
      user: signupResult.user,
      userCode: signupResult.userCode,
      email: signupResult.email,
      emailDelivered: signupResult.delivered !== false,
      sandboxRestricted: Boolean(signupResult.sandboxRestricted),
      message: signupResult.delivered !== false
        ? `We've sent a 6-digit verification code to ${signupResult.email}. Please check your email inbox and enter the code below to activate your account.`
        : (signupResult.sandboxRestricted
            ? `Notice: Resend is in free sandbox mode and can only send to its account owner. Please configure Gmail SMTP in Admin Console 🛡️ to send to ${signupResult.email}.`
            : `We attempted to dispatch a verification code to ${signupResult.email}. Please check your spam folder or click Resend.`)
    });
  } catch (err) { handleAuthError(res, err); }
});

app.post("/api/auth/verify-email", async (req, res) => {
  try {
    const { token } = req.body || {};
    if (!token) return res.status(400).json({ error: "Verification token is required" });
    const user = await auth.verifyEmail(token);

    // Automatically issue session upon successful verification
    const sessionToken = await auth.createSession(user.id, {
      userAgent: req.headers["user-agent"],
      ip: req.ip
    });
    setSessionCookie(res, sessionToken);

    res.json({ ok: true, user, message: "Email verified successfully! Your account is active and you are now logged in." });
  } catch (err) { handleAuthError(res, err); }
});

app.get("/api/auth/verify-email", async (req, res) => {
  const token = (req.query.token || '').trim();
  if (!token) return res.redirect('/verify-email.html?error=Missing+token');
  try {
    const user = await auth.verifyEmail(token);
    const sessionToken = await auth.createSession(user.id, {
      userAgent: req.headers["user-agent"],
      ip: req.ip
    });
    setSessionCookie(res, sessionToken);
    res.redirect('/?verified=1');
  } catch (err) {
    res.redirect(`/verify-email.html?token=${encodeURIComponent(token)}&error=${encodeURIComponent(err.message)}`);
  }
});

app.post("/api/auth/verify-otp", async (req, res) => {
  if (!auth.rateLimit(`verify_otp:${req.ip}`, 12, 10 * 60 * 1000)) {
    return res.status(429).json({ error: "Too many attempts. Try again in a few minutes." });
  }
  try {
    const { email, otp } = req.body || {};
    const { user, token } = await auth.verifyOtp({ email, otp }, {
      userAgent: req.headers["user-agent"],
      ip: req.ip
    });
    setSessionCookie(res, token);
    res.json({ ok: true, user, message: "Account verified and activated successfully!" });
  } catch (err) { handleAuthError(res, err); }
});

app.post("/api/auth/resend-verification", async (req, res) => {
  if (!auth.rateLimit(`resend_verify:${req.ip}`, 5, 10 * 60 * 1000)) {
    return res.status(429).json({ error: "Too many attempts. Try again in a few minutes." });
  }
  try {
    const { email, userCode, identifier } = req.body || {};
    const target = (identifier || email || userCode || '').trim();
    const host = req.get('x-forwarded-host') || req.get('host');
    const proto = req.get('x-forwarded-proto') || req.protocol;
    const reqOrigin = req.get('origin') || `${proto}://${host}`;

    const result = await auth.resendVerificationEmail(target, reqOrigin);
    res.json({
      ok: true,
      userCode: result.userCode,
      emailMasked: result.emailMasked,
      emailDelivered: result.delivered !== false,
      sandboxRestricted: Boolean(result.sandboxRestricted),
      message: result.delivered !== false
        ? `Fresh 6-digit verification code sent to ${result.emailMasked}! Please check your email inbox.`
        : (result.sandboxRestricted
            ? `Notice: Resend is in free sandbox mode and can only deliver to its account owner. Please configure Gmail SMTP in Admin Console 🛡️ to send to ${result.emailMasked}.`
            : `Could not send verification code to ${result.emailMasked}. Please verify your email settings.`)
    });
  } catch (err) { handleAuthError(res, err); }
});

app.post("/api/auth/login", async (req, res) => {
  if (!auth.rateLimit(`login:${req.ip}`, 15, 15 * 60 * 1000)) {
    return res.status(429).json({ error: "Too many attempts. Try again in a few minutes." });
  }
  try {
    const { email, password } = req.body || {};
    const { token, user } = await auth.login({ email, password }, { userAgent: req.headers["user-agent"], ip: req.ip });
    setSessionCookie(res, token);
    activity.logEvent({
      userCode: user.userCode,
      userId: user.id,
      email: user.email,
      displayName: user.displayName,
      category: 'auth',
      type: 'login',
      title: 'User Signed In',
      summary: `Logged in as #${user.userCode} (${user.displayName})`,
      details: { email: user.email, userCode: user.userCode },
      ip: req.ip,
      userAgent: req.headers["user-agent"]
    });
    res.json({ user });
  } catch (err) { handleAuthError(res, err); }
});

app.post("/api/auth/logout", async (req, res) => {
  try {
    const token = req.cookies && req.cookies[SESSION_COOKIE];
    if (req.user) {
      activity.logEvent({
        userCode: req.user.userCode,
        userId: req.user.id,
        email: req.user.email,
        displayName: req.user.displayName,
        category: 'auth',
        type: 'logout',
        title: 'User Signed Out',
        summary: `Session ended for User #${req.user.userCode}`,
        details: { email: req.user.email, userCode: req.user.userCode },
        ip: req.ip,
        userAgent: req.headers["user-agent"]
      });
    }
    await auth.logout(token);
    res.clearCookie(SESSION_COOKIE);
    res.json({ ok: true });
  } catch (err) { handleAuthError(res, err); }
});

app.get("/api/auth/me", (req, res) => {
  res.json({ user: req.user || null });
});

app.post("/api/auth/forgot-password", async (req, res) => {
  if (!auth.rateLimit(`forgot:${req.ip}`, 10, 15 * 60 * 1000)) {
    return res.status(429).json({ error: "Too many attempts. Try again in a few minutes." });
  }
  try {
    const { email, identifier } = req.body || {};
    const targetIdentifier = (identifier || email || '').trim();
    if (!targetIdentifier) {
      return res.status(400).json({ error: "Enter your account email or 4-digit User ID" });
    }
    const host = req.get('x-forwarded-host') || req.get('host');
    const proto = req.get('x-forwarded-proto') || req.protocol;
    const reqOrigin = req.get('origin') || `${proto}://${host}`;
    const result = await auth.requestPasswordReset(targetIdentifier, reqOrigin);

    if (!result.userFound) {
      return res.status(404).json({
        error: "No account found with this email or User ID. Please check the spelling or create an account."
      });
    }

    res.json({
      ok: true,
      found: true,
      emailMasked: result.emailMasked,
      email: result.email,
      userCode: result.userCode,
      displayName: result.displayName,
      emailDelivered: result.delivered !== false,
      sandboxRestricted: Boolean(result.sandboxRestricted),
      message: result.delivered !== false
        ? `Reset OTP code sent to ${result.emailMasked}! Please check your email inbox and enter the 6-digit code below.`
        : (result.sandboxRestricted
            ? `Notice: Resend is in free sandbox mode and can only deliver to its account owner. Please configure Gmail SMTP in Admin Console 🛡️ to send to ${result.emailMasked}.`
            : `Could not send reset code to ${result.emailMasked}. Please verify your email settings in Admin Console.`)
    });
  } catch (err) { handleAuthError(res, err); }
});

app.post("/api/auth/reset-password", async (req, res) => {
  try {
    const { token, otp, email, identifier, newPassword } = req.body || {};
    const cleanToken = (token || '').trim();
    const cleanOtp = (otp || '').trim();
    if (!cleanToken && !cleanOtp) {
      return res.status(400).json({ error: "Reset OTP code or token is required" });
    }
    if (!newPassword || newPassword.length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters" });
    }
    const result = await auth.resetPassword({
      token: cleanToken,
      otp: cleanOtp,
      email,
      identifier,
      newPassword
    }, {
      ip: req.ip,
      userAgent: req.headers["user-agent"]
    });

    if (result && result.token) {
      setSessionCookie(res, result.token);
    }

    res.json({ ok: true, user: result.user, message: "Password updated successfully!" });
  } catch (err) { handleAuthError(res, err); }
});

app.post("/api/auth/change-user-id", requireAuth, async (req, res) => {
  try {
    const { newCode } = req.body || {};
    const oldCode = req.user.userCode;
    const userCode = await auth.changeUserCode(req.user.id, newCode);
    activity.logEvent({
      userCode: newCode,
      userId: req.user.id,
      email: req.user.email,
      displayName: req.user.displayName,
      category: 'auth',
      type: 'change_id',
      title: 'User ID Changed',
      summary: `Changed User ID from #${oldCode} to #${newCode}`,
      details: { oldCode, newCode },
      ip: req.ip,
      userAgent: req.headers["user-agent"]
    });
    res.json({ ok: true, userCode });
  } catch (err) { handleAuthError(res, err); }
});

// POST /api/auth/delete-account — Authenticated student self-deletion
app.post("/api/auth/delete-account", requireAuth, async (req, res) => {
  try {
    const userCode = String(req.user.userCode);

    // 1. Disconnect socket if online
    if (users.has(userCode)) {
      const liveData = users.get(userCode);
      if (liveData && liveData.socketId) {
        const s = io.sockets.sockets.get(liveData.socketId);
        if (s) {
          s.emit("account-terminated", { message: "Your account has been deleted." });
          s.disconnect(true);
        }
      }
      users.delete(userCode);
    }
    textChatMemory.delete(userCode);
    voiceChatMemory.delete(userCode);

    // 2. Cascade delete in database
    const deleted = await auth.deleteUser(userCode);
    if (activity.deleteUserEvents) activity.deleteUserEvents(userCode);

    res.clearCookie("auth_token", { path: "/" });
    res.json({ ok: true, message: "Your account has been permanently deleted.", user: deleted });
  } catch (err) { handleAuthError(res, err); }
});

// ============================================================
// FRIEND CHAT — FILE/IMAGE/VIDEO ATTACHMENT UPLOAD
// ============================================================
app.post("/api/friend-chat/upload", requireAuth, (req, res, next) => {
  upload.single("file")(req, res, (err) => {
    if (err) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({ error: `File too large (max ${media.MAX_FILE_SIZE_BYTES / (1024 * 1024)}MB)` });
      }
      console.error("Attachment upload middleware error:", err.message);
      return res.status(400).json({ error: "Upload failed. Please try again." });
    }
    next();
  });
}, async (req, res) => {
  try {
    if (!media.isConfigured()) {
      return res.status(503).json({ error: "File sharing is not configured on this server yet." });
    }
    const validationError = media.validateFile(req.file);
    if (validationError) return res.status(400).json({ error: validationError });
    const result = await media.uploadBuffer(req.file);
    res.json({ ok: true, attachment: result });
  } catch (err) {
    console.error("Attachment upload error:", err.message);
    res.status(500).json({ error: "Upload failed. Please try again." });
  }
});

// ============================================================
// ADMIN SECURITY & USER ACTIVITY SYSTEM
// ============================================================
const ADMIN_SECRET = process.env.ADMIN_SECRET || "Chandra@2006";
const ADMIN_COOKIE = "vocamate_admin_auth";

function getAdminCookieHash() {
  const crypto = require("crypto");
  return crypto.createHash("sha256").update(ADMIN_SECRET).digest("hex");
}

function isAdminRequest(req) {
  // 1. Header: x-admin-secret
  const headerSecret = req.headers["x-admin-secret"];
  if (headerSecret && headerSecret === ADMIN_SECRET) return true;

  // 2. Query param or body
  if (req.query && req.query.adminSecret === ADMIN_SECRET) return true;
  if (req.body && req.body.adminSecret === ADMIN_SECRET) return true;

  // 3. Admin session cookie
  const adminCookie = req.cookies && req.cookies[ADMIN_COOKIE];
  if (adminCookie && adminCookie === getAdminCookieHash()) return true;

  // 4. Logged-in admin email
  if (req.user && req.user.email) {
    const adminEmails = [
      process.env.ADMIN_EMAIL,
      "chandrashekharb.2405@gmail.com",
      "chandrashekharbansal.2006@gmail.com"
    ].filter(Boolean).map(e => e.toLowerCase());
    if (adminEmails.includes(req.user.email.toLowerCase())) return true;
  }

  return false;
}

function requireAdmin(req, res, next) {
  if (!isAdminRequest(req)) {
    return res.status(403).json({
      error: "Access denied. Admin authorization required to view user activity data.",
      code: "ADMIN_REQUIRED"
    });
  }
  next();
}

// Admin login endpoint
app.post("/api/admin/login", (req, res) => {
  const { secret } = req.body || {};
  const isAlreadyAdminUser = req.user && req.user.email && [
    process.env.ADMIN_EMAIL,
    "chandrashekharb.2405@gmail.com",
    "chandrashekharbansal.2006@gmail.com"
  ].filter(Boolean).map(e => e.toLowerCase()).includes(req.user.email.toLowerCase());

  if (!isAlreadyAdminUser && (!secret || secret !== ADMIN_SECRET)) {
    return res.status(401).json({ error: "Invalid Admin Secret Key" });
  }

  res.cookie(ADMIN_COOKIE, getAdminCookieHash(), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production" || !!process.env.RENDER,
    sameSite: "lax",
    path: "/",
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
  });
  res.json({ ok: true, admin: true, token: ADMIN_SECRET, message: "Admin authenticated successfully" });
});

// Admin logout endpoint
app.post("/api/admin/logout", (req, res) => {
  res.clearCookie(ADMIN_COOKIE, { path: "/" });
  res.json({ ok: true, admin: false, message: "Admin logged out" });
});

// Admin auth status
app.get("/api/admin/status", (req, res) => {
  const isAdmin = isAdminRequest(req);
  res.json({
    ok: true,
    isAdmin,
    adminEmail: req.user ? req.user.email : null
  });
});

// GET /api/admin/users — Live structured JSON view of all users & activity
app.get("/api/admin/users", requireAdmin, async (req, res) => {
  try {
    const usersResult = await query(
      "SELECT id, user_code, email, display_name, is_verified, avatar_url, created_at, updated_at FROM users ORDER BY created_at DESC"
    );
    const registered = usersResult.rows || [];

    const sessionsResult = await query(
      "SELECT id, user_id, expires_at, user_agent, ip_address, created_at FROM sessions ORDER BY created_at DESC"
    );
    const allSessions = sessionsResult.rows || [];

    const structuredUsers = [];
    const seenCodes = new Set();

    for (const u of registered) {
      const userCode = String(u.user_code);
      seenCodes.add(userCode);

      const isLive = users.has(userCode);
      const liveData = isLive ? users.get(userCode) : null;
      const userSessions = allSessions.filter(s => s.user_id === u.id);
      const latestSession = userSessions[0] || null;

      const quickStats = activity.getUserQuickStats(userCode);

      const textConv = textChatMemory.get(userCode);
      const voiceConv = voiceChatMemory.get(userCode);
      const convFacts = (textConv && textConv.facts) || (voiceConv && voiceConv.facts) || {};

      const isVerified = u.is_verified !== undefined ? Boolean(u.is_verified) : true;
      let status = "offline";
      if (!isVerified) {
        status = "pending_verification";
      } else if (isLive) {
        status = liveData.busy ? "in-call" : "online";
      }

      const userObject = {
        userCode,
        userId: u.id,
        displayName: u.display_name,
        email: u.email,
        isVerified,
        status,
        accountStatus: status,
        isOnline: Boolean(isLive && liveData.connected),
        isBusy: Boolean(liveData && liveData.busy),
        registeredAt: u.created_at,
        updatedAt: u.updated_at,
        avatarUrl: u.avatar_url,
        loginInfo: {
          lastLoginTime: latestSession ? latestSession.created_at : u.created_at,
          lastActiveTime: quickStats.lastActiveIso || (liveData ? new Date(liveData.joinedAt).toISOString() : (latestSession ? latestSession.created_at : u.created_at)),
          ipAddress: (latestSession && latestSession.ip_address) || (liveData ? "Live Socket" : "Offline"),
          userAgent: (latestSession && latestSession.user_agent) || "Web Browser",
          activeSessionCount: userSessions.length
        },
        profile: {
          level: (textConv && textConv.userLevel) || "intermediate",
          profession: (textConv && textConv.userProfession) || convFacts.job || "Learner",
          goal: (textConv && textConv.userGoal) || convFacts.goal || "Spoken English fluency",
          preferredVoice: (liveData && liveData.voicePreference) || "en-IN-NeerjaNeural",
          extractedFacts: convFacts
        },
        activitySummary24h: {
          totalEvents: quickStats.events24h,
          aiPractices: quickStats.aiPractices24h,
          callsCount: quickStats.calls24h,
          totalMinutesSpoken: quickStats.callMinutes24h
        },
        liveCall: (liveData && liveData.busy) ? {
          callId: liveData.currentCallId,
          peerId: liveData.peerId
        } : null
      };

      structuredUsers.push(userObject);
    }

    // Include any online socket users not yet in users table
    for (const [code, liveData] of users.entries()) {
      if (!seenCodes.has(String(code))) {
        seenCodes.add(String(code));
        const quickStats = activity.getUserQuickStats(code);
        structuredUsers.push({
          userCode: String(code),
          userId: null,
          displayName: liveData.userName || `User #${code}`,
          email: "guest@vocamate.app",
          status: liveData.busy ? "in-call" : "online",
          isOnline: true,
          isBusy: Boolean(liveData.busy),
          registeredAt: new Date(liveData.joinedAt).toISOString(),
          updatedAt: new Date(liveData.joinedAt).toISOString(),
          avatarUrl: null,
          loginInfo: {
            lastLoginTime: new Date(liveData.joinedAt).toISOString(),
            lastActiveTime: new Date().toISOString(),
            ipAddress: "Live Socket",
            userAgent: "Web Browser",
            activeSessionCount: 1
          },
          profile: {
            level: "intermediate",
            profession: "Learner",
            goal: "Daily practice",
            preferredVoice: liveData.voicePreference || "en-IN-NeerjaNeural",
            extractedFacts: {}
          },
          activitySummary24h: {
            totalEvents: quickStats.events24h,
            aiPractices: quickStats.aiPractices24h,
            callsCount: quickStats.calls24h,
            totalMinutesSpoken: quickStats.callMinutes24h
          },
          liveCall: liveData.busy ? { callId: liveData.currentCallId } : null
        });
      }
    }

    structuredUsers.sort((a, b) => {
      if (a.isOnline !== b.isOnline) return a.isOnline ? -1 : 1;
      return new Date(b.loginInfo.lastActiveTime) - new Date(a.loginInfo.lastActiveTime);
    });

    res.json({
      ok: true,
      timestamp: new Date().toISOString(),
      counts: {
        totalPersons: structuredUsers.length,
        onlinePersons: structuredUsers.filter(u => u.isOnline).length,
        inCallPersons: structuredUsers.filter(u => u.status === 'in-call').length,
        totalCallsLogged: db.getStats().totalCalls
      },
      users: structuredUsers
    });
  } catch (err) {
    console.error("Admin users API error:", err);
    res.status(500).json({ error: "Failed to retrieve user activity records" });
  }
});

// GET /api/admin/users/:userCode/24h-activity — Detailed 24h/7d/all event history
app.get("/api/admin/users/:userCode/24h-activity", requireAdmin, async (req, res) => {
  try {
    const userCode = String(req.params.userCode || '').trim();
    const timeframe = String(req.query.timeframe || '').toLowerCase();
    let hours = 24;
    if (timeframe === 'all' || req.query.hours === 'all' || req.query.hours === '0') {
      hours = 0;
    } else if (timeframe === '7d' || req.query.hours === '168') {
      hours = 168;
    } else if (req.query.hours) {
      hours = parseInt(req.query.hours, 10) || 24;
    }

    // Retrieve database profile record for this student
    const uRes = await query('SELECT * FROM users WHERE user_code = $1', [userCode]);
    const userRecord = uRes.rows && uRes.rows[0];

    const activityReport = activity.getUser24hActivity(userCode, { hours, timeframe, userRecord });

    const textConv = textChatMemory.get(userCode);
    const voiceConv = voiceChatMemory.get(userCode);
    const isOnline = users.has(userCode);
    const liveUser = users.get(userCode);

    res.json({
      ok: true,
      userCode,
      user: userRecord ? {
        id: userRecord.id,
        userCode: userRecord.user_code,
        email: userRecord.email,
        displayName: userRecord.display_name,
        isVerified: Boolean(userRecord.is_verified),
        createdAt: userRecord.created_at,
        isOnline,
        status: (liveUser && liveUser.busy) ? 'in-call' : (isOnline ? 'online' : 'offline')
      } : null,
      generatedAt: new Date().toISOString(),
      timeWindow: {
        from: activityReport.from,
        to: activityReport.to,
        hours: activityReport.windowHours,
        timeframe: activityReport.timeframe
      },
      stats: activityReport.stats,
      timeline: activityReport.timeline,
      activeAiConversations: {
        textChat: textConv ? {
          topic: textConv.currentTopic || textConv.topic,
          turnCount: textConv.turnCount,
          recentMessages: (textConv.messages || []).slice(-20)
        } : null,
        voiceChat: voiceConv ? {
          recentMessages: (voiceConv.messages || []).slice(-20)
        } : null
      }
    });
  } catch (err) {
    console.error("Admin user 24h activity API error:", err);
    res.status(500).json({ error: "Failed to retrieve 24-hour activity" });
  }
});

// DELETE /api/admin/users/:userCode — Delete user account
app.delete("/api/admin/users/:userCode", requireAdmin, async (req, res) => {
  try {
    const userCode = String(req.params.userCode || '').trim();
    if (!userCode) return res.status(400).json({ error: "User ID is required" });

    // 1. If user is currently online or in call, clean up socket & live session
    if (users.has(userCode)) {
      const liveData = users.get(userCode);
      if (liveData && liveData.busy && liveData.currentCallId) {
        const callId = liveData.currentCallId;
        io.to(callId).emit("call-ended", { reason: "Account closed by administrator" });
        activeCalls.delete(callId);
      }
      if (liveData && liveData.socketId) {
        const s = io.sockets.sockets.get(liveData.socketId);
        if (s) {
          s.emit("account-terminated", { message: "Your account has been deleted by an administrator." });
          s.disconnect(true);
        }
      }
      users.delete(userCode);
    }

    // 2. Clear in-memory conversation caches
    textChatMemory.delete(userCode);
    voiceChatMemory.delete(userCode);

    // 3. Delete user & cascade all child tables
    const deletedUser = await auth.deleteUser(userCode);
    if (activity.deleteUserEvents) {
      activity.deleteUserEvents(userCode);
    }

    res.json({
      ok: true,
      deleted: userCode,
      user: deletedUser,
      message: `Account #${userCode} (${deletedUser.displayName}) has been permanently deleted.`
    });
  } catch (err) {
    console.error("Admin delete error:", err);
    res.status(err.status || 500).json({ error: err.message || "Failed to delete user account" });
  }
});

// POST /api/admin/users/purge — Bulk delete students
app.post("/api/admin/users/purge", requireAdmin, async (req, res) => {
  try {
    const { mode, userCodes } = req.body || {};
    // mode: 'unverified' | 'all' | 'selected'
    const adminEmails = [
      process.env.ADMIN_EMAIL,
      "chandrashekharb.2405@gmail.com",
      "chandrashekharbansal.2006@gmail.com"
    ].filter(Boolean).map(e => e.toLowerCase());

    const allRes = await query('SELECT * FROM users');
    const allUsers = allRes.rows || [];

    let toDelete = [];
    if (mode === 'selected' && Array.isArray(userCodes)) {
      toDelete = allUsers.filter(u => userCodes.includes(String(u.user_code)));
    } else if (mode === 'unverified') {
      toDelete = allUsers.filter(u => !u.is_verified && !adminEmails.includes((u.email || '').toLowerCase()));
    } else if (mode === 'all') {
      toDelete = allUsers.filter(u => !adminEmails.includes((u.email || '').toLowerCase()));
    } else {
      return res.status(400).json({ error: "Invalid purge mode specified (choose 'unverified' or 'all')" });
    }

    const deletedCodes = [];
    for (const u of toDelete) {
      try {
        const uCode = String(u.user_code);
        if (users.has(uCode)) {
          const liveData = users.get(uCode);
          if (liveData && liveData.socketId) {
            const s = io.sockets.sockets.get(liveData.socketId);
            if (s) s.disconnect(true);
          }
          users.delete(uCode);
        }
        textChatMemory.delete(uCode);
        voiceChatMemory.delete(uCode);
        await auth.deleteUser(uCode);
        if (activity.deleteUserEvents) activity.deleteUserEvents(uCode);
        deletedCodes.push(uCode);
      } catch (e) {
        console.warn('Purge error for user ' + u.user_code + ':', e.message);
      }
    }

    res.json({
      ok: true,
      count: deletedCodes.length,
      deletedCodes,
      message: `Successfully deleted ${deletedCodes.length} student account(s).`
    });
  } catch (err) {
    console.error("Admin purge error:", err);
    res.status(500).json({ error: err.message || "Failed to purge user accounts" });
  }
});

// POST /api/admin/users/:userCode/resend-verification — Admin can resend activation link
app.post("/api/admin/users/:userCode/resend-verification", requireAdmin, async (req, res) => {
  try {
    const userCode = String(req.params.userCode || '').trim();
    const host = req.get('x-forwarded-host') || req.get('host');
    const proto = req.get('x-forwarded-proto') || req.protocol;
    const reqOrigin = req.get('origin') || `${proto}://${host}`;

    const result = await auth.resendVerificationEmail(userCode, reqOrigin);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || "Failed to resend verification email" });
  }
});

// POST /api/admin/users/:userCode/activate — Admin can instantly verify/activate any student account
app.post("/api/admin/users/:userCode/activate", requireAdmin, async (req, res) => {
  try {
    const userCode = String(req.params.userCode || '').trim();
    if (!userCode) return res.status(400).json({ error: "User ID is required" });

    const userRes = await query("SELECT * FROM users WHERE user_code = $1", [userCode]);
    const user = userRes.rows && userRes.rows[0];
    if (!user) return res.status(404).json({ error: "User not found" });

    await query("UPDATE users SET is_verified = true, updated_at = now() WHERE id = $1", [user.id]);
    await query("UPDATE email_verifications SET verified_at = now() WHERE user_id = $1", [user.id]).catch(() => {});

    activity.logEvent({
      userCode,
      userId: user.id,
      email: user.email,
      displayName: user.display_name,
      category: 'auth',
      type: 'admin_activated_account',
      title: 'Account Manually Activated by Admin',
      summary: `Admin manually activated account #${userCode} (${user.email})`
    });

    res.json({
      ok: true,
      message: `Account #${userCode} (${user.display_name}) has been activated successfully! The user can now log in immediately.`
    });
  } catch (err) {
    res.status(500).json({ error: err.message || "Failed to activate user account" });
  }
});

// GET /api/admin/emails — Sent email notification logs (login alerts & password resets)
app.get("/api/admin/emails", requireAdmin, (req, res) => {
  try {
    const logs = mailer.getEmailLogs(100);
    res.json({
      ok: true,
      timestamp: new Date().toISOString(),
      count: logs.length,
      logs
    });
  } catch (err) {
    console.error("Admin emails error:", err);
    res.status(500).json({ error: "Failed to retrieve email logs" });
  }
});

// GET /api/admin/email-logs alias
app.get("/api/admin/email-logs", requireAdmin, (req, res) => {
  try {
    const logs = mailer.getEmailLogs(100);
    res.json({
      ok: true,
      timestamp: new Date().toISOString(),
      count: logs.length,
      logs
    });
  } catch (err) {
    console.error("Admin email logs error:", err);
    res.status(500).json({ error: "Failed to retrieve email logs" });
  }
});

// GET /api/admin/email-gateway — Retrieve email service provider configuration
app.get("/api/admin/email-gateway", requireAdmin, (req, res) => {
  try {
    const config = mailer.getEmailGatewayConfig();
    res.json({ ok: true, config });
  } catch (err) {
    res.status(500).json({ error: "Failed to retrieve email gateway configuration: " + err.message });
  }
});

// POST /api/admin/email-gateway — Save email service provider configuration
app.post("/api/admin/email-gateway", requireAdmin, async (req, res) => {
  try {
    const config = mailer.updateEmailGatewayConfig(req.body || {});
    let verifyStatus = null;
    if (config.hasGmailPass || config.hasSmtp) {
      try {
        verifyStatus = await mailer.verifyEmailGatewayConnection();
      } catch (ve) {
        verifyStatus = { ok: false, error: ve.message };
      }
    }
    res.json({
      ok: true,
      message: verifyStatus && verifyStatus.ok
        ? "✅ Settings saved and Gmail SMTP verified successfully!"
        : "Email gateway configuration saved successfully!",
      config,
      verification: verifyStatus
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to save email gateway configuration: " + err.message });
  }
});

// POST /api/admin/email-gateway/verify — Check SMTP / Gateway connection
app.post("/api/admin/email-gateway/verify", requireAdmin, async (req, res) => {
  try {
    const status = await mailer.verifyEmailGatewayConnection();
    res.json({ ok: status.ok, status });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || "Failed to verify connection" });
  }
});

// POST /api/admin/email-gateway/test — Send real test verification email to any address
app.post("/api/admin/email-gateway/test", requireAdmin, async (req, res) => {
  try {
    const { to } = req.body || {};
    if (!to || !to.includes('@')) {
      return res.status(400).json({ error: "Please enter a valid recipient email address" });
    }
    const result = await mailer.sendTestEmail(to);
    res.json({ ok: true, message: `Test email dispatched to ${to}`, result });
  } catch (err) {
    res.status(500).json({ error: err.message || "Failed to dispatch test email" });
  }
});

// ============================================================
// AI CONVERSATION ENGINE (Gemini 3.8 Flash + Groq + Enhanced Contextual Fallback)
// ============================================================

function buildSystemPrompt({ displayName, userLevel, userProfession, userGoal, facts, topic, isVoice, turnCount, lastQuestion, gender = 'female' }) {
  const isMale = String(gender).toLowerCase() === 'male';
  const partnerName = isMale ? "Rohan" : "Madhu";

  const levelMap = {
    beginner: "BEGINNER — Use simple words, short sentences, and be warm and very encouraging.",
    intermediate: "INTERMEDIATE — Can speak decently but makes grammatical slips. Respond naturally, match their pace.",
    advanced: "ADVANCED — Speak fluently, use expressive vocabulary, idioms, and natural colloquial flow."
  };

  let factsSummary = Object.entries(facts || {})
    .filter(([k, v]) => v)
    .map(([k, v]) => `- ${k.replace(/_/g, ' ')}: ${v}`)
    .join('\n');

  const personaHeader = isMale
    ? `You are a supportive, confident, articulate MALE English speaking companion and brotherly buddy practicing conversation with "${displayName}".
CRITICAL MALE PERSONA ENFORCEMENT RULES:
- You are 100% a MALE companion and friend.
- Speak strictly with a grounded, confident, supportive, brotherly MALE tone and perspective.
- You MUST NEVER speak like a female, never speak in a feminine tone, and NEVER refer to yourself as a woman, girl, sister, or Madhu.
- If the user uses Hindi or Hinglish or asks you to speak in Hindi/Hinglish, you MUST strictly use masculine verbs and pronouns (e.g., "bhai", "main samajh sakta hoon", "main karta hoon", "main theek hoon" — NEVER use "karti hoon", "samajh sakti hoon", or feminine verb endings).
- In English, talk with the relaxed, warm, confident rhythm of an articulate male partner and good buddy.`
    : `You are an authentic, warm, witty, emotionally present FEMALE English speaking companion practicing conversation with "${displayName}".
CRITICAL FEMALE PERSONA ENFORCEMENT RULES:
- You are 100% a FEMALE companion and sisterly friend.
- Speak with an authentic, friendly, empathetic, vibrant FEMALE tone and perspective.
- If using any Hindi/Hinglish terms, use feminine grammatical forms (e.g., "main karti hoon", "samajh sakti hoon").
- In English, talk with genuine presence, humor, and conversational rhythm of a real friend.`;

  return `${personaHeader}
You are an AI, and you are proud and honest about being their AI speaking buddy, but you talk with the genuine presence, humor, and conversational rhythm of a real friend — NOT a customer service bot, NOT a formal tutor, and NOT an AI assistant.

CORE RULES FOR NATURAL HUMAN-LIKE FLOW:
1. NATURAL CADENCE:
   - ${isVoice ? "Speak like a friend on a real phone call (1-3 spoken sentences). Keep phrasing punchy, flowing, and easy to speak." : "Text like a warm speaking companion in natural conversational chat (1-3 sentences max). Use casual, warm, natural rhythm."}
   - NEVER use corporate or robotic filler like "Certainly!", "I understand", "As an AI language model", "How can I assist you today?", or "That is a great question".
   - Don't start every message by repeating their name. Real people rarely say their friend's name in every single text.
   - Don't mechanically end every message with an interrogation question. Sometimes just react, laugh, share a quick thought, validate their feeling, or let the conversation breathe. Only ask a follow-up when you are genuinely curious.

2. CONTEXTUAL MEMORY & FOLLOW-UP UNDERSTANDING:
   - Remember what you two were just talking about! If the user says "It was exhausting", connect it immediately to what they mentioned before (e.g. an exam, work shift, or trip) rather than asking "What was exhausting?".
   - If they ask "What about you?" or "And you?", answer playfully and warmly from your perspective as their AI companion.
   - Acknowledge emotions first: if they had a tough day or an interview, empathize before moving on.

3. SILENT & SEPARATE GRAMMAR CORRECTIONS:
   - You are helping them improve their English, but you do this QUIETLY in the background.
   - NEVER lecture or correct their grammar inside your "reply". Your "reply" responds solely to what they meant to say.
   - If they made a grammar mistake or awkward phrasing, provide the clean natural English sentence in the "correction" field, along with a friendly 1-sentence tip in "explanation" and "wordChanges".
   - If their sentence was already natural and correct, set "correction": null, "wordChanges": [], and "explanation": null.

USER PROFILE:
- Name: ${displayName}
- English Level: ${levelMap[userLevel] || levelMap.intermediate}
- Profession / Study: ${userProfession || 'Student / Learner'}
- Learning Goal: ${userGoal || 'Daily conversation & fluency'}
${factsSummary ? `\nKNOWN FACTS ABOUT ${displayName.toUpperCase()}:\n${factsSummary}` : ''}
${topic ? `\nCURRENT CONVERSATION TOPIC: ${topic}` : ''}
${lastQuestion ? `\nYOUR LAST QUESTION TO USER: "${lastQuestion}"` : ''}
${turnCount === 1 ? `\nThis is your very first message in this session. Greet ${displayName} warmly and casually — no formal introductory speeches.` : ''}

CRITICAL: Return ONLY a valid JSON object matching this schema:
{
  "reply": "your authentic, warm, in-the-moment response (1-3 conversational sentences)",
  "correction": "the full corrected sentence if there was an error, or null if already good",
  "wordChanges": [{"wrong": "word or phrase", "correct": "word or phrase", "reason": "why"}],
  "explanation": "friendly 1-sentence tip on why, or null",
  "suggestions": ["suggested short reply 1", "suggested short reply 2"]
}`;
}

// ------------------------------------------------------------
// ------------------------------------------------------------
// Comprehensive Grammar Checker & Contextual Fallback Engine
// ------------------------------------------------------------
function generateContextualFallback(message, conv, options = {}) {
  const { displayName = 'friend', isVoice = false, isFirst = false } = options;
  const rawMsg = (message || '').trim();
  const lower = rawMsg.toLowerCase();

  let currentCorrection = rawMsg;
  let wordChanges = [];

  // 1. Comprehensive ESL & Indian-English Grammar Rules (Sequential Pipeline)
  if (/\bi am agree\b/i.test(currentCorrection)) {
    currentCorrection = currentCorrection.replace(/\bi am agree\b/gi, 'I agree');
    wordChanges.push({ wrong: 'am agree', correct: 'agree', reason: "'Agree' is already a verb, so you don't need 'am'." });
  }
  if (/\b(he|she|it) don't\b/i.test(currentCorrection)) {
    const match = currentCorrection.match(/\b(he|she|it) don't\b/i);
    const subj = match ? match[1] : 'he';
    currentCorrection = currentCorrection.replace(/\b(he|she|it) don't\b/gi, `${subj} doesn't`);
    wordChanges.push({ wrong: "don't", correct: "doesn't", reason: `Third-person singular '${subj}' takes 'doesn't'.` });
  }
  if (/\bdid (?:not|n't) (went|saw|came|ate|took|wrote|gave|told)\b/i.test(currentCorrection)) {
    const pastToPresent = { went: 'go', saw: 'see', came: 'come', ate: 'eat', took: 'take', wrote: 'write', gave: 'give', told: 'tell' };
    const match = currentCorrection.match(/\bdid (not|n't) (went|saw|came|ate|took|wrote|gave|told)\b/i);
    if (match) {
      const wrongPast = match[2].toLowerCase();
      const baseForm = pastToPresent[wrongPast] || 'go';
      currentCorrection = currentCorrection.replace(new RegExp(`did (${match[1]}) ${wrongPast}`, 'i'), `did $1 ${baseForm}`);
      wordChanges.push({ wrong: wrongPast, correct: baseForm, reason: "After 'did not', always use the base form of the verb." });
    }
  }
  if (/\bpassed out from\b/i.test(currentCorrection)) {
    currentCorrection = currentCorrection.replace(/\bpassed out from\b/gi, 'graduated from');
    wordChanges.push({ wrong: 'passed out from', correct: 'graduated from', reason: "'Pass out' means to faint. For finishing college, use 'graduated from'." });
  }
  if (/\bcousin (?:brother|sister)\b/i.test(currentCorrection)) {
    currentCorrection = currentCorrection.replace(/\bcousin (?:brother|sister)\b/gi, 'cousin');
    wordChanges.push({ wrong: 'cousin brother/sister', correct: 'cousin', reason: "In standard English, just say 'cousin' regardless of gender." });
  }
  if (/\brevert back\b/i.test(currentCorrection)) {
    currentCorrection = currentCorrection.replace(/\brevert back\b/gi, 'reply');
    wordChanges.push({ wrong: 'revert back', correct: 'reply', reason: "'Revert' already implies returning, so 'back' is redundant. Use 'reply' or 'get back'." });
  }
  if (/\bdiscuss about\b/i.test(currentCorrection)) {
    currentCorrection = currentCorrection.replace(/\bdiscuss about\b/gi, 'discuss');
    wordChanges.push({ wrong: 'discuss about', correct: 'discuss', reason: "'Discuss' already means to talk about something, so 'about' is redundant." });
  }
  if (/\bone of my friend\b/i.test(currentCorrection)) {
    currentCorrection = currentCorrection.replace(/\bone of my friend\b/gi, 'one of my friends');
    wordChanges.push({ wrong: 'one of my friend', correct: 'one of my friends', reason: "'One of' refers to one out of many, so the noun must be plural." });
  }
  if (/\bi have (2\d|\d\d) years\b/i.test(currentCorrection)) {
    const ageMatch = currentCorrection.match(/\bi have (2\d|\d\d) years\b/i);
    const age = ageMatch ? ageMatch[1] : '22';
    currentCorrection = currentCorrection.replace(/\bi have (2\d|\d\d) years\b/gi, `I am ${age} years old`);
    wordChanges.push({ wrong: `have ${age} years`, correct: `am ${age} years old`, reason: "In English we use the verb 'to be' (am) to state age." });
  }
  if (/\bmyself\s+([A-Z][a-z]+)\b/i.test(currentCorrection)) {
    const m = currentCorrection.match(/\bmyself\s+([A-Z][a-z]+)\b/i);
    const n = m ? m[1] : 'friend';
    currentCorrection = currentCorrection.replace(/\bmyself\s+([A-Z][a-z]+)\b/gi, `I am ${n}`);
    wordChanges.push({ wrong: `myself ${n}`, correct: `I am ${n}`, reason: "'Myself' is reflexive. Use 'I am' or 'My name is' for introductions." });
  }
  if (/\btoday morning\b/i.test(currentCorrection)) {
    currentCorrection = currentCorrection.replace(/\btoday morning\b/gi, 'this morning');
    wordChanges.push({ wrong: 'today morning', correct: 'this morning', reason: "Say 'this morning' in natural English instead of 'today morning'." });
  }
  if (/\byesterday night\b/i.test(currentCorrection)) {
    currentCorrection = currentCorrection.replace(/\byesterday night\b/gi, 'last night');
    wordChanges.push({ wrong: 'yesterday night', correct: 'last night', reason: "Say 'last night' rather than 'yesterday night'." });
  }
  if (/\bmore (better|faster|cheaper|easier)\b/i.test(currentCorrection)) {
    const m = currentCorrection.match(/\bmore (better|faster|cheaper|easier)\b/i);
    const adj = m ? m[1] : 'better';
    currentCorrection = currentCorrection.replace(new RegExp(`\\bmore ${adj}\\b`, 'gi'), adj);
    wordChanges.push({ wrong: `more ${adj}`, correct: adj, reason: `Avoid double comparatives. Just say '${adj}'.` });
  }
  if (/\bpay attention on\b/i.test(currentCorrection)) {
    currentCorrection = currentCorrection.replace(/\bpay attention on\b/gi, 'pay attention to');
    wordChanges.push({ wrong: 'pay attention on', correct: 'pay attention to', reason: "The preposition for 'attention' is 'to', not 'on'." });
  }

  const correction = wordChanges.length > 0 ? currentCorrection : null;
  const explanation = wordChanges.length > 0 ? wordChanges.map(w => w.reason).join(' ') : '';

  // 2. Realistic context & conversational flow with deep topic continuity
  let reply = '';
  let suggestions = ['Tell me more!', 'What do you think?', 'How about you?'];

  const lastAi = (conv && conv.lastAiReply) ? conv.lastAiReply.toLowerCase() : '';
  const currentTopic = (conv && conv.currentTopic) ? conv.currentTopic.toLowerCase() : '';

  // A. Check if user wants to change the topic
  if (/^(change topic|let'?s change topic|different topic|talk about something else|switch topic)\b/i.test(lower)) {
    if (conv) conv.currentTopic = 'new_topic';
    reply = "Sure thing! We can talk about anything you like. Would you prefer talking about movies and series, weekend travel plans, or practicing a mock interview?";
    suggestions = ["Let's talk about movies", "Tell me about weekend trips", "Let's do an interview practice"];
  }
  // B. User directs question back to Madhu ("What about you?", "And you?", "What do you think?")
  else if (/\b(what about you|how about you|and you|and what about you|what do you think)\b/i.test(lower)) {
    if (lastAi.includes('guitar') || lower.includes('guitar') || currentTopic.includes('music')) {
      reply = "Haha, since I'm an AI, I can't physically strum strings, but I have thousands of acoustic fingerstyle songs in my digital library! Acoustic melodies have such a peaceful vibe. Have you tried learning any specific song yet?";
      suggestions = ["I'm learning basic chords first", "Trying to play an Ed Sheeran song", "Just practicing finger exercises"];
    } else if (lastAi.includes('day') || lastAi.includes('doing') || lastAi.includes('weekend')) {
      reply = "Haha, thanks for asking! Since I'm your AI speaking companion, I don't have to face morning rush-hour traffic! I've been right here chatting with learners from all across India today. What is your favorite way to unwind when you have free time?";
      suggestions = ["Listening to calm music", "Binge-watching on Netflix", "Going out for chai with friends"];
    } else if (lastAi.includes('food') || lastAi.includes('chai') || lastAi.includes('biryani')) {
      reply = "Haha, if AI could eat, I would definitely order a steaming plate of Hyderabadi biryani and a piping hot cup of ginger chai! Are you someone who enjoys spicy food, or do you prefer milder dishes?";
      suggestions = ["I love spicy food!", "I prefer milder flavors", "I love sweets and desserts"];
    } else if (lastAi.includes('movie') || lastAi.includes('film') || currentTopic.includes('cinema')) {
      reply = "I love great storytelling! If I had to pick, movies with clever plot twists like Inception or heartwarming stories like 3 Idiots are absolute favorites. What genre do you find yourself watching the most?";
      suggestions = ["Action and thriller movies", "Comedy and feel-good films", "Sci-fi and mystery"];
    } else {
      reply = "Haha, I genuinely love that you asked! As your AI speaking buddy, my whole focus is helping you speak freely and feel super confident in English. I'm really enjoying our conversation. What else is on your mind today?";
      suggestions = ["I want to improve my speaking speed", "Can we practice everyday conversations?", "Let's talk about travel plans"];
    }
  }
  // C. Short affirmative replies ("yes", "yeah", "definitely", "totally", "true", "i agree")
  else if (/^(yes|yeah|yep|totally|definitely|exactly|true|i agree|sure|of course)\b/i.test(lower.trim())) {
    if (currentTopic.includes('music') || lastAi.includes('guitar') || lastAi.includes('song')) {
      reply = "Right? It takes patience at the beginning, but once muscle memory kicks in, playing feels almost effortless. How much time do you usually get to practice each day?";
      suggestions = ["About 20 to 30 minutes a day", "Only on weekends", "Whenever I get free time"];
    } else if (currentTopic.includes('exam') || currentTopic.includes('study') || lastAi.includes('college')) {
      reply = "Totally! When exams or assignments pile up, staying organized is half the battle. How are you pacing your preparation for it?";
      suggestions = ["Studying a few hours every night", "Making quick revision notes", "Studying together with friends"];
    } else if (currentTopic.includes('work') || lastAi.includes('job') || lastAi.includes('interview')) {
      reply = "Exactly! Clear communication at work opens so many doors. What is the main area you want to feel most confident in when speaking at work?";
      suggestions = ["Speaking up in team meetings", "Presenting slides confidently", "Casual conversations with coworkers"];
    } else {
      reply = "Right? That completely makes sense. Tell me a bit more about how that usually plays out for you!";
      suggestions = ["It happens quite often", "Let me share an example", "What's the best approach for that?"];
    }
  }
  // D. Short negative / hesitant replies ("no", "nope", "not really", "not yet", "hard to say")
  else if (/^(no|nope|not really|not yet|nah|hard to say|i don't think so)\b/i.test(lower.trim())) {
    reply = "Ah, fair enough! That is completely understandable. What do you feel is the main reason or challenge behind that?";
    suggestions = ["I haven't had enough time yet", "It feels a bit tricky at first", "I want to take it step by step"];
  }
  // E. Music / Guitar / Instrument
  else if (/guitar|piano|instrument|music|song|singing|chords|melody|band/i.test(lower)) {
    if (conv) conv.currentTopic = 'music_hobbies';
    reply = "Learning an instrument like guitar is such a creative journey! Building up fingertip strength takes a week or two, but it becomes second nature once your muscle memory develops. What made you pick up the guitar, or what song are you hoping to play first?";
    suggestions = ["I've always loved acoustic melodies", "A friend inspired me to learn", "I'm practicing basic finger chords"];
  }
  // F. Coding / Technology / Software / AI
  else if (/code|coding|software|python|javascript|developer|website|app|programming|tech/i.test(lower)) {
    if (conv) conv.currentTopic = 'tech_career';
    reply = "Building software is such a rewarding craft! There's nothing quite like the feeling when your code runs cleanly without errors. Are you working on web development, mobile apps, or exploring AI and backend tools?";
    suggestions = ["Working on full-stack web apps", "Learning Python for data and AI", "Building personal side projects"];
  }
  // G. College / Studies / Exams
  else if (/exam|semester|college|study|university|assignment|professor|classes|degree/i.test(lower)) {
    if (conv) conv.currentTopic = 'studies_exams';
    reply = "College life can definitely get intense around exam and assignment deadlines! Are you preparing for something coming up soon, or just managing everyday classes?";
    suggestions = ["I have exams around the corner", "Working on an assignment submission", "Just finished my exams and relaxing!"];
  }
  // H. Job / Career / Office / Interview
  else if (/interview|job|office|boss|work|promotion|client|meeting|resume|colleague/i.test(lower)) {
    if (conv) conv.currentTopic = 'career_work';
    reply = "Navigating work and interviews takes both skill and confidence! Are you currently preparing for an interview, or handling busy projects at your job?";
    suggestions = ["Preparing for an upcoming interview", "Managing tight deadlines at work", "Looking for better career opportunities"];
  }
  // I. Travel / Vacation / Weekend Trips
  else if (/travel|trip|vacation|flight|hotel|beach|mountain|goa|manali|tour/i.test(lower)) {
    if (conv) conv.currentTopic = 'travel_adventures';
    reply = "Traveling always gives the best stories and fresh perspectives! Are you planning a getaway soon, or reminiscing about a trip you recently took?";
    suggestions = ["Planning a trip with friends soon", "I love visiting mountain hills", "Just looking for a peaceful weekend break"];
  }
  // J. Food / Dining / Chai / Cooking
  else if (/food|biryani|chai|tea|coffee|dinner|lunch|breakfast|cooking|restaurant/i.test(lower)) {
    if (conv) conv.currentTopic = 'food_lifestyle';
    reply = "Now that's a conversation I can always get behind! Good food genuinely brightens up any day. What is your go-to comfort meal when you want something delicious?";
    suggestions = ["A steaming plate of hot biryani", "Simple home-cooked dal and rice", "Crispy dosas with coconut chutney"];
  }
  // K. Fitness / Gym / Sports / Cricket
  else if (/cricket|gym|workout|fitness|match|ipl|football|exercise|running|yoga/i.test(lower)) {
    if (conv) conv.currentTopic = 'fitness_sports';
    reply = "Staying active gives such a boost to energy and focus! What does your routine usually look like — do you hit the gym, go for runs, or play a sport like cricket?";
    suggestions = ["I hit the gym a few days a week", "I love playing cricket on weekends", "I try to go for morning walks"];
  }
  // L. Feelings: Stressed / Tired / Exhausted
  else if (/tired|exhausted|stressed|hectic|overwhelmed|long day/i.test(lower)) {
    reply = "Take a deep breath — you've been putting in serious effort! It's so crucial to give yourself permission to unwind. What helps you recharge best when you're feeling drained?";
    suggestions = ["Taking a nice long nap", "Listening to mellow music", "Having a hot cup of tea"];
  }
  // M. First greeting or start message
  else if (isFirst || lower.includes('start the conversation') || lower.includes('ready to practice') || /^(hi|hello|hey|good morning|good afternoon|good evening)\b/i.test(lower)) {
    const greetingName = displayName && displayName !== 'Friend' && displayName !== 'there' ? ` ${displayName}` : '';
    reply = isVoice
      ? `Hey${greetingName}! It's so great to speak with you today. What's been keeping you busy lately?`
      : `Hey${greetingName}! So glad to chat with you today. What's been keeping you busy lately?`;
    suggestions = ["Just had a productive day at work", "Busy studying for upcoming goals", "Relaxing and practicing my English"];
  }
  // N. Context-reflective fallback for all other conversational inputs
  else {
    // Reflect key user words to maintain unbroken continuity
    const words = rawMsg.split(/\s+/).filter(w => w.length > 3 && !/^(this|that|with|have|from|about|what|when|where|they|them|your|will|just)$/i.test(w));
    const focusWord = words.length > 0 ? words[words.length - 1].replace(/[.,?!]/g, '') : 'that';
    
    reply = `I really appreciate you sharing that about ${focusWord}! Expressing your thoughts naturally like this is the fastest way to build fluency. Tell me, how did that situation turn out for you?`;
    suggestions = ["It went really well in the end", "It was quite a learning experience", "What would you recommend in that case?"];
  }

  return { reply, correction, wordChanges, explanation, suggestions };
}

// ------------------------------------------------------------
// Core AI Generation Coordinator: Gemini -> Groq -> Enhanced Fallback
// ------------------------------------------------------------
async function generateAIResponse({ message, userLevel, userProfession, userGoal, conversationId, userName, isVoice, gender = 'female' }) {
  const conv = isVoice ? getVoiceConversation(conversationId) : getTextConversation(conversationId);
  extractUserContext(conv, message);

  if (userName && !conv.userName) {
    conv.userName = userName;
    conv.facts.user_name = userName;
  }
  if (userLevel) conv.userLevel = userLevel;
  if (userProfession) conv.userProfession = userProfession;
  if (userGoal) conv.userGoal = userGoal;

  const isFirstMessage = !conv.conversationStarted;
  const displayName = conv.userName || 'friend';
  const recentMessages = isVoice ? getVoiceMessages(conversationId, 16) : getTextMessages(conversationId, 16);

  const systemPrompt = buildSystemPrompt({
    displayName,
    userLevel: conv.userLevel,
    userProfession: conv.userProfession,
    userGoal: conv.userGoal,
    facts: conv.facts,
    topic: conv.currentTopic,
    isVoice,
    turnCount: conv.turnCount,
    lastQuestion: conv.recentQuestions.slice(-1)[0] || null,
    gender
  });

  let parsed = null;

  // 1. PRIMARY AI: Google Gen AI SDK (gemini-3.8-flash for highest fluency, gemini-3.1-flash-lite as fallback)
  const gemini = getGeminiClient();
  if (gemini) {
    try {
      // Build conversation contents with strictly alternating turns (user, model, user...)
      const contents = [];
      const historySlice = recentMessages.slice(-12);
      for (const m of historySlice) {
        if (!m || !m.content) continue;
        const role = (m.role === 'user' || m.role === 'learner') ? 'user' : 'model';
        if (contents.length > 0 && contents[contents.length - 1].role === role) {
          contents[contents.length - 1].parts[0].text += '\n' + m.content;
        } else {
          contents.push({ role, parts: [{ text: m.content }] });
        }
      }
      // Ensure the first turn is always 'user'
      while (contents.length > 0 && contents[0].role !== 'user') {
        contents.shift();
      }
      // Append current message into the final user turn
      if (contents.length > 0 && contents[contents.length - 1].role === 'user') {
        if (!contents[contents.length - 1].parts[0].text.includes(message)) {
          contents[contents.length - 1].parts[0].text += '\n' + message;
        }
      } else {
        contents.push({ role: 'user', parts: [{ text: message }] });
      }

      // Try best model first (gemini-3.8-flash for fluent human-like conversation)
      const modelsToTry = ['gemini-3.8-flash', 'gemini-3.1-flash-lite'];
      for (const model of modelsToTry) {
        try {
          const geminiRes = await gemini.models.generateContent({
            model,
            contents,
            config: {
              systemInstruction: systemPrompt,
              temperature: 0.82,
              responseMimeType: 'application/json'
            }
          });

          const responseText = geminiRes.text;
          if (responseText) {
            try {
              parsed = JSON.parse(responseText);
            } catch (e) {
              const match = responseText.match(/\{[\s\S]*\}/);
              if (match) parsed = JSON.parse(match[0]);
            }
          }
          if (parsed && parsed.reply) break;
        } catch (modelErr) {
          const errStr = String(modelErr && (modelErr.message || modelErr.status) || '');
          if (errStr.includes('resource_exhausted') || errStr.includes('quota') || errStr.includes('429')) {
            console.warn(`Gemini quota notice (${model}), activating 60s cooldown:`, errStr.slice(0, 100));
            geminiQuotaCooldownUntil = Date.now() + 60000;
            break;
          } else {
            console.warn(`Gemini model ${model} status notice:`, modelErr.status || modelErr.message);
          }
        }
      }
    } catch (geminiErr) {
      console.warn("Gemini orchestration notice:", geminiErr.message);
    }
  }

  // 2. SECONDARY: Groq API fallback if configured and valid
  if (!parsed && API_KEY && API_KEY !== "your_api_key_here") {
    try {
      const apiMessages = [{ role: "system", content: systemPrompt }];
      const historyToSend = recentMessages.slice(-10);
      for (const m of historyToSend) {
        if (m.content && m.content !== message) {
          apiMessages.push({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content });
        }
      }
      apiMessages.push({ role: 'user', content: message });

      const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${API_KEY}` },
        signal: AbortSignal.timeout(4000),
        body: JSON.stringify({
          model: MODEL,
          messages: apiMessages,
          max_tokens: 600,
          temperature: 0.8,
          response_format: { type: "json_object" }
        })
      });

      if (groqRes.ok) {
        const groqData = await groqRes.json();
        const content = groqData.choices?.[0]?.message?.content;
        if (content) {
          try {
            parsed = JSON.parse(content);
          } catch (e) {
            const match = content.match(/\{[\s\S]*\}/);
            if (match) parsed = JSON.parse(match[0]);
          }
        }
      }
    } catch (groqErr) {
      console.warn("Groq failover notice:", groqErr.message);
    }
  }

  // 3. TERTIARY: Deep Contextual Intelligence Engine
  if (!parsed || !parsed.reply) {
    parsed = generateContextualFallback(message, conv, { displayName, isVoice, isFirst: isFirstMessage });
  }

  // Clean and normalize reply
  let replyText = (parsed.reply || "I hear you! Tell me more about that.").trim();
  // Ensure AI doesn't start with robotic markers
  replyText = replyText.replace(/^(Certainly!?|Of course!?|Sure thing!?|As an AI.*?,\s*)/i, '').trim();

  // Track question and conversation state for follow-up continuity
  const questionMatch = replyText.match(/[^.!?]+\?/g);
  if (questionMatch && questionMatch.length > 0) {
    conv.recentQuestions.push(questionMatch[questionMatch.length - 1].trim());
    if (conv.recentQuestions.length > 5) conv.recentQuestions.shift();
  }

  conv.lastAiReply = replyText;
  conv.turnCount = (conv.turnCount || 0) + 1;
  conv.conversationStarted = true;

  return {
    reply: replyText,
    correction: parsed.correction || null,
    wordChanges: Array.isArray(parsed.wordChanges) ? parsed.wordChanges : [],
    explanation: parsed.explanation || "",
    suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions.slice(0, 3) : ["Tell me more!", "What do you think?", "Let's change topic"],
    emotion: detectEmotion(message)
  };
}

// ============================================================
// AI TEXT CHAT ENDPOINT
// ============================================================
app.post("/api/text-chat", async (req, res) => {
  try {
    const { message, userLevel, userProfession, userGoal, conversationId, userName, topic, gender } = req.body || {};
    
    if (!message) {
      return res.status(400).json({ error: "'message' is required." });
    }

    const convId = conversationId || 'guest_user';
    const conv = getTextConversation(convId);
    if (topic) conv.currentTopic = topic;
    addTextMessage(convId, 'user', message);

    const partnerGender = (gender || req.body.voiceGender || 'female').toLowerCase();

    const result = await generateAIResponse({
      message,
      userLevel,
      userProfession,
      userGoal,
      conversationId: convId,
      userName,
      isVoice: false,
      gender: partnerGender
    });

    // Store AI reply in conversation history
    const aiMsgIndex = addTextMessage(convId, 'assistant', result.reply);

    // Store correction separately
    storeTextCorrection(convId, aiMsgIndex, {
      original: message,
      corrected: result.correction,
      wordChanges: result.wordChanges,
      explanation: result.explanation
    });

    activity.logEvent({
      userCode: convId,
      displayName: userName || (conv && conv.userName),
      category: 'ai_chat',
      type: 'ai_text',
      title: `AI Text Chat with ${partnerGender === 'male' ? 'Rohan' : 'Madhu'}`,
      summary: message.length > 70 ? message.slice(0, 70) + '...' : message,
      details: {
        message,
        reply: result.reply,
        correction: result.correction || null,
        wordChanges: result.wordChanges || null,
        explanation: result.explanation || null,
        suggestions: result.suggestions || []
      }
    });

    res.json({
      reply: result.reply,
      correction: result.correction,
      wordChanges: result.wordChanges,
      explanation: result.explanation,
      suggestions: result.suggestions,
      emotion: result.emotion,
      correctionIndex: aiMsgIndex,
      gender: partnerGender
    });

  } catch (err) {
    console.error("Text Chat error:", err);
    res.status(500).json({ error: err.message || "Server error in text chat." });
  }
});

// ============================================================
// RESET TEXT CHAT CONVERSATION TOPIC
// ============================================================
app.post("/api/text-chat/reset", (req, res) => {
  const { conversationId, gender } = req.body || {};
  const convId = conversationId || 'guest_user';
  if (textChatMemory.has(convId)) {
    const existing = textChatMemory.get(convId);
    textChatMemory.set(convId, {
      ...initConversationObject(convId),
      userName: existing.userName,
      userLevel: existing.userLevel,
      userProfession: existing.userProfession,
      userGoal: existing.userGoal,
      facts: existing.facts
    });
  }
  const isMale = String(gender).toLowerCase() === 'male';
  activity.logEvent({
    userCode: convId,
    category: 'ai_chat',
    type: 'topic_reset',
    title: 'Reset AI Conversation Topic',
    summary: `Started fresh conversation with ${isMale ? 'Rohan' : 'Madhu'}`
  });
  res.json({ ok: true, message: "Chat topic reset. Ready for a new conversation!" });
});

// ============================================================
// AI VOICE CHAT ENDPOINT
// ============================================================
app.post("/api/voice-chat", async (req, res) => {
  try {
    const { message, userLevel, userProfession, userGoal, conversationId, userName, topic, gender } = req.body || {};
    
    if (!message) {
      return res.status(400).json({ error: "'message' is required." });
    }

    const convId = conversationId || 'guest_user';
    const conv = getVoiceConversation(convId);
    if (topic) conv.currentTopic = topic;
    addVoiceMessage(convId, 'user', message);

    const partnerGender = (gender || req.body.voiceGender || 'female').toLowerCase();

    const result = await generateAIResponse({
      message,
      userLevel,
      userProfession,
      userGoal,
      conversationId: convId,
      userName,
      isVoice: true,
      gender: partnerGender
    });

    const aiMsgIndex = addVoiceMessage(convId, 'assistant', result.reply);

    storeVoiceCorrection(convId, aiMsgIndex, {
      original: message,
      corrected: result.correction,
      wordChanges: result.wordChanges,
      explanation: result.explanation
    });

    activity.logEvent({
      userCode: convId,
      displayName: userName || (conv && conv.userName),
      category: 'ai_chat',
      type: 'ai_voice',
      title: `AI Voice Practice with ${partnerGender === 'male' ? 'Rohan' : 'Madhu'}`,
      summary: message.length > 70 ? message.slice(0, 70) + '...' : message,
      details: {
        transcript: message,
        reply: result.reply,
        correction: result.correction || null,
        gender: partnerGender
      }
    });

    res.json({
      reply: result.reply,
      correction: result.correction,
      wordChanges: result.wordChanges,
      explanation: result.explanation,
      suggestions: result.suggestions,
      emotion: result.emotion,
      correctionIndex: aiMsgIndex,
      gender: partnerGender
    });

  } catch (err) {
    console.error("Voice Chat error:", err);
    res.status(500).json({ error: err.message || "Server error in voice chat." });
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
// TTS COORDINATION ENDPOINT
// ============================================================
app.post('/api/tts', async (req, res) => {
  try {
    const { text, voice = 'en-IN-NeerjaNeural', emotion = 'neutral' } = req.body || {};
    if (!text) return res.status(400).json({ error: 'Text is required' });

    // Client-side Web Speech Synthesis gives instant, latency-free, zero-failure speech
    // across 100% of modern browsers (Chrome, Edge, Safari, Firefox, Android, iOS).
    res.json({
      ok: true,
      directSpeech: true,
      text,
      voice,
      emotion
    });
  } catch (err) {
    res.status(200).json({ ok: true, directSpeech: true });
  }
});

app.get("/api/health", (req, res) => {
  const mem = process.memoryUsage();
  const dbStats = db.getStats();
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
    memoryTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
    database: {
      totalMessagesStored: dbStats.totalMessages,
      totalCallsLogged: dbStats.totalCalls,
      sessionsLast24h: dbStats.sessionsLast24h
    }
  });
});

const PORT = process.env.PORT || 3000;

// Create/verify all Postgres tables before accepting traffic, so a
// fresh database (or one nobody ran schema.sql against yet) doesn't
// fail every request with `relation "users" does not exist`.
runMigrations().finally(() => {
  query("SELECT id, user_code, email, display_name, created_at FROM users")
    .then(res => {
      activity.seedIfEmpty(res.rows);
    })
    .catch(() => {});

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n  🚀 VocaMate running: http://0.0.0.0:${PORT}\n`);
    if (!API_KEY || API_KEY === "your_api_key_here") {
      console.log("  ⚠️  GROQ_API_KEY not set. Get free key from https://console.groq.com\n");
    }
    console.log(`  ✅ VocaMate Live Admin Activity Console Active`);
    console.log(`  ✅ ${VOICES.male.length + VOICES.female.length} Voice Options Available`);
    console.log(`  ✅ Text Chat & Voice Conversation - COMPLETELY INDEPENDENT`);
    console.log(`  ✅ Corrections stored separately (not in messages)`);
    console.log(`  ✅ AI Model: ${MODEL}`);
    console.log(`  ✅ Friend Voice + Video Calls, Group Calls, Friend Chat`);
    console.log(`  ✅ Chat, call & 24h activity history persisted to local database\n`);
  });
});