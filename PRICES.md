# Prices Open Dialer shows

Settings → Features & costs shows these prices next to each feature and uses them for the monthly estimate. They
live in `src/prices.ts`. Providers change prices and free limits, so re-check them every month or two.

| Item | In `src/prices.ts` | Price or free limit | Checked | Where to check |
|---|---|---|---|---|
| Twilio phone number (US local) | `twilioNumber` | $1.15 a month | 2026-11-25 | https://www.twilio.com/en-us/voice/pricing/us |
| Calls to US and Canada numbers | `twilioCall` | $0.014 a minute | 2026-11-25 | same page, "Make calls" |
| Talking through the app (Browser/App calling) | `twilioBrowser` | $0.004 a minute | 2026-11-25 | same page, "Browser/App Calling" |
| Twilio live transcription | `twilioTranscription` | $0.027 a minute | 2026-11-25 | same page, "Streaming (Real-Time) Transcription" |
| Twilio text message (US, Send text step) | `twilioSms` | about $0.0123 a text ($0.0083 + about $0.004 carrier fee); 10DLC registration $4.50 once + monthly campaign fee | 2026-11-26 | https://www.twilio.com/en-us/sms/pricing/us (carrier fees in the CSV there) |
| Groq (all AI features) | `groq` | Free plan with rate limits | 2026-11-25 | https://groq.com/pricing and https://console.groq.com/settings/limits |
| Resend (invites, password resets) | `resend` | Free plan: 100 emails a day | 2026-11-25 | https://resend.com/pricing |

Free in the app, no outside cost: voicemail drop (it plays during a call you're already paying for), booking links
(your own Calendly or Cal.com), automations.

## Re-check prompt

Paste this to Claude (or any coding agent) in this folder:

> Open each "Where to check" link in `PRICES.md`. For every row, compare the provider's current price or free limit
> with the table. Update the numbers and wording in `src/prices.ts` and in this table, set "Checked" to today's date
> for every row you looked at (even if nothing changed), and list what changed in your reply. If a free plan got
> smaller or a price went up, say so first. Don't guess: if a page doesn't show a number, leave it and say so.
> Then run `npx tsc --noEmit -p .` and commit as `chore: re-check provider prices`.
