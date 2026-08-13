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

const API_KEY = process.env.GROQ_API_KEY;
const MODEL = "llama-3.1-8b-instant";

// ============================================================
// STORES
// ============================================================
const conversationMemory = new Map();
const users = new Map();
const userIdPool = new Set();
const activeCalls = new Map();
const pendingCallRequests = new Map();

// ============================================================
// CONVERSATION MEMORY
// ============================================================
function getConversation(userId) {
  if (!conversationMemory.has(userId)) {
    conversationMemory.set(userId, {
      messages: [],
      context: {},
      topic: null,
      facts: {},
      lastQuestion: null,
      emotionContext: 'neutral'
    });
  }
  return conversationMemory.get(userId);
}

function addMessage(userId, role, content) {
  const conv = getConversation(userId);
  conv.messages.push({ role, content });
  if (conv.messages.length > 30) conv.messages = conv.messages.slice(-30);
}

function getRecentMessages(userId, count = 15) {
  const conv = getConversation(userId);
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
// VOICE CONFIGURATION - 20 Indian Voices with SSML Support
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
// SSML HELPER - NATURAL HUMAN-LIKE VOICE
// ============================================================
function generateSSML(text, emotion = 'neutral', voiceId = 'en-IN-NeerjaNeural') {
  // Detect if it's a question
  const isQuestion = text.trim().endsWith('?');
  
  // Emotion-based prosody settings
  const emotionSettings = {
    'neutral': { rate: '0%', pitch: '0%', volume: 'medium', style: 'general' },
    'happy': { rate: '+5%', pitch: '+10%', volume: 'medium', style: 'cheerful' },
    'sad': { rate: '-8%', pitch: '-5%', volume: 'soft', style: 'sad' },
    'encouraging': { rate: '+5%', pitch: '+8%', volume: 'medium', style: 'encouraging' },
    'empathetic': { rate: '-5%', pitch: '-3%', volume: 'soft', style: 'empathetic' },
    'excited': { rate: '+12%', pitch: '+15%', volume: 'loud', style: 'excited' },
    'calm': { rate: '-8%', pitch: '-5%', volume: 'soft', style: 'calm' },
    'thoughtful': { rate: '-10%', pitch: '-5%', volume: 'medium', style: 'thoughtful' },
    'friendly': { rate: '+3%', pitch: '+5%', volume: 'medium', style: 'friendly' },
    'professional': { rate: '0%', pitch: '0%', volume: 'medium', style: 'professional' }
  };

  const settings = emotionSettings[emotion] || emotionSettings['neutral'];
  
  // Build SSML with natural pauses and emphasis
  let ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-IN">`;
  
  // Voice with style
  ssml += `<voice name="${voiceId}">`;
  ssml += `<prosody rate="${settings.rate}" pitch="${settings.pitch}" volume="${settings.volume}">`;
  
  // Add style if available
  if (settings.style && settings.style !== 'general') {
    ssml += `<mstts:express-as style="${settings.style}" styledegree="1.0">`;
  }

  // Split text into sentences for natural pauses
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
  
  sentences.forEach((sentence, index) => {
    const trimmed = sentence.trim();
    if (!trimmed) return;
    
    // Add natural pause between sentences
    if (index > 0) {
      ssml += `<break time="250ms"/>`;
    }
    
    // Add emphasis on important words (keywords)
    const words = trimmed.split(' ');
    let processed = '';
    words.forEach((word, i) => {
      // Emphasize important words (longer words, or words in all caps)
      const cleanWord = word.replace(/[.,!?;:]/g, '');
      if (cleanWord.length > 6 || word === word.toUpperCase()) {
        processed += `<emphasis level="moderate">${word}</emphasis> `;
      } else if (i === 0 || i === words.length - 1) {
        // Emphasize first and last word slightly
        processed += `<emphasis level="reduced">${word}</emphasis> `;
      } else {
        processed += word + ' ';
      }
    });
    
    // Add question intonation
    if (trimmed.endsWith('?')) {
      ssml += `<prosody pitch="+5%">${processed.trim()}</prosody>`;
    } else {
      ssml += processed.trim();
    }
    
    // Add sentence-ending pause
    if (trimmed.endsWith('!')) {
      ssml += `<break time="300ms"/>`;
    } else if (trimmed.endsWith('?')) {
      ssml += `<break time="200ms"/>`;
    } else if (trimmed.endsWith('.')) {
      ssml += `<break time="400ms"/>`;
    } else {
      ssml += `<break time="150ms"/>`;
    }
  });
  
  // Close tags
  if (settings.style && settings.style !== 'general') {
    ssml += `</mstts:express-as>`;
  }
  ssml += `</prosody>`;
  ssml += `</voice>`;
  ssml += `</speak>`;
  
  return ssml;
}

// ============================================================
// DETECT EMOTION FROM CONVERSATION CONTEXT
// ============================================================
function detectEmotion(userMessage, recentHistory) {
  const lower = userMessage.toLowerCase();
  
  // Happy/positive indicators
  if (lower.includes('happy') || lower.includes('great') || lower.includes('awesome') || 
      lower.includes('wonderful') || lower.includes('excellent') || lower.includes('love') ||
      lower.includes('enjoy') || lower.includes('amazing') || lower.includes('fantastic')) {
    return 'happy';
  }
  
  // Sad/negative indicators
  if (lower.includes('sad') || lower.includes('upset') || lower.includes('depressed') || 
      lower.includes('worried') || lower.includes('anxious') || lower.includes('stressed') ||
      lower.includes('difficult') || lower.includes('hard') || lower.includes('tough')) {
    return 'sad';
  }
  
  // Encouragement indicators (user is trying)
  if (lower.includes('try') || lower.includes('attempt') || lower.includes('practice') || 
      lower.includes('learn') || lower.includes('improve') || lower.includes('better')) {
    return 'encouraging';
  }
  
  // Empathy indicators (user sharing personal experience)
  if (lower.includes('feel') || lower.includes('experience') || lower.includes('myself') || 
      lower.includes('personally') || lower.includes('i think') || lower.includes('i believe')) {
    return 'empathetic';
  }
  
  // Excitement indicators
  if (lower.includes('wow') || lower.includes('really') || lower.includes('very') || 
      lower.includes('so') || lower.includes('too')) {
    return 'excited';
  }
  
  // Question - thoughtful
  if (userMessage.trim().endsWith('?')) {
    return 'thoughtful';
  }
  
  // Friendly conversation
  if (lower.includes('hello') || lower.includes('hi') || lower.includes('hey') || 
      lower.includes('thanks') || lower.includes('thank you')) {
    return 'friendly';
  }
  
  return 'neutral';
}

// ============================================================
// SOCKET.IO - COMPLETE FRIEND CALL FIXED
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
    joinedAt: Date.now()
  });
  
  socket.userId = userId;
  socket.emit("user-id", userId);
  console.log(`👤 User ${userId} registered (NOT busy)`);
  broadcastOnlineUsers();

  // ========== SET PEER ID ==========
  socket.on("set-peer-id", (peerId) => {
    const user = users.get(userId);
    if (user) {
      user.peerId = peerId;
      console.log(`🔗 User ${userId} set Peer ID: ${peerId}`);
    }
  });

  // ========== SET VOICE PREFERENCE ==========
  socket.on("set-voice-preference", (voiceId) => {
    const user = users.get(userId);
    if (user) user.voicePreference = voiceId;
  });

  // ========== GET VOICES ==========
  socket.on("get-voices", (callback) => {
    callback(VOICES);
  });

  // ========== FIND USER ==========
  socket.on("find-user", (targetUserId, callback) => {
    console.log(`🔍 Looking for user: ${targetUserId}`);
    const user = users.get(targetUserId);
    
    if (!user) {
      callback({ exists: false, message: "User not found" });
      return;
    }
    
    if (!user.connected) {
      callback({ exists: true, online: false, message: "User is offline" });
      return;
    }
    
    if (user.busy) {
      callback({ exists: true, online: true, busy: true, message: "User is in a call" });
      return;
    }
    
    console.log(`✅ User ${targetUserId} found and available`);
    callback({
      exists: true,
      online: true,
      busy: false,
      peerId: user.peerId,
      userId: targetUserId
    });
  });

  // ========== CALL REQUEST - FIXED ==========
  socket.on("call-request", (targetUserId) => {
    console.log(`📞 ${userId} calling ${targetUserId}`);
    
    const caller = users.get(userId);
    const target = users.get(targetUserId);

    if (!caller || !target || !target.connected) {
      socket.emit("call-error", "User not available");
      return;
    }

    if (target.busy) {
      socket.emit("call-error", "User is in a call");
      return;
    }

    if (caller.busy) {
      socket.emit("call-error", "You are already in a call");
      return;
    }

    // Mark caller as busy
    caller.busy = true;
    
    // Generate call ID
    const callId = `call_${Date.now()}_${userId}_${targetUserId}`;
    
    // Store pending request with timeout
    pendingCallRequests.set(callId, {
      caller: userId,
      target: targetUserId,
      status: 'pending',
      timestamp: Date.now(),
      timeout: setTimeout(() => {
        // Call timeout
        const pending = pendingCallRequests.get(callId);
        if (pending && pending.status === 'pending') {
          console.log(`⏰ Call ${callId} timed out`);
          pending.status = 'timedout';
          
          // Free caller
          const callerUser = users.get(pending.caller);
          if (callerUser) callerUser.busy = false;
          
          // Notify caller
          const callerSocket = users.get(pending.caller);
          if (callerSocket && callerSocket.connected) {
            io.to(callerSocket.socketId).emit("call-timeout");
          }
          
          pendingCallRequests.delete(callId);
          broadcastOnlineUsers();
        }
      }, 30000) // 30 second timeout
    });

    console.log(`📤 Sending incoming-call to ${targetUserId} (socket: ${target.socketId})`);
    
    // Send incoming call to target
    io.to(target.socketId).emit("incoming-call", {
      callId: callId,
      from: userId,
      fromPeerId: caller.peerId,
      fromName: `User ${userId}`
    });
    
    broadcastOnlineUsers();
  });

  // ========== CALL RESPONSE - FIXED ==========
  socket.on("call-response", (data) => {
    const { callId, accepted } = data;
    
    console.log(`📞 Call response for ${callId}: ${accepted ? 'ACCEPTED' : 'DECLINED'}`);
    
    const pendingCall = pendingCallRequests.get(callId);
    if (!pendingCall) {
      socket.emit("call-error", "Call request expired");
      return;
    }

    // Clear timeout
    if (pendingCall.timeout) {
      clearTimeout(pendingCall.timeout);
    }

    const caller = users.get(pendingCall.caller);
    const responder = users.get(pendingCall.target);

    if (!caller || !caller.connected) {
      socket.emit("call-error", "Caller no longer available");
      if (responder) responder.busy = false;
      pendingCallRequests.delete(callId);
      broadcastOnlineUsers();
      return;
    }

    if (accepted) {
      console.log(`✅ ${pendingCall.target} accepted call from ${pendingCall.caller}`);
      
      // Mark both as busy
      if (caller) caller.busy = true;
      if (responder) responder.busy = true;

      // Create active call record
      activeCalls.set(callId, {
        userA: pendingCall.caller,
        userB: pendingCall.target,
        status: 'connected',
        startedAt: Date.now()
      });

      // Remove from pending
      pendingCallRequests.delete(callId);

      // Send acceptance to caller
      io.to(caller.socketId).emit("call-accepted", {
        callId: callId,
        peerId: responder.peerId,
        userId: pendingCall.target
      });
      
      // Send connected to responder
      io.to(responder.socketId).emit("call-connected", {
        callId: callId,
        peerId: caller.peerId,
        userId: pendingCall.caller
      });
      
      broadcastOnlineUsers();
    } else {
      console.log(`❌ ${pendingCall.target} declined call from ${pendingCall.caller}`);
      
      // Free caller from busy state
      if (caller) caller.busy = false;
      if (responder) responder.busy = false;
      
      // Remove from pending
      pendingCallRequests.delete(callId);
      
      // Notify caller
      io.to(caller.socketId).emit("call-declined");
      broadcastOnlineUsers();
    }
  });

  // ========== CANCEL CALL - FIXED ==========
  socket.on("cancel-call", (callId) => {
    console.log(`📞 ${userId} cancelling call: ${callId}`);
    
    const pendingCall = pendingCallRequests.get(callId);
    if (pendingCall) {
      // Clear timeout
      if (pendingCall.timeout) {
        clearTimeout(pendingCall.timeout);
      }
      
      // Free caller
      const caller = users.get(pendingCall.caller);
      if (caller) caller.busy = false;
      
      // Notify target if needed
      const target = users.get(pendingCall.target);
      if (target && target.connected) {
        io.to(target.socketId).emit("call-cancelled");
      }
      
      pendingCallRequests.delete(callId);
      broadcastOnlineUsers();
    }
  });

  // ========== END CALL ==========
  socket.on("end-call", (callId) => {
    console.log(`📞 ${userId} ending call: ${callId}`);
    
    const user = users.get(userId);
    if (user) user.busy = false;
    
    if (callId && activeCalls.has(callId)) {
      const call = activeCalls.get(callId);
      const otherId = call.userA === userId ? call.userB : call.userA;
      const otherUser = users.get(otherId);
      
      if (otherUser && otherUser.connected) {
        otherUser.busy = false;
        io.to(otherUser.socketId).emit("call-ended");
      }
      
      activeCalls.delete(callId);
    } else {
      // Clean up any call involving this user
      for (const [id, call] of activeCalls) {
        if (call.userA === userId || call.userB === userId) {
          const otherId = call.userA === userId ? call.userB : call.userA;
          const otherUser = users.get(otherId);
          if (otherUser && otherUser.connected) {
            otherUser.busy = false;
            io.to(otherUser.socketId).emit("call-ended");
          }
          activeCalls.delete(id);
        }
      }
    }
    
    broadcastOnlineUsers();
  });

  // ========== FIND RANDOM ==========
  socket.on("find-random", () => {
    console.log(`🎲 ${userId} looking for random user`);
    
    const availableUsers = [];
    users.forEach((user, id) => {
      if (id !== userId && user.connected && !user.busy && user.peerId) {
        availableUsers.push({
          userId: id,
          peerId: user.peerId,
          socketId: user.socketId
        });
      }
    });

    if (availableUsers.length === 0) {
      socket.emit("no-users-available");
      return;
    }

    const randomIndex = Math.floor(Math.random() * availableUsers.length);
    const match = availableUsers[randomIndex];

    const user1 = users.get(userId);
    const user2 = users.get(match.userId);
    
    if (user1) user1.busy = true;
    if (user2) user2.busy = true;

    const callId = `call_${Date.now()}_${userId}_${match.userId}`;
    activeCalls.set(callId, {
      userA: userId,
      userB: match.userId,
      status: 'connected',
      startedAt: Date.now()
    });

    socket.emit("random-match", {
      peerId: match.peerId,
      userId: match.userId
    });
    
    io.to(match.socketId).emit("random-match", {
      peerId: user1.peerId,
      userId: userId
    });

    broadcastOnlineUsers();
  });

  // ========== DISCONNECT ==========
  socket.on("disconnect", () => {
    console.log(`🔴 Client disconnected: ${socket.id}`);
    
    if (socket.userId) {
      const user = users.get(socket.userId);
      if (user) {
        user.connected = false;
        user.busy = false;
        
        // Clean up active calls
        for (const [callId, call] of activeCalls) {
          if (call.userA === socket.userId || call.userB === socket.userId) {
            activeCalls.delete(callId);
            const otherId = call.userA === socket.userId ? call.userB : call.userA;
            const otherUser = users.get(otherId);
            if (otherUser && otherUser.connected) {
              io.to(otherUser.socketId).emit("call-ended");
              otherUser.busy = false;
            }
          }
        }
        
        // Clean up pending requests with timeout
        for (const [callId, req] of pendingCallRequests) {
          if (req.caller === socket.userId || req.target === socket.userId) {
            if (req.timeout) clearTimeout(req.timeout);
            pendingCallRequests.delete(callId);
          }
        }
        
        broadcastOnlineUsers();
        
        setTimeout(() => {
          if (users.has(socket.userId) && !users.get(socket.userId).connected) {
            userIdPool.delete(socket.userId);
            users.delete(socket.userId);
            console.log(`🗑️ Removed user ${socket.userId}`);
          }
        }, 30000);
      }
    }
  });
});

