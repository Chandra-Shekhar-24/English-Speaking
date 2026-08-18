# 🇮🇳 English Passport Pro

**AI English Conversation Practice + Real Accounts, Friend Calls (Voice/Video/Group), Chat, and Persistent History**

## Features
- **Real Accounts** – Sign up / Sign in / Logout / Forgot & Reset Password (bcrypt-hashed passwords, secure sessions)
- **Permanent 4-digit User ID** – you choose it at signup, it never changes on its own; change it anytime from your account
- **AI Voice + Text Chat** – natural, human-like conversation with grammar corrections kept separate from replies
- **20 Indian Voices** – 10 Male + 10 Female
- **Friend Calls** – Voice or Video, fullscreen video, mute, camera on/off
- **Group Calls** – add multiple friends by ID, invite more mid-call
- **Friend Text Chat** – with delivery ticks, toast notifications, unread badges
- **Incoming Call Screen** – ringtone, ringback tone, phone-style Accept/Decline
- **Persistent History** – chat messages and call history survive restarts

## Required External Services
| Service | Why | Where to get it (free tier available) |
|---|---|---|
| PostgreSQL database | accounts, sessions, permanent User IDs | [Neon](https://neon.tech), [Supabase](https://supabase.com), Render Postgres, Railway |
| Groq API key | AI text/voice replies | [console.groq.com](https://console.groq.com) |
| Resend API key *(optional)* | sends real "forgot password" emails | [resend.com](https://resend.com) — without this, reset links print to the server console instead (fine for local dev) |

## Setup (local)
1. Install Node.js 18+
2. `npm install`
3. Create a free Postgres database (e.g. on Neon) and copy its connection string
4. Run the schema once against that database:
   ```
   psql "your-connection-string" -f db/schema.sql
   ```
   (Or paste the contents of `db/schema.sql` into your provider's SQL editor — Neon/Supabase both have one built in.)
5. Copy `.env.example` to `.env` and fill in `DATABASE_URL`, `GROQ_API_KEY`, and `APP_URL=http://localhost:3000`
6. `npm start`
7. Open `http://localhost:3000` in **Chrome**, create an account, and go

## Project Structure
```
english-passport-pro/
├── public/
│   └── index.html        # Frontend — auth screens, onboarding, chat, calls
├── db/
│   ├── schema.sql          # PostgreSQL schema — run this once
│   └── pool.js              # Postgres connection pool
├── auth.js                 # Signup / login / logout / password reset / session verification
├── server.js                # Express + Socket.IO — signaling, AI endpoints, REST auth API
├── db.js                    # Local JSON-file store for chat/call history (separate from Postgres)
├── package.json
├── .env.example
├── .gitignore
└── README.md
```

## How to Deploy to Production
1. Push this repo to GitHub
2. Create a **Web Service** on Render (or Railway/Fly.io) pointing at the repo — build command `npm install`, start command `npm start`
3. In the host's **Environment Variables** panel, set: `DATABASE_URL`, `GROQ_API_KEY`, `APP_URL` (your deployed URL), `NODE_ENV=production`, and `RESEND_API_KEY` if you want real password-reset emails
4. Run `db/schema.sql` once against your production database (same command as local setup, pointed at the production `DATABASE_URL`)
5. Deploy — the app now runs independently of your own computer being on

## Current Limitations (being addressed in later phases)
- **Friend requests / accept-reject gating** are not yet built — anyone can message or call anyone by ID (like the original design), rather than requiring a mutual "friend" connection first.
- **Blocking** is not yet implemented.
- **File/image/media sharing** is not yet implemented (needs a cloud storage provider like S3/Cloudinary).
- **Front/back camera switching** on mobile is not yet implemented.
- **Floating/minimized call widget** while chatting is not yet implemented — chat and calls work independently but the call isn't yet shown as a floating window over chat.
- **TURN server** is not configured — calls between two users on strict/symmetric NAT (common on some mobile networks and corporate WiFi) may fail to connect. A STUN-only setup works for most home/mobile networks.
- **1,000 simultaneous pairs**: the current architecture (Socket.IO signaling + P2P WebRTC media) does not route call media through the server, so raw signaling load for 1,000 pairs is light for a single Node process — but this has not been load-tested, and running multiple server instances would need a Redis-backed Socket.IO adapter (not yet added) since presence/call state currently lives in a single process's memory.
