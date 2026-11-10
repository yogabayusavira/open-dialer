# Open Dialer v2

Open Dialer v2 is an original, single-workspace outbound-calling CRM. It brings lead intake, suppression, real two-leg Twilio calling, call outcomes, follow-ups, conversion, and a focused sales pipeline into one operator workspace.

## What is included

- Responsive calling queue, lead directory, follow-up queue, and activity log using clearly synthetic demo data.
- Persistent workspace state in PostgreSQL, including leads, opportunities, calls, activity, and the encrypted Twilio connection.
- CSV lead import, CSV call-history export, search, lead stages, and do-not-call suppression.
- Lead conversion that creates a Qualification-stage opportunity and a Pipeline workspace to move it through the sale.
- Twilio connection flow: validate an Account SID/Auth Token server-side, list voice-capable numbers already owned by that account, then encrypt the token with AES-256-GCM before storing it.
- Two-leg calling bridge: Open Dialer rings the saved operator number first, then Twilio connects the lead with the selected Twilio caller ID. Call outcomes immediately update the lead, follow-up queue, suppression list, activity, and exportable call history.

## Run locally

```bash
npm install
npm run build
npm start
```

Open `http://localhost:3000`.

For interface development, run `npm run dev` instead. When `DATABASE_URL` is set, Open Dialer v2 persists runtime data in PostgreSQL. Without it, local development falls back to `data/callboard.json`.

## Dokploy deployment

1. Create an Application from this repository and use the included `Dockerfile`.
2. Set the container port to `3000`.
3. Add `DATABASE_URL`, `CALLBOARD_ENCRYPTION_KEY`, `CALLBOARD_ADMIN_PASSWORD`, and `OPEN_DIALER_PUBLIC_URL` in Dokploy. The public URL must be the HTTPS domain Twilio can reach.
4. Add a domain and deploy. The application creates its `callboard_state` table automatically on its first request.

Before placing real calls, connect Twilio, save the operator phone number that should ring before each lead, and complete the relevant consent/compliance review for your territory. Open Dialer issues a short-lived signed TwiML bridge URL for each call; it does not expose your Twilio Auth Token to the browser.

## Security boundaries

- Never put a Twilio Auth Token in browser source, build-time environment variables, or Git.
- The validation request sends credentials only to Open Dialer v2's server; responses never include the token.
- Persisted tokens are AES-256-GCM encrypted using `CALLBOARD_ENCRYPTION_KEY`.
- Production access uses a single app password and rate-limited sign-in. Operators can opt into a signed 30-day browser cookie; changing the application password invalidates it. Add real identity and workspace authorization before multi-user use.
