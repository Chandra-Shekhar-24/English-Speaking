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
// STORES - SEPARATE FOR TEXT AND VOICE
// ============================================================
const textChatMemory = new Map();
const voiceChatMemory = new Map();
const users = new Map();
const userIdPool = new Set();
const activeCalls = new Map();
const pendingCallRequests = new Map();

function getTextConversation(userId) {
  if (!textChatMemory.has(userId)) {
    textChatMemory.set(userId, {
      messages: [],
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
      context: {},
      topic: null,
      facts: {},
      conversationStarted: false,
      userName: null
    });
  }
  return voiceChatMemory.get(userId);
}

function addTextMessage(userId, role, content) {
  const conv = getTextConversation(userId);
  conv.messages.push({ role, content });
  if (conv.messages.length > 50) conv.messages = conv.messages.slice(-50);
}

function addVoiceMessage(userId, role, content) {
  const conv = getVoiceConversation(userId);
  conv.messages.push({ role, content });
  if (conv.messages.length > 50) conv.messages = conv.messages.slice(-50);
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
// SSML GENERATOR - FAST SPEED
// ============================================================
function generateSSML(text, emotion = 'neutral', voiceId = 'en-IN-NeerjaNeural') {
  const emotionSettings = {
    'neutral': { rate: '+15%', pitch: '0%', style: 'general' },
    'happy': { rate: '+20%', pitch: '+10%', style: 'cheerful' },
    'sad': { rate: '+10%', pitch: '-5%', style: 'sad' },
    'encouraging': { rate: '+18%', pitch: '+8%', style: 'encouraging' },
    'empathetic': { rate: '+10%', pitch: '-3%', style: 'empathetic' },
    'excited': { rate: '+25%', pitch: '+15%', style: 'excited' },
    'calm': { rate: '+12%', pitch: '-5%', style: 'calm' },
    'thoughtful': { rate: '+10%', pitch: '-5%', style: 'thoughtful' },
    'friendly': { rate: '+18%', pitch: '+5%', style: 'friendly' }
  };

  const settings = emotionSettings[emotion] || emotionSettings['neutral'];
  let ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-IN"><voice name="${voiceId}"><prosody rate="${settings.rate}" pitch="${settings.pitch}">`;
  if (settings.style && settings.style !== 'general') {
    ssml += `<mstts:express-as style="${settings.style}" styledegree="1.0">`;
  }

  const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
  sentences.forEach((sentence, index) => {
    const trimmed = sentence.trim();
    if (!trimmed) return;
    if (index > 0) ssml += `<break time="100ms"/>`;
    if (trimmed.endsWith('?')) ssml += `<prosody pitch="+5%">${trimmed}</prosody>`;
    else if (trimmed.endsWith('!')) { ssml += trimmed; ssml += `<break time="150ms"/>`; }
    else { ssml += trimmed; ssml += `<break time="200ms"/>`; }
  });

  if (settings.style && settings.style !== 'general') ssml += `</mstts:express-as>`;
  ssml += `</prosody></voice></speak>`;
  return ssml;
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

  socket.on("call-request", (targetUserId) => {
    const caller = users.get(userId);
    const target = users.get(targetUserId);
    if (!caller || !target || !target.connected) { socket.emit("call-error", "User not available"); return; }
    if (target.busy) { socket.emit("call-error", "User is in a call"); return; }
    if (caller.busy) { socket.emit("call-error", "You are already in a call"); return; }
    caller.busy = true;
    const callId = `call_${Date.now()}_${userId}_${targetUserId}`;
    caller.currentCallId = callId;
    pendingCallRequests.set(callId, {
      caller: userId, target: targetUserId, status: 'pending', timestamp: Date.now(),
      timeout: setTimeout(() => {
        const pending = pendingCallRequests.get(callId);
        if (pending && pending.status === 'pending') {
          pending.status = 'timedout';
          const callerUser = users.get(pending.caller);
          if (callerUser) { callerUser.busy = false; callerUser.currentCallId = null; }
          const callerSocket = users.get(pending.caller);
          if (callerSocket && callerSocket.connected) {
            io.to(callerSocket.socketId).emit("call-timeout");
          }
          pendingCallRequests.delete(callId);
          broadcastOnlineUsers();
        }
      }, 30000)
    });
    const callerName = caller.userName || `User ${userId}`;
    io.to(target.socketId).emit("incoming-call", {
      callId,
      from: userId,
      fromPeerId: caller.peerId,
      fromName: callerName
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
        userName: responderName
      });
      const callerName = caller.userName || `User ${pendingCall.caller}`;
      io.to(responder.socketId).emit("call-connected", {
        callId,
        peerId: caller.peerId,
        userId: pendingCall.caller,
        userName: callerName
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
      pendingCallRequests.delete(callId);
      broadcastOnlineUsers();
    }
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
    if (user1) { user1.busy = true; user1.currentCallId = `random_${Date.now()}`; }
    if (user2) { user2.busy = true; user2.currentCallId = `random_${Date.now()}`; }
    const callId = `call_${Date.now()}_${userId}_${match.userId}`;
    activeCalls.set(callId, { userA: userId, userB: match.userId, status: 'connected', startedAt: Date.now() });
    socket.emit("random-match", {
      peerId: match.peerId,
      userId: match.userId,
      userName: match.userName
    });
    io.to(match.socketId).emit("random-match", {
      peerId: user1.peerId,
      userId: userId,
      userName: user1.userName || userId
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

// ============================================================
// AI TEXT CHAT ENDPOINT
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
    addTextMessage(conversationId, 'user', message);

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

    const systemPrompt = `You are an intelligent, empathetic English conversation partner named Madhu. You are helping an Indian user named "${displayName}" improve their English through TEXT CHAT.

USER PROFILE:
- Name: ${displayName}
- Level: ${levelMap[userLevel] || 'INTERMEDIATE'}
- Profession: ${userProfession || 'Not specified'}
- Goal: ${userGoal || 'General conversation'}

TEXT CHAT CONVERSATION CONTEXT:
${contextSummary}

RECENT TEXT CHAT:
${historyText || 'This is a new text chat conversation.'}

${isFirstMessage ? `This is the FIRST message in text chat. Start the conversation naturally by greeting ${displayName} by name and asking a friendly question.` : ''}

CRITICAL RULES:
1. This is TEXT CHAT - separate from voice conversation.
2. Always address the user by their name "${displayName}" naturally.
3. If the user asks a question, ANSWER IT DIRECTLY first.
4. PROVIDE THE FULL CORRECTED SENTENCE, not just word changes.
5. Respond naturally like a human with appropriate emotion.
6. Always ask a follow-up question to continue the conversation.

RESPONSE FORMAT (JSON only):
{
  "reply": "Your natural text response (2-3 sentences, use the user's name, include a question)",
  "correction": "FULL corrected version of the user's entire sentence (preserve meaning) or null if perfect",
  "naturalVersion": "More natural way to say the same thing, or null",
  "wordChanges": [{"wrong": "word", "correct": "word", "reason": "why"}],
  "explanation": "Brief explanation of the main mistake"
}`;

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
      '{"reply":"I understand. Could you tell me more about that?","correction":null,"naturalVersion":null,"wordChanges":[],"explanation":""}';

    let parsed;
    try { parsed = JSON.parse(aiContent); } catch (e) {
      parsed = { reply: "I appreciate you sharing that. Could you tell me more?", correction: null, naturalVersion: null, wordChanges: [], explanation: "" };
    }

    addTextMessage(conversationId, 'assistant', parsed.reply);
    textConv.conversationStarted = true;
    if (message.toLowerCase().includes('my name is') || message.toLowerCase().includes('call me')) {
      const nameMatch = message.match(/(?:my name is|call me|i am)\s+(\w+)/i);
      if (nameMatch) { textConv.facts.user_name = nameMatch[1]; textConv.userName = nameMatch[1]; }
    }
    if (message.length > 10) textConv.topic = message.substring(0, 50);

    res.json({
      reply: parsed.reply || "I understand what you mean.",
      correction: parsed.correction || null,
      naturalVersion: parsed.naturalVersion || null,
      wordChanges: parsed.wordChanges || [],
      explanation: parsed.explanation || "",
      emotion: detectEmotion(message)
    });

  } catch (err) {
    console.error("Text Chat error:", err);
    res.status(500).json({ error: err.message || "Server error." });
  }
});

// ============================================================
// AI VOICE CHAT ENDPOINT
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

    const systemPrompt = `You are an intelligent, empathetic English conversation partner named Madhu. You are helping an Indian user named "${displayName}" improve their English through VOICE CONVERSATION.

USER PROFILE:
- Name: ${displayName}
- Level: ${levelMap[userLevel] || 'INTERMEDIATE'}
- Profession: ${userProfession || 'Not specified'}
- Goal: ${userGoal || 'General conversation'}

VOICE CONVERSATION CONTEXT:
${contextSummary}

RECENT VOICE CONVERSATION:
${historyText || 'This is a new voice conversation.'}

${isFirstMessage ? `This is the FIRST message in voice conversation. Start the conversation naturally by greeting ${displayName} by name and asking a friendly question.` : ''}

CRITICAL RULES:
1. This is VOICE CONVERSATION - separate from text chat.
2. Always address the user by their name "${displayName}" naturally.
3. If the user asks a question, ANSWER IT DIRECTLY first.
4. PROVIDE THE FULL CORRECTED SENTENCE, not just word changes.
5. Respond naturally like a human with appropriate emotion.
6. Always ask a follow-up question to continue the conversation.

RESPONSE FORMAT (JSON only):
{
  "reply": "Your natural spoken response (2-3 sentences, use the user's name, include a question)",
  "correction": "FULL corrected version of the user's entire sentence (preserve meaning) or null if perfect",
  "naturalVersion": "More natural way to say the same thing, or null",
  "wordChanges": [{"wrong": "word", "correct": "word", "reason": "why"}],
  "explanation": "Brief explanation of the main mistake"
}`;

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
      '{"reply":"I understand. Could you tell me more about that?","correction":null,"naturalVersion":null,"wordChanges":[],"explanation":""}';

    let parsed;
    try { parsed = JSON.parse(aiContent); } catch (e) {
      parsed = { reply: "I appreciate you sharing that. Could you tell me more?", correction: null, naturalVersion: null, wordChanges: [], explanation: "" };
    }

    addVoiceMessage(conversationId, 'assistant', parsed.reply);
    voiceConv.conversationStarted = true;
    if (message.toLowerCase().includes('my name is') || message.toLowerCase().includes('call me')) {
      const nameMatch = message.match(/(?:my name is|call me|i am)\s+(\w+)/i);
      if (nameMatch) { voiceConv.facts.user_name = nameMatch[1]; voiceConv.userName = nameMatch[1]; }
    }
    if (message.length > 10) voiceConv.topic = message.substring(0, 50);

    res.json({
      reply: parsed.reply || "I understand what you mean.",
      correction: parsed.correction || null,
      naturalVersion: parsed.naturalVersion || null,
      wordChanges: parsed.wordChanges || [],
      explanation: parsed.explanation || "",
      emotion: detectEmotion(message)
    });

  } catch (err) {
    console.error("Voice Chat error:", err);
    res.status(500).json({ error: err.message || "Server error." });
  }
});

// ============================================================
// TTS ENDPOINT - FAST RESPONSE
// ============================================================
app.post('/api/tts', async (req, res) => {
  try {
    const { text, voice = 'en-IN-NeerjaNeural', emotion = 'neutral' } = req.body;
    if (!text) return res.status(400).json({ error: 'Text is required' });

    const ssml = generateSSML(text, emotion, voice);

    const response = await fetch('https://edge-tts-api.vercel.app/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: ssml,
        voice,
        rate: '+15%',
        pitch: 0
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
        body: JSON.stringify({ text, voice, rate: '+15%', pitch: 0 })
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
  res.json({
    ok: true,
    apiKeyConfigured: Boolean(API_KEY && API_KEY !== "your_api_key_here"),
    model: MODEL,
    onlineUsers: users.size,
    activeCalls: activeCalls.size,
    totalVoiceOptions: VOICES.male.length + VOICES.female.length,
    uptime: process.uptime()
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
  console.log(`  ✅ FAST TTS Response (+15% speed, reduced pauses)`);
  console.log(`  ✅ Friend Call with Multi-Call Audio Fix`);
  console.log(`  ✅ Features: AI Text Chat, AI Voice, Friend Call\n`);
});