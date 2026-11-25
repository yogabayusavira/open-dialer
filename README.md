# Open Dialer

An outbound calling CRM you run yourself. Call leads from the browser through your own Twilio account, with call
scripts, per-lead variables, voicemail drop, follow-ups, a pipeline, analytics and n8n-style automations. Every
feature that costs money shows its price in Settings and can be switched off.

**Features**

- **Calling:** call from the browser (or ring your phone or a VoIP app first), from your own Twilio number. Mic
  picker, mute, keypad, booking link.
- **Campaigns:**
  - scripts with `{{variables}}` filled from each lead
  - "only if" lines per lead
  - pinned lead details
  - optional AI cleanup of messy values
- **Voicemail drop:** record once, drop at the beep, pick a recording per lead.
- **Leads and pipeline:** CSV import with column mapping, stages, follow-ups and tasks, do-not-call list, call history
  with export.
- **Automations:** triggers like a call outcome or a finished transcript, then steps such as wait, send email, send
  text, Ask AI, move stage and follow up.
- **Live transcription (optional):** captions during a call and transcripts afterwards, through Twilio. Nothing is
  recorded.
- **Teams:** invite-only accounts, owners and callers, several companies on one install.

## What you need

| | What for | Get it |
|---|---|---|
| **Windows 10/11** (or macOS/Linux, see below) | Running the app | |
| **Node.js 22 or newer** | Runs the app | https://nodejs.org |
| **cloudflared** | A free tunnel so Twilio can reach your computer | https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/ |
| **A Twilio account** with a voice-capable number | Placing calls | https://www.twilio.com/try-twilio |
| Optional: **Docker Desktop** | Only if you want PostgreSQL instead of the built-in file storage | https://www.docker.com/products/docker-desktop/ |
| Optional: a **Groq** key | AI features (free plan) | https://console.groq.com/keys |
| Optional: a **Resend** account | Invite and password emails from your domain | https://resend.com |

The Windows setup wizard installs Node.js, cloudflared and (if you pick it) Docker for you. What each part costs is
listed in [PRICES.md](PRICES.md) and in the app under Settings, Features & costs. The app itself is free.

## Install on Windows

1. Download **`OpenDialerSetup.exe`** from the [latest release](https://github.com/yogabayusavira/open-dialer/releases/latest).
2. Run it. Windows may say "Windows protected your PC" because the installer isn't code-signed yet: click
   **More info → Run anyway**.
3. The wizard shows what it will install (each with a link to read more), asks where to keep your data
   (**Simple**, a file in the Open Dialer folder, or **PostgreSQL in Docker**) and where to install. It then
   installs what's missing, runs `npm install` and writes `.env` with a freshly generated encryption key (and the
   database address for PostgreSQL). You never edit `.env` by hand.
4. Leave **Start Open Dialer now** ticked and click Finish. Later, start it from the Start menu or desktop shortcut.
5. In the browser, **create your owner account** (the first visit asks for it), then go to **Settings → Phone
   numbers** and connect Twilio with your Account SID and Auth Token.

Keep the Open Dialer window open while you call. Uninstalling keeps your `data` folder and `.env`. More detail and
troubleshooting: [RUNNING-LOCALLY.md](RUNNING-LOCALLY.md).

## Install from a terminal (Windows, macOS, Linux)

Install Node.js 22+ and cloudflared (macOS: `brew install node cloudflared`), then in the downloaded folder:

```bash
npm install
npm run setup             # writes .env with a new encryption key; data is kept in the data folder
npm run local             # starts everything; open http://localhost:3000
```

For PostgreSQL in Docker instead, install Docker and run `npm run setup -- --docker`.

## Install it with an AI agent

Using Claude Code, Codex or another coding agent? Paste this:

> Install Open Dialer on this computer from https://github.com/yogabayusavira/open-dialer. Clone it into a folder I
> choose (ask me where; avoid the C: drive if it's low on space). Install anything missing: Node.js 22 or newer and
> cloudflared, and Docker only if I say I want PostgreSQL. Run `npm install`, then `npm run setup` (or
> `npm run setup -- --docker` for PostgreSQL), which writes `.env` with new secrets. Never print or share what's in
> `.env`. Then run `npm run local`, open http://localhost:3000, and tell me to create my owner account and connect
> Twilio in Settings → Phone numbers. If a step fails, show me the error and explain it before trying something else.

## Host it on a server instead

A hosted copy has a fixed public address, so it needs no tunnel. With Dokploy (or any Docker host):

1. Create an application from this repository using the included `Dockerfile`, container port `3000`.
2. Set `DATABASE_URL` (a Postgres database), `OPEN_DIALER_ENCRYPTION_KEY` (a long random secret) and
   `OPEN_DIALER_PUBLIC_URL` (its HTTPS address). See [.env.example](.env.example).
3. Add a domain and deploy. The first visit asks you to create the owner account.

Before real calls, check consent and calling rules for where you call. Some US states also require consent for call
transcription.

## Security

- Twilio Auth Tokens and AI/email keys are encrypted (AES-256-GCM with `OPEN_DIALER_ENCRYPTION_KEY`) and never sent
  back to the browser. Keep `.env` private and never commit it.
- Accounts are invite-only after the first owner, with scrypt-hashed passwords and rate-limited sign-in. Each company
  has its own workspace; callers only see leads assigned to them.
- Back up the `data` folder: it holds your data (or the PostgreSQL files).

## License

Open Dialer is © 2026 Yoga Bayu Savira, released under the [GNU AGPL-3.0](LICENSE) with the additional terms in
[NOTICE.md](NOTICE.md): keep the "Powered by Open Dialer · by Yoga Bayu Savira" credit visible, don't use the Open
Dialer name or logo for your own version, and share the source of any changed version you let others use.
White-label and commercial licenses: [COMMERCIAL.md](COMMERCIAL.md). Contributing: [CONTRIBUTING.md](CONTRIBUTING.md).
Contributors: [CONTRIBUTORS.md](CONTRIBUTORS.md).
