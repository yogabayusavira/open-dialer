// Every price and free limit the app shows, in one place. Re-check them with PRICES.md (in the project folder) and
// move `checked` forward when you do; Settings → Features & costs warns when a check is over 90 days old.
export const prices = {
  twilioNumber: { name: "Twilio phone number", amount: 1.15, unit: "month", checked: "2026-11-25", source: "https://www.twilio.com/en-us/voice/pricing/us" },
  twilioCall: { name: "Calls to US and Canada numbers", amount: 0.014, unit: "min", checked: "2026-11-25", source: "https://www.twilio.com/en-us/voice/pricing/us" },
  twilioBrowser: { name: "Talking through this app (Browser/App calling)", amount: 0.004, unit: "min", checked: "2026-11-25", source: "https://www.twilio.com/en-us/voice/pricing/us" },
  twilioTranscription: { name: "Twilio live transcription", amount: 0.027, unit: "min", checked: "2026-11-25", source: "https://www.twilio.com/en-us/voice/pricing/us" },
  groq: { name: "Groq", free: "Free plan with rate limits; paid use costs fractions of a cent per call", checked: "2026-11-25", source: "https://groq.com/pricing" },
  resend: { name: "Resend", free: "Free plan: 100 emails a day; paid plans from about $20 a month", checked: "2026-11-25", source: "https://resend.com/pricing" },
} as const;

export const money = (amount: number) => (amount >= 1 || amount === 0 ? `$${amount.toFixed(2)}` : `$${amount.toFixed(3).replace(/0$/, "")}`);
