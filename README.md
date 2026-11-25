# Open Dialer

An outbound calling CRM you run yourself. Call leads from the browser through your own Twilio account, with call
scripts, per-lead variables, voicemail drop, follow-ups, a pipeline, analytics and n8n-style automations. Every
feature that costs money shows its price in Settings and can be switched off.

Run it on your own computer (there's a Windows setup wizard) or deploy it on a server, see
[Deploy on a server](#deploy-on-a-server).

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
| **cloudflared** (not needed on a server) | A tunnel so Twilio can reach your computer | https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/ |
| **A Twilio account** with a voice-capable number | Placing calls | https://www.twilio.com/try-twilio |
| Optional: **Docker Desktop** | Only if you want PostgreSQL instead of the built-in file storage on your computer | https://www.docker.com/products/docker-desktop/ |
| Recommended: a **Resend** account and **your own domain** | Emails team invites and password resets, sent from your domain (you verify the domain in Resend) | https://resend.com |
| Optional: a **Groq** key | AI features | https://console.groq.com/keys |

You don't need Resend to get started: the first owner account is created on the first visit, without email. Without
it, though, you copy each invite link and send it yourself, and nobody can reset a forgotten password by email. Add the
key and sender in Settings → Integrations → Email.

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

## Deploy on a server

Open Dialer runs just as well on a server, so your team can use it from anywhere and nothing needs to stay open on your
computer. A server has a fixed public address, so it needs no tunnel and no cloudflared.

You need:

- a server or hosting platform that runs Docker (a VPS with Dokploy or Coolify, Railway, Render, Fly.io…),
- a PostgreSQL database (most platforms can create one for you),
- a domain or subdomain for the app, like `dialer.yourcompany.com`, with HTTPS,
- Resend with your domain verified, so invites and password resets go out by email.

Steps:

1. Create an application from this repository. It builds with the included `Dockerfile` and listens on port `3000`.
2. Set these environment variables (see [.env.example](.env.example)):
   - `DATABASE_URL`: your PostgreSQL connection string.
   - `OPEN_DIALER_ENCRYPTION_KEY`: a long random secret. Generate one with
     `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` and never change it afterwards.
   - `OPEN_DIALER_PUBLIC_URL`: the app's HTTPS address, like `https://dialer.yourcompany.com`. Twilio and email links
     use it.
3. Point your domain at it and deploy. The app creates its database table on first start.
4. Open the address, create the owner account, then connect Twilio (Settings → Phone numbers) and Resend
   (Settings → Integrations → Email).

With plain Docker on a server:

```bash
docker build -t open-dialer .
docker run -d --name open-dialer --restart unless-stopped -p 3000:3000   -e DATABASE_URL="postgres://user:password@db-host:5432/opendialer"   -e OPEN_DIALER_ENCRYPTION_KEY="your-long-random-secret"   -e OPEN_DIALER_PUBLIC_URL="https://dialer.yourcompany.com"   open-dialer
```

Then put it behind HTTPS (your platform's proxy, Caddy or nginx). A server copy should always use PostgreSQL: the
built-in file storage lives inside the container and is lost when it's rebuilt.

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
