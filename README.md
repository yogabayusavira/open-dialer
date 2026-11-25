<div align="center">

<img src="public/logo.png" alt="Open Dialer" height="72">

**An outbound calling CRM you run yourself.**

[![Release](https://shieldcn.dev/github/release/yogabayusavira/open-dialer.svg?variant=branded&mode=dark&v=0.1.2)](https://github.com/yogabayusavira/open-dialer/releases/latest)
[![Installer build](https://shieldcn.dev/github/ci/yogabayusavira/open-dialer.svg?workflow=installer.yml&mode=dark)](https://github.com/yogabayusavira/open-dialer/actions/workflows/installer.yml)
[![License](https://shieldcn.dev/github/license/yogabayusavira/open-dialer.svg?mode=dark)](NOTICE.md)
<br>
[![Windows installer](https://shieldcn.dev/badge/Windows-installer-0078D6.svg?logo=windows&mode=dark)](https://github.com/yogabayusavira/open-dialer/releases/latest)
[![Node.js 22+](https://shieldcn.dev/badge/Node.js-22%2B-339933.svg?logo=nodedotjs&mode=dark)](https://nodejs.org)
[![PostgreSQL 17](https://shieldcn.dev/badge/PostgreSQL-17-4169E1.svg?logo=postgresql&mode=dark)](https://www.postgresql.org)
[![Twilio Voice](https://shieldcn.dev/badge/Twilio-Voice-F22F46.svg?logo=twilio&mode=dark)](https://www.twilio.com/voice)

[Download for Windows](https://github.com/yogabayusavira/open-dialer/releases/latest) · [Deploy on a server](#deploy-on-a-server) · [Install with an AI agent](#install-it-with-an-ai-agent)

</div>

Call leads from the browser through your own Twilio account, with call scripts, per-lead variables, voicemail drop,
follow-ups, a pipeline, analytics and n8n-style automations. Every feature that costs money shows its price in
Settings and can be switched off. Run it on your own computer or on a server.

## Features

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

## Screenshots

<p align="center"><img src="docs/screenshots/dialer.png" alt="The dialer: the lead's details, local time and opening hours, pinned fields and the call script" width="900"></p>
<p align="center"><sub>The dialer: who you're calling, their local time and opening hours, pinned details and the script.</sub></p>

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/automations.png" alt="An automation on the canvas: call outcome, send text, wait, follow up"><br><sub>Automations: a trigger, then steps like send text, wait and follow up.</sub></td>
    <td width="50%"><img src="docs/screenshots/pipeline.png" alt="The pipeline board with stages"><br><sub>Pipeline: drag leads between stages; deal values add up.</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/screenshots/leads.png" alt="The leads list"><br><sub>Leads: who to call next, follow-ups and the do-not-call list.</sub></td>
    <td width="50%"><img src="docs/screenshots/features-and-costs.png" alt="Settings, Features and costs"><br><sub>Features & costs: what each part costs, with a switch for paid extras.</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/screenshots/campaigns.png" alt="Campaign cards"><br><sub>Campaigns: each with its script, leads and settings.</sub></td>
    <td width="50%"><img src="docs/screenshots/dashboard.png" alt="The dashboard"><br><sub>Dashboard: today's calls, follow-ups and results.</sub></td>
  </tr>
</table>

<sub>Screenshots use made-up businesses and 555 numbers.</sub>

## What you need

| | What for | Get it |
|---|---|---|
| **Windows 10/11** (or macOS/Linux, see below) | Running the app | |
| **Node.js 22 or newer** | Runs the app | https://nodejs.org |
| **PostgreSQL 17** | The database for your leads, calls and settings | https://www.postgresql.org/download/ |
| **cloudflared** (not needed on a server) | A tunnel so Twilio can reach your computer | https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/ |
| **A Twilio account** with a voice-capable number | Placing calls | https://www.twilio.com/try-twilio |
| A **Resend** account and **your own domain** | Emails team invites and password resets, sent from your domain (you verify the domain in Resend) | https://resend.com |
| Optional: a **Groq** key | AI features | https://console.groq.com/keys |

Resend is how Open Dialer sends team invites and password resets. Verify your domain in Resend, create an API key, then
add the key and a sender on that domain in Settings → Integrations → Email right after you create your owner account.

The Windows setup wizard installs Node.js, PostgreSQL and cloudflared for you. What each part costs is listed in
[PRICES.md](PRICES.md) and in the app under Settings, Features & costs. The app itself is free.

## Install on Windows

1. Download **`OpenDialerSetup.exe`** from the [latest release](https://github.com/yogabayusavira/open-dialer/releases/latest).
2. Run it. Windows may say "Windows protected your PC" because the installer isn't code-signed yet: click
   **More info → Run anyway**.
3. The wizard shows what it will install (each with a link to read more) and asks where to install. Pick a drive with
   room: your database lives there too, in the `data\postgres` folder. It then installs what's missing (Windows asks
   for permission for Node.js and PostgreSQL), creates the `opendialer` database, runs `npm install` and writes
   `.env` with the database address and a freshly generated encryption key. You never edit `.env` by hand.
4. Leave **Start Open Dialer now** ticked and click Finish. Later, start it from the Start menu or desktop shortcut.
5. In the browser, **create your owner account** (the first visit asks for it), then go to **Settings → Phone
   numbers** and connect Twilio with your Account SID and Auth Token, and **Settings → Integrations → Email** to add
   your Resend key and sender.

Already have PostgreSQL? Setup asks for its admin password once to create Open Dialer's own database and user. Keep
the Open Dialer window open while you call. Uninstalling keeps your `data` folder and `.env`. More detail and
troubleshooting: [RUNNING-LOCALLY.md](RUNNING-LOCALLY.md).

## Install from a terminal (Windows, macOS, Linux)

Install Node.js 22+, PostgreSQL 17 and cloudflared (macOS:
`brew install node postgresql@17 cloudflared && brew services start postgresql@17`), then in the downloaded folder:

```bash
npm install
npm run setup             # creates the opendialer database and writes .env (on Windows it installs PostgreSQL if missing)
npm run local             # starts everything; open http://localhost:3000
```

Prefer PostgreSQL in Docker? Install Docker and run `npm run setup -- --docker` instead.

## Install it with an AI agent

Using Claude Code, Codex or another coding agent? Paste this:

> Install Open Dialer on this computer from https://github.com/yogabayusavira/open-dialer. Clone it into a folder I choose (ask me where; avoid the C: drive if
> it's low on space). Install anything missing: Node.js 22 or newer, PostgreSQL 17 and cloudflared. Run
> `npm install`, then `npm run setup`, which creates the `opendialer` database and writes `.env` with its address and
> new secrets (if PostgreSQL was already installed, it asks for the admin password: ask me for it, don't guess).
> Never print or share what's in `.env`. Then run `npm run local`, open http://localhost:3000, and tell me to create
> my owner account and connect Twilio in Settings → Phone numbers. If a step fails, show me the error and explain it
> before trying something else.

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

Then put it behind HTTPS (your platform's proxy, Caddy or nginx).

Before real calls, check consent and calling rules for where you call. Some US states also require consent for call
transcription.

## Security

- Twilio Auth Tokens and AI/email keys are encrypted (AES-256-GCM with `OPEN_DIALER_ENCRYPTION_KEY`) and never sent
  back to the browser. Keep `.env` private and never commit it.
- Accounts are invite-only after the first owner, with scrypt-hashed passwords and rate-limited sign-in. Each company
  has its own workspace; callers only see leads assigned to them.
- Back up your database regularly (on Windows installs, the `data\postgres` folder; or use `pg_dump`).

## License

Open Dialer is © 2026 Yoga Bayu Savira, released under the [GNU AGPL-3.0](LICENSE) with the additional terms in
[NOTICE.md](NOTICE.md): keep the "Powered by Open Dialer · by Yoga Bayu Savira" credit visible, don't use the Open
Dialer name or logo for your own version, and share the source of any changed version you let others use.
White-label and commercial licenses: [COMMERCIAL.md](COMMERCIAL.md). Contributing: [CONTRIBUTING.md](CONTRIBUTING.md).
Contributors: [CONTRIBUTORS.md](CONTRIBUTORS.md).
