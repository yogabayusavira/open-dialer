# Running Open Dialer on your computer

Open Dialer can run on your own computer instead of the hosted server. Calls still go through Twilio, and that's the one catch: when you press Call, Twilio has to reach the app over the internet to get the call instructions. A computer at home or in the office has no public address, so a free Cloudflare tunnel gives it one for as long as the app is running.

A hosted copy (Dokploy) doesn't need any of this. It has a permanent public address, set once in `OPEN_DIALER_PUBLIC_URL`.

## Start it

Double-click **`Start Open Dialer.bat`** in this folder. Or, in a terminal in this folder:

```
npm run local
```

It does everything in one go:

1. Builds the app.
2. Opens a Cloudflare tunnel and waits for its address, like `https://some-random-words.trycloudflare.com`.
3. Starts the app with that address, so calling works right away.
4. Opens http://localhost:3000 in your browser.

Keep the window open while you're calling. Closing it, or pressing Ctrl+C, stops both the app and the tunnel.

The tunnel gets a new address every time you start. That's fine: the app sends the new address to Twilio on your first call.

## What you need once

- **Node.js** (version 22 or newer) and the project's packages: run `npm install` in this folder once.
- **cloudflared**, Cloudflare's tunnel program. If it's missing, the start window says so. Install it with:

  ```
  winget install --id Cloudflare.cloudflared
  ```

- **A `.env` file** in this folder with at least `DATABASE_URL` and `OPEN_DIALER_ENCRYPTION_KEY`. Add `RESEND_API_KEY` and `RESEND_FROM_EMAIL` if you want invite and password-reset emails to send. Leave `OPEN_DIALER_PUBLIC_URL` out: the start script sets it to the tunnel each time.

## If calls don't connect

- **Is the start window still open?** If you closed it, or the computer slept or restarted, the tunnel is gone. Start again.
- **Did the window say the tunnel didn't start?** Check your internet connection and start again.
- **Does it ring and then fail with error 13224?** The number you're calling can't take voice calls. That's the number, not the app. In Twilio, give that number an incoming-call setting (Voice configuration) or call a different number.
- **Calls ring your phone or Zoiper first?** That's set under Settings, Phone numbers, "How will you take calls?". The tunnel is needed either way.

## Why not a fixed address?

A quick tunnel is free and needs no Cloudflare account, but its address changes on every start. If you want the same address every time, set up a named Cloudflare tunnel on your own domain, or use the hosted copy.
