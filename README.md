# 🇮🇳 English Passport Pro

**AI English Conversation Practice + Real Accounts, Friend Calls (Voice/Video/Group), Chat, and Persistent History**

## Features
- **Real Accounts** – Sign up / Sign in / Logout / Forgot & Reset Password (bcrypt-hashed passwords, secure sessions)
- **Permanent 4-digit User ID** – you choose it at signup, it never changes on its own; change it anytime from your account
- **Auto-synced Google Sheet** *(optional)* – every signup/ID-change automatically appears in a spreadsheet you own
- **AI Voice + Text Chat** – natural, human-like conversation with grammar corrections kept separate from replies
- **20 Indian Voices** – 10 Male + 10 Female
- **Friend Calls** – Voice or Video, fullscreen video, mute, camera on/off
- **Group Calls** – add multiple friends by ID, invite more mid-call
- **Friend Text Chat** – with delivery ticks, toast notifications, unread badges
- **Persistent History** – chat messages and call history survive restarts

---

## Where your data lives (and how to look at it)

This app uses **two** separate stores, for two different purposes:

| Store | What's in it | Where | How permanent |
|---|---|---|---|
| **PostgreSQL** | accounts, sessions, permanent IDs | wherever you point `DATABASE_URL` (Neon/Supabase/etc — your own database) | permanent, real database |
| **Local JSON file** (`english-passport-data.json`) | chat messages, call history | on the server's disk, next to `server.js` | ⚠️ on free hosting tiers this can be wiped on redeploy — see note below |
| **Google Sheet** *(optional)* | a live mirror of the `users` table | a Google Sheet you create and own | as permanent as the sheet itself |

### Viewing / editing the database directly (SQL)

You don't need any special tool beyond what your Postgres provider already gives you:

- **Neon / Supabase**: log into their dashboard → open the **SQL Editor** tab → run any query below.
- **From your own terminal** (if you have `psql` installed):
  ```
  psql "your-connection-string-from-.env"
  ```

**Common queries you'll actually use:**

```sql
-- See everyone who has an account
SELECT id, user_code, email, display_name, created_at FROM users ORDER BY created_at DESC;

-- Find one specific user
SELECT * FROM users WHERE user_code = '4821';

-- Delete a user's account entirely (their sessions/messages/etc.
-- are removed automatically too, via ON DELETE CASCADE)
DELETE FROM users WHERE user_code = '4821';

-- Force-log-out one user everywhere (delete just their sessions,
-- keep the account)
DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE user_code = '4821');

-- See recent chat messages
SELECT * FROM messages ORDER BY created_at DESC LIMIT 50;

-- See call history
SELECT * FROM calls ORDER BY started_at DESC LIMIT 50;

-- Rename a column, add a column, etc. — ALTER TABLE works exactly
-- like normal SQL, for example:
ALTER TABLE users ADD COLUMN bio TEXT;
ALTER TABLE users ALTER COLUMN display_name TYPE VARCHAR(150);
ALTER TABLE users DROP COLUMN bio;
```

Nothing about this app is special here — it's a completely normal PostgreSQL database, so any SQL you already know works exactly as-is. If you're new to SQL, both Neon's and Supabase's SQL Editors also have an AI-assist / autocomplete that can write queries for you from a plain-English description.

### Deleting a user's account without touching SQL

Two ways:

