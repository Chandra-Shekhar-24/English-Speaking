# 🇮🇳 English Passport Pro

**Premium AI English Conversation Practice with 20 Indian Voices + Real-time Friend Calls, Video, Group Calls & Chat**

## Features
- **User Name System** – Enter your name, AI addresses you personally
- **AI Voice Call** – Speak naturally with AI, get real-time corrections, warm human-like conversation
- **20 Indian Voices** – 10 Male + 10 Female, natural Indian accents
- **Live Conversation** – See every message on the same voice call screen
- **Grammar Correction** – 3-tier comparison: You Said → Corrected → Natural
- **Word-level Changes** – See exactly what words were wrong and why
- **Friend Call (Voice + Video)** – Real-time calls with 4-digit User ID + Name display
- **Fullscreen Video Calls** – Local + remote video, mute, camera on/off
- **Group Calls** – Add multiple friends by ID into one voice/video call, invite more mid-call
- **Friend Text Chat** – Direct message any online user, with delivery ticks and notifications
- **Incoming Call Screen** – Ringtone, ringback tone, phone-style Accept/Decline
- **Random Match** – Connect with random online users (voice or video)
- **Real-time Presence** – See who's online and available with names
- **Local Database** – Chat history and call history persist across restarts (zero-setup, file-based)

## Setup
1. Install Node.js 18+
2. `npm install`
3. Create `.env` from `.env.example` and add your **Groq API key** from [console.groq.com](https://console.groq.com)
4. `npm start`
5. Open `http://localhost:3000` in **Chrome**

## How It Works
1. **Onboarding** – Enter your name, select level, profession, and practice goal
2. **AI Voice** – Tap mic, speak naturally, AI responds with voice + text + corrections, uses your name
3. **Friend Call** – Get a 4-digit User ID, connect with friends or random users (voice or video)
4. **Group Call** – Add several friend IDs at once, everyone joins the same call
5. **Chat** – Message any online user directly, even without an active call

## Project Structure
```
english-passport-pro/
├── public/
│   └── index.html      # Frontend (UI, all client-side logic)
├── server.js            # Backend (Express + Socket.IO signaling, AI endpoints)
├── db.js                # Local persistence (chat + call history)
├── package.json
├── .env.example          # Copy to .env and add your API key
├── .gitignore
└── README.md
```

## Technologies
- Node.js + Express
- Socket.IO (real-time presence, signaling, chat)
- PeerJS (WebRTC voice/video/group calls)
- Groq API (Llama 3.1 8B)
- Microsoft Edge TTS (20 Indian voices)
- Web Speech API (speech recognition)
- Plain-JSON file storage for persistence (no native/database server required)

## Note
- Use **Chrome** for voice/video features
- All features are **100% free** (Groq has free tier)
- `.env` is never committed — set `GROQ_API_KEY` in your host's environment variables (e.g. Render dashboard) when deploying
