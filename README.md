# Callboard

Callboard is an original, single-workspace outbound-calling CRM foundation. It focuses on a responsible lead workflow: choose the next lead, preserve context, and apply do-not-call protection. Calling-window checks and call outcomes are reserved for the Voice bridge phase.

## What is included

- Responsive calling queue, lead directory, follow-up queue, and activity log using clearly synthetic demo data.
- Persistent workspace state in PostgreSQL, including leads, activity, and the encrypted Twilio connection.
- Do-not-call suppression that blocks call preparation.
- Twilio connection flow: validate an Account SID/Auth Token server-side, list voice-capable numbers already owned by that account, then encrypt the token with AES-256-GCM before storing it.
- A secure call-preparation boundary. Outbound calling intentionally remains blocked until Twilio Voice webhooks and the browser Voice bridge are configured.

## Run locally

```bash
npm install
npm run build
npm start
```

Open `http://localhost:3000`.

For interface development, run `npm run dev` instead. When `DATABASE_URL` is set, Callboard persists runtime data in PostgreSQL. Without it, local development falls back to `data/callboard.json`.

## Dokploy deployment

1. Create an Application from this repository and use the included `Dockerfile`.
2. Set the container port to `3000`.
3. Add `DATABASE_URL`, `CALLBOARD_ENCRYPTION_KEY`, and `CALLBOARD_ADMIN_PASSWORD` in Dokploy. The production API refuses access without the application password, and refuses to save Twilio credentials without the encryption key.
4. Add a domain and deploy. The application creates its `callboard_state` table automatically on its first request.

Before enabling real calls, configure Twilio Voice/TwiML and status webhooks, verify every webhook signature, enforce calling-hour policies server-side, and complete the relevant consent/compliance review for your territory.

## Security boundaries

- Never put a Twilio Auth Token in browser source, build-time environment variables, or Git.
- The validation request sends credentials only to Callboard's server; responses never include the token.
- Persisted tokens are AES-256-GCM encrypted using `CALLBOARD_ENCRYPTION_KEY`.
- Production access uses a single app password, rate-limited sign-in, and a server-held 12-hour session. Add real identity and workspace authorization before multi-user use.
