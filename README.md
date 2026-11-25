# Open Dialer v2

Open Dialer v2 is an original, single-workspace outbound-calling CRM. It brings lead intake, suppression, real two-leg Twilio calling, call outcomes, follow-ups, conversion, and a focused sales pipeline into one operator workspace.

## What is included

- Responsive calling queue, lead directory, follow-up queue, and activity log using clearly synthetic demo data.
- Persistent workspace state in PostgreSQL, including leads, opportunities, calls, activity, and the encrypted Twilio connection.
- CSV lead import, CSV call-history export, search, lead stages, and do-not-call suppression.
- Lead conversion that creates a Qualification-stage opportunity and a Pipeline workspace to move it through the sale.
- Twilio connection flow: validate an Account SID/Auth Token server-side, list voice-capable numbers already owned by that account, then encrypt the token with AES-256-GCM before storing it.
- Two-leg calling bridge: Open Dialer v2 rings the saved operator number first, then Twilio connects the lead with the selected Twilio caller ID. Call outcomes immediately update the lead, follow-up queue, suppression list, activity, and exportable call history.

## Run locally

```bash
npm install
npm run local
```

Or double-click `Start Open Dialer.bat`. It builds the app, opens a Cloudflare tunnel so Twilio can reach your computer, starts the server and opens `http://localhost:3000`. The full guide, including what to install once and what to check when calls don't connect, is in [RUNNING-LOCALLY.md](RUNNING-LOCALLY.md).

For interface development, run `npm run dev` instead. When `DATABASE_URL` is set, Open Dialer v2 persists runtime data in PostgreSQL. Without it, local development falls back to `data/open-dialer.json`.

## Dokploy deployment

1. Create an Application from this repository and use the included `Dockerfile`.
2. Set the container port to `3000`.
3. Add `DATABASE_URL`, `OPEN_DIALER_ENCRYPTION_KEY` and `OPEN_DIALER_PUBLIC_URL` in Dokploy. The public URL must be the HTTPS domain Twilio can reach, and sign-in links in emails use it too. For invite and password-reset emails, also add `RESEND_API_KEY` and `RESEND_FROM_EMAIL`. Each company adds its own AI key (Groq or OpenRouter) in Settings, AI; `GROQ_API_KEY` or `OPENROUTER_API_KEY` here is the fallback. A hosted copy needs no tunnel.
4. Add a domain and deploy. The application creates its `open_dialer_state` table automatically on its first request.

Before placing real calls, connect Twilio, save the operator phone number that should ring before each lead, and complete the relevant consent/compliance review for your territory. Open Dialer v2 issues a short-lived signed TwiML bridge URL for each call; it does not expose your Twilio Auth Token to the browser.

## Security boundaries

- Never put a Twilio Auth Token in browser source, build-time environment variables, or Git.
- The validation request sends credentials only to Open Dialer v2's server; responses never include the token.
- Persisted tokens are AES-256-GCM encrypted using `OPEN_DIALER_ENCRYPTION_KEY`.
- Accounts are invite-only, with email and password sign-in (scrypt hashes, rate-limited). Each company has its own workspace; callers only see leads assigned to them. Changing a password signs out that account everywhere else.

## License

Open Dialer is © 2026 Yoga Bayu Savira, released under the [GNU AGPL-3.0](LICENSE) with the additional terms in
[NOTICE.md](NOTICE.md): keep the "Powered by Open Dialer · by Yoga Bayu Savira" credit visible, don't use the Open
Dialer name or logo for your own version, and share the source of any changed version you let others use.
White-label and commercial licenses: [COMMERCIAL.md](COMMERCIAL.md). Contributing: [CONTRIBUTING.md](CONTRIBUTING.md).
Contributors: [CONTRIBUTORS.md](CONTRIBUTORS.md).
