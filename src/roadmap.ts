// What's planned for Open Dialer, shown in Settings → Roadmap. Edit this list as plans change; finished items come off.
// Sources: the owner's requests and the open to-dos in the workspace's CONTEXT.md (2026-11-28).
export type RoadmapItem = { title: string; detail: string; undecided?: boolean };
export const roadmap: { stage: string; note: string; items: RoadmapItem[] }[] = [
  {
    stage: "Next",
    note: "Small, clear, ready to build.",
    items: [
      { title: "Keep a note history", detail: "Each call's note is added to the lead's history instead of replacing the lead's note." },
      { title: "Choose the stage when logging a call", detail: "Today the outcome moves the lead to a stage on its own. Let the outcome dialog override it." },
      { title: "Set a follow-up date from the call card", detail: "Pick a date on the lead without having to log a call first." },
      { title: "Remove numbers from Do not call", detail: "A list of blocked numbers in Settings, with a way to take one off." },
    ],
  },
  {
    stage: "Unibox",
    note: "Every text and email with a lead, in one inbox.",
    items: [
      { title: "Texts in and out", detail: "Replies to your Twilio number land in one thread per lead; reply from there. STOP marks the lead Do not call. Needs no DNS." },
      { title: "Email replies", detail: "Needs a reply address: a free resend.app one, or your own subdomain with DNS records added in Resend.", undecided: true },
      { title: "\"Message received\" automations and AI", detail: "Start an automation when a lead replies; a one-line summary and interested / not interested / opt-out sorting per reply." },
      { title: "WhatsApp, then Facebook and Instagram", detail: "WhatsApp goes through Twilio like texts. Meta's messages need a Meta business app and approval." },
    ],
  },
  {
    stage: "Planned",
    note: "Agreed, not started.",
    items: [
      { title: "Several phone numbers per lead", detail: "A switchboard and a direct line on one lead; duplicates matched by more than the phone number." },
      { title: "Calling hours you set", detail: "Today a lead's hours are fixed at 8 AM to 9 PM their time." },
      { title: "Your own outcomes and stages", detail: "The outcome and pipeline stage lists are fixed today." },
      { title: "Won and Lost leads back in the queue", detail: "A way to call a closed lead again." },
      { title: "Short versions of long script facts", detail: "A short line per lead for a long {{fact}}, the way you'd say it on a call." },
    ],
  },
  {
    stage: "Later",
    note: "Ideas to come back to.",
    items: [
      { title: "Light-mode Dashboard banner", detail: "The banner stays dark in light mode for now.", undecided: true },
      { title: "Phone providers besides Twilio", detail: "SIP and other number providers." },
      { title: "Call volume leveler", detail: "Taken out because it silenced calls; rebuild it another way or drop it.", undecided: true },
    ],
  },
];