// ========== BROADCAST ONLINE USERS ==========
function broadcastOnlineUsers() {
  const onlineUsers = [];
  users.forEach((user, id) => {
    if (user.connected) {
      onlineUsers.push({
        userId: id,
        busy: user.busy || false
      });
    }
  });
  console.log(`📊 Broadcasting ${onlineUsers.length} online users`);
  io.emit("online-users", onlineUsers);
}

// ============================================================
// AI CHAT ENDPOINT WITH EMOTION DETECTION
// ============================================================
app.post("/api/chat", async (req, res) => {
  try {
    if (!API_KEY || API_KEY === "your_api_key_here") {
      return res.status(500).json({
        error: "GROQ_API_KEY missing. Get free key from console.groq.com"
      });
    }

    const { messages: newMessages, userLevel, userProfession, userGoal, conversationId } = req.body || {};

    if (!newMessages || !Array.isArray(newMessages) || newMessages.length === 0) {
      return res.status(400).json({ error: "'messages' array required." });
    }

    const userMessage = newMessages[newMessages.length - 1]?.content || '';

    if (conversationId) {
      addMessage(conversationId, 'user', userMessage);
    }

    const recentMessages = conversationId ? getRecentMessages(conversationId, 15) : [];
    const conv = conversationId ? getConversation(conversationId) : { facts: {}, topic: null };

    // Detect emotion
    const emotion = detectEmotion(userMessage, recentMessages);
    conv.emotionContext = emotion;

    let contextSummary = '';
    if (conv.facts && Object.keys(conv.facts).length > 0) {
      contextSummary = `\nIMPORTANT FACTS:\n${Object.entries(conv.facts).map(([k, v]) => `- ${k}: ${v}`).join('\n')}`;
    }
    if (conv.topic) {
      contextSummary += `\nCURRENT TOPIC: ${conv.topic}`;
    }

    let historyText = '';
    if (recentMessages.length > 1) {
      historyText = recentMessages.map(m => `${m.role === 'user' ? 'User' : 'AI'}: ${m.content}`).join('\n');
    }

    const levelMap = {
      beginner: "BEGINNER - Use simple words, short sentences, be extremely encouraging.",
      intermediate: "INTERMEDIATE - They can form sentences but make mistakes. Correct gently.",
      advanced: "ADVANCED - Speak fluently, use sophisticated language."
    };

    const level = levelMap[userLevel] || levelMap['intermediate'];

    const emotionInstruction = {
      'happy': "The user sounds happy or positive. Respond with warm, encouraging, and joyful energy. Sound genuinely happy for them.",
      'sad': "The user sounds sad or upset. Respond with calm, gentle, and empathetic tone. Be supportive and understanding.",
      'encouraging': "The user is trying to improve. Respond with strong encouragement and motivation. Sound supportive and confident.",
      'empathetic': "The user is sharing something personal. Respond with deep empathy, warmth, and understanding.",
      'excited': "The user is excited. Match their energy with enthusiasm and positive energy.",
      'calm': "The user sounds calm or thoughtful. Respond with a calm, measured, and thoughtful tone.",
      'thoughtful': "The user is thinking deeply. Respond with a thoughtful, measured, and reflective tone.",
      'friendly': "The user is being friendly. Respond warmly and casually like a friend.",
      'professional': "The user is being professional. Respond with a clear, professional, and articulate tone.",
      'neutral': "Respond with a natural, friendly, and conversational tone."
    };

    const systemPrompt = `You are an intelligent, empathetic English conversation partner named Madhu. You are helping an Indian user improve their English.

USER PROFILE:
- Level: ${level}
- Profession: ${userProfession || 'Not specified'}
- Goal: ${userGoal || 'General conversation'}

CONVERSATION CONTEXT:
${contextSummary}

RECENT CONVERSATION:
${historyText || 'This is a new conversation.'}

EMOTION DETECTED: ${emotion}
EMOTION INSTRUCTION: ${emotionInstruction[emotion] || emotionInstruction['neutral']}

CRITICAL RULES:
1. If the user asks a question, ANSWER IT DIRECTLY first.
2. If the user asks about "my last response", analyze the ACTUAL previous user message.
3. NEVER say a response is correct without analyzing it.
4. Never return null/empty correction.
5. Respond naturally like a human with appropriate emotion.
6. Only ask a follow-up question if it's relevant.

RESPONSE FORMAT (JSON only):
{
  "reply": "Your natural spoken response (1-3 sentences)",
  "correction": "Direct grammatical correction of the user's sentence (preserve meaning)",
  "naturalVersion": "More natural way to say the same thing",
  "wordChanges": [{"wrong": "original word", "correct": "corrected word", "reason": "why"}],
  "explanation": "Brief explanation of the main mistake",
  "emotion": "The emotion you are expressing (happy, sad, encouraging, empathetic, excited, calm, thoughtful, friendly, professional, neutral)"
}`;

    const apiMessages = [{ role: "system", content: systemPrompt }];
    const historyToSend = recentMessages.slice(-10);
    apiMessages.push(...historyToSend);

    if (!apiMessages.some(m => m.role === 'user' && m.content === userMessage)) {
      apiMessages.push({ role: 'user', content: userMessage });
    }

    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${API_KEY}`
      },
      body: JSON.stringify({
        model: MODEL,
        messages: apiMessages,
        max_tokens: 800,
        temperature: 0.8,
        response_format: { type: "json_object" }
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("Groq API error:", data);
      return res.status(response.status).json({
        error: data.error?.message || "Groq API error"
      });
    }

    const aiContent = data.choices?.[0]?.message?.content ||
      '{"reply":"I understand. Could you say that again?","correction":null,"naturalVersion":null,"wordChanges":[],"explanation":"","emotion":"neutral"}';

    let parsed;
    try {
      parsed = JSON.parse(aiContent);
    } catch (e) {
      parsed = {
        reply: "I appreciate you sharing that. Could you tell me more?",
        correction: null,
        naturalVersion: null,
        wordChanges: [],
        explanation: "",
        emotion: "neutral"
      };
    }

    if (conversationId) {
      addMessage(conversationId, 'assistant', parsed.reply);
      if (userMessage.toLowerCase().includes('my name is') || userMessage.toLowerCase().includes('call me')) {
        const nameMatch = userMessage.match(/(?:my name is|call me|i am)\s+(\w+)/i);
        if (nameMatch) {
          const facts = conv.facts || {};
          facts.user_name = nameMatch[1];
          conv.facts = facts;
        }
      }
      if (userMessage.length > 10) {
        conv.topic = userMessage.substring(0, 50);
      }
    }

    // Use detected emotion or fallback to neutral
    const responseEmotion = parsed.emotion || emotion || 'neutral';

    res.json({
      reply: parsed.reply || "I understand what you mean.",
      correction: parsed.correction || null,
      naturalVersion: parsed.naturalVersion || null,
      wordChanges: parsed.wordChanges || [],
      explanation: parsed.explanation || "",
      emotion: responseEmotion
    });

  } catch (err) {
    console.error("Server error:", err);
    res.status(500).json({ error: err.message || "Server error." });
  }
});

// ============================================================
// TTS ENDPOINT WITH SSML SUPPORT
// ============================================================
app.post('/api/tts', async (req, res) => {
  try {
    const { text, voice = 'en-IN-NeerjaNeural', emotion = 'neutral' } = req.body;
    
    if (!text) {
      return res.status(400).json({ error: 'Text is required' });
    }

    console.log(`🔊 TTS: Speaking "${text.substring(0, 50)}..." with voice ${voice}, emotion: ${emotion}`);

    // Generate SSML with natural speech
    const ssml = generateSSML(text, emotion, voice);

    // Use Edge TTS with SSML
    const response = await fetch('https://edge-tts-api.vercel.app/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: ssml,
        voice: voice,
        rate: 0,
        pitch: 0
      })
    });

    if (!response.ok) {
      throw new Error('TTS service failed');
    }

    const audioBuffer = await response.arrayBuffer();
    console.log(`✅ TTS: Generated ${audioBuffer.byteLength} bytes of audio`);
    
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(Buffer.from(audioBuffer));

  } catch (err) {
    console.error('❌ TTS Error:', err);
    // Fallback to basic TTS without SSML
    try {
      const { text, voice = 'en-IN-NeerjaNeural' } = req.body;
      const response = await fetch('https://edge-tts-api.vercel.app/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: text,
          voice: voice,
          rate: 0,
          pitch: 0
        })
      });
      if (response.ok) {
        const audioBuffer = await response.arrayBuffer();
        res.setHeader('Content-Type', 'audio/mpeg');
        res.send(Buffer.from(audioBuffer));
        return;
      }
    } catch (fallbackErr) {
      console.error('Fallback TTS also failed:', fallbackErr);
    }
    res.status(500).json({ error: err.message || 'TTS failed' });
  }
});

// ============================================================
// HEALTH CHECK
// ============================================================
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    apiKeyConfigured: Boolean(API_KEY && API_KEY !== "your_api_key_here"),
    model: MODEL,
    onlineUsers: users.size,
    activeCalls: activeCalls.size,
    pendingCalls: pendingCallRequests.size,
    totalVoiceOptions: VOICES.male.length + VOICES.female.length,
    activeConversations: conversationMemory.size,
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
  console.log(`  ✅ SSML Natural Voice with Emotions Enabled`);
  console.log(`  ✅ Real-time Presence System Active`);
  console.log(`  ✅ Friend Call with Accept/Decline/Timeout`);
  console.log(`  ✅ Features: AI Chat, AI Voice, Friend Call\n`);
});