1. **The `DELETE` query above**, run in your provider's SQL Editor — simplest, no setup needed.
2. **The built-in admin API route** — set `ADMIN_SECRET` in your `.env` to any long random string, then:
   ```
   curl -X DELETE http://localhost:3000/api/admin/users/4821 \
     -H "x-admin-secret: your_admin_secret_here"
   ```
   This deletes the account from Postgres **and** removes their row from the Google Sheet (if you've set that up) in one call.

### The local JSON file (chat/call history) — important caveat

On **Render's free tier** (and similar), the filesystem is wiped on every redeploy/restart. `english-passport-data.json` is fine for local development, but if you need chat/call history to survive redeploys in production, that data should move into PostgreSQL too (the `messages` and `calls` tables already exist in the schema for exactly this — this is a good next step, ask if you want it built).

---

## Auto-synced Google Sheet (optional)

Every signup adds a row; changing your ID updates that row in place. This is entirely optional — skip this section if you're happy using SQL directly.

**Setup:**
1. Go to [Google Cloud Console](https://console.cloud.google.com) → create a new project (or use an existing one).
2. **APIs & Services → Library** → search "Google Sheets API" → **Enable**.
3. **APIs & Services → Credentials** → **Create Credentials → Service Account** → give it any name → **Create and Continue** → **Done**.
4. Click into the new service account → **Keys** tab → **Add Key → Create New Key → JSON** → a file downloads.
5. Open that JSON file. You need two values from it:
   - `client_email` → this is `GOOGLE_SERVICE_ACCOUNT_EMAIL`
   - `private_key` → this is `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` (keep the `\n` characters exactly as they appear in the file — paste the whole string as one line in `.env`)
6. Create a new [Google Sheet](https://sheets.google.com). Rename its first tab to `Users` (or set `GOOGLE_SHEET_NAME` to whatever you named it).
7. Click **Share** on the sheet → paste in the `client_email` from step 5 → give it **Editor** access.
8. Copy the Sheet ID from its URL: `https://docs.google.com/spreadsheets/d/`**`THIS_PART`**`/edit` → this is `GOOGLE_SHEET_ID`.
9. Put all three values into `.env`, restart the server. You should see `📊 Google Sheets sync enabled` in the console, and a header row appear in the sheet.

You (as the sheet's owner) can open it in your browser anytime and manually edit or delete rows just like any spreadsheet — that access is automatic, it's your sheet.

---

## Required External Services
| Service | Why | Where to get it (free tier available) |
|---|---|---|
| PostgreSQL database | accounts, sessions, permanent User IDs | [Neon](https://neon.tech), [Supabase](https://supabase.com), Render Postgres, Railway |
| Groq API key | AI text/voice replies | [console.groq.com](https://console.groq.com) |
| Resend API key *(optional)* | sends real "forgot password" emails | [resend.com](https://resend.com) — without this, reset links print to the server console instead |
| Google Cloud service account *(optional)* | auto-synced Users spreadsheet | see setup steps above |

## Setup (local)
1. Install Node.js 18+
2. `npm install`
3. Create a free Postgres database (e.g. on Neon) and copy its connection string
4. Run the schema once against that database:
   ```
   psql "your-connection-string" -f db/schema.sql
   ```
   (Or paste the contents of `db/schema.sql` into your provider's SQL editor.)
5. Copy `.env.example` to `.env` and fill in `DATABASE_URL`, `GROQ_API_KEY`, `APP_URL=http://localhost:3000` (Google Sheets vars are optional)
6. `npm start`
7. Open `http://localhost:3000` in **Chrome**, create an account, and go

## Project Structure
```
english-passport-pro/
├── public/
│   └── index.html        # Frontend — auth screens, onboarding, chat, calls
├── db/
│   ├── schema.sql          # PostgreSQL schema — run this once
│   └── pool.js               # Postgres connection pool
├── auth.js                  # Signup / login / logout / password reset / session verification
├── sheets.js                 # Optional Google Sheets sync for the users table
├── server.js                  # Express + Socket.IO — signaling, AI endpoints, REST auth API
├── db.js                       # Local JSON-file store for chat/call history (separate from Postgres)
├── package.json
├── .env.example
├── .gitignore
└── README.md
```

## How to Deploy to Production
1. Push this repo to GitHub
2. Create a **Web Service** on Render (or Railway/Fly.io) pointing at the repo — build command `npm install`, start command `npm start`
3. In the host's **Environment Variables** panel, set every value from `.env.example` that you're using
4. Run `db/schema.sql` once against your production database
5. Deploy — the app now runs independently of your own computer being on

## Current Limitations (being addressed in later phases)
- **Friend requests / accept-reject gating** are not yet built — anyone can message or call anyone by ID.
- **Blocking** is not yet implemented.
- ~~File/image/media sharing~~ **Now implemented** — Friend Chat supports images, videos, PDFs, and documents (via Cloudinary). Attachments auto-expire and are permanently deleted ~24 hours after sending. Requires `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` in `.env` (free tier at cloudinary.com).
- **Front/back camera switching** on mobile is not yet implemented.
- **Floating/minimized call widget** while chatting is not yet implemented.
- **TURN server** is not configured — calls between two users on strict/symmetric NAT may fail to connect.
- **Chat/call history** lives in a local JSON file, not Postgres yet — see the caveat above.
- **1,000 simultaneous pairs**: architecture is signaling-light (media is P2P, not routed through the server) which helps, but this has not been load-tested, and horizontal scaling would need a Redis-backed Socket.IO adapter (not yet added).
