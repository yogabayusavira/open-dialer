import { FormEvent, ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  BadgeCheck,
  CalendarClock,
  Check,
  ChevronRight,
  CircleAlert,
  ClipboardList,
  ExternalLink,
  FileUp,
  Filter,
  LoaderCircle,
  LockKeyhole,
  KeyRound,
  Mail,
  Building2,
  ChartColumn,
  LogOut,
  Phone,
  PhoneCall,
  Plus,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  UserPlus,
  Users,
  X,
  CalendarPlus,
  Grid3x3,
  Mic,
  MicOff,
  PhoneOff,
  PhoneOutgoing,
  MessageSquare,
  Clock,
  ListTodo,
  RotateCcw,
  Ban,
  UserRound,
  Tag,
  MoreHorizontal,
  ChevronDown,
  FileText,
  Trash2,
  Pause,
  Play,
  SkipForward,
} from "lucide-react";
import { Call, Device } from "@twilio/voice-sdk";
import "./styles.css";
import "./design-system.css";

type Lead = {
  id: string;
  name: string;
  company: string;
  role: string;
  phone: string;
  timezone: string;
  status: string;
  dnc: boolean;
  note: string;
  due: string;
  extension?: string;
  details?: Record<string, string>;
  campaigns?: string[];
  value?: number;
  taskDone?: { at: string; due: string };
  followUpSince?: string;
  followUpReason?: string;
  assignedTo?: string;
};
type Connection = {
  accountSid: string;
  selectedNumber: string;
  selectedNumberLabel: string;
  connectedAt: string;
  bridgeNumber?: string;
};
type CallRecord = {
  id: string;
  leadId: string;
  outcome: string;
  note: string;
  at: string;
  userId?: string;
};
type Task = { id: string; title: string; details?: string; due: string; leadId: string | null; createdAt: string; doneAt: string | null };
type TaskFields = { title: string; details: string; due: string; leadId: string | null };
type CampaignSettings = { script?: string; pdf?: { name: string; size: number; updatedAt: string } };
type State = {
  tasks?: Task[];
  campaignSettings?: Record<string, CampaignSettings>;
  leads: Lead[];
  activity: { id: string; at: string; action: string; detail: string }[];
  connection: Connection | null;
  calls: CallRecord[];
  dncNumbers: string[];
  callbackReachable?: boolean;
  settings?: { bookingUrl?: string };
  me: Member;
  workspace: { id: string; name: string };
  team: Member[];
  emailReady?: boolean;
  companies?: { id: string; name: string; people: Member[] }[];
};
type Member = { id: string; name: string; role: "owner" | "caller"; email?: string; pending?: boolean; admin?: boolean };
// What the server says after it makes a sign-in link: emailed, or the link to pass on yourself.
type LinkResult = { emailed?: boolean; link?: string; emailError?: string };
type NumberOption = { sid: string; number: string; label: string };
type Session = { authenticated: boolean };
type Screen = "queue" | "campaigns" | "calls" | "leads" | "followups" | "activity" | "pipeline" | "analytics" | "settings";
type SettingsArea = "calling" | "workspace" | "account";
type SettingsPage =
  | "numbers"
  | "team"
  | "fields"
  | "profile"
  | "privacy"
  | "booking"
  | "companies";

class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const nav = [
  { id: "dashboard", key: "queue", label: "Dashboard", icon: Activity },
  { id: "campaigns", key: "campaigns", label: "Campaigns", icon: Tag },
  { id: "leads", key: "leads", label: "Leads", icon: Users },
  { id: "calls", key: "calls", label: "Calls", icon: Phone },
  { id: "tasks", key: "followups", label: "Tasks", icon: CalendarClock },
  { id: "pipeline", key: "pipeline", label: "Pipeline", icon: SlidersHorizontal },
  { id: "analytics", key: "analytics", label: "Analytics", icon: ChartColumn },
  { id: "logs", key: "activity", label: "Logs", icon: ClipboardList },
] as const;

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    cache: "no-store",
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options?.headers || {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = body.error || "Something went wrong.";
    console.error(`[Open Dialer] ${options?.method || "GET"} ${path} failed (${response.status}): ${message}`);
    recentErrors.add(message);
    throw new ApiError(message, response.status);
  }
  return body;
}

let phoneDevice: Device | null = null;
let phoneTokenAt = 0;
let phoneAccount = "";
// The in-app phone (Twilio's browser softphone). Tokens last an hour; refresh after 50 minutes.
// A token belongs to one Twilio account, so switching accounts in Settings starts a fresh phone.
async function getPhone(accountSid: string) {
  if (phoneDevice && phoneAccount !== accountSid) {
    phoneDevice.destroy();
    phoneDevice = null;
  }
  if (phoneDevice && Date.now() - phoneTokenAt < 50 * 60_000) return phoneDevice;
  const { token } = await api<{ token: string }>("/api/twilio/token", { method: "POST" });
  if (phoneDevice) phoneDevice.updateToken(token);
  else {
    phoneDevice = new Device(token, { codecPreferences: [Call.Codec.Opus, Call.Codec.PCMU], closeProtection: "A call is in progress. Leave this page anyway?" });
    phoneDevice.on("error", (error) => console.error("[Open Dialer] phone error", error));
  }
  phoneTokenAt = Date.now();
  phoneAccount = accountSid;
  return phoneDevice;
}

function usesAppPhone(connection: Connection | null | undefined) {
  return !connection?.bridgeNumber || connection.bridgeNumber === "browser";
}

type ActiveCall = { lead: Lead; call: Call | null; status: "connecting" | "ringing" | "in-call"; muted: boolean; startedAt: number | null };

function loadScript(src: string) {
  return new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`);
    if (existing?.dataset.loaded) return resolve();
    const script = existing || document.createElement("script");
    script.addEventListener("load", () => { script.dataset.loaded = "1"; resolve(); });
    script.addEventListener("error", () => reject(new Error(`Couldn't load ${new URL(src).hostname}. Check your internet connection.`)));
    if (!existing) { script.src = src; script.async = true; document.head.appendChild(script); }
  });
}

// Opens Calendly's or Cal.com's own booking popup, using their official embed scripts and styling.
async function openBooking(url: string, name: string) {
  const host = new URL(url).hostname;
  if (/(^|\.)calendly\.com$/.test(host)) {
    if (!document.querySelector('link[href="https://assets.calendly.com/assets/external/widget.css"]')) {
      const css = document.createElement("link");
      css.rel = "stylesheet";
      css.href = "https://assets.calendly.com/assets/external/widget.css";
      document.head.appendChild(css);
    }
    await loadScript("https://assets.calendly.com/assets/external/widget.js");
    (window as unknown as { Calendly: { initPopupWidget: (options: object) => void } }).Calendly.initPopupWidget({ url, prefill: name ? { name } : {} });
    return;
  }
  // Cal.com's official embed loader (their published snippet), then their modal.
  const w = window as unknown as { Cal?: (...args: unknown[]) => void };
  if (!w.Cal) {
    /* eslint-disable */
    (function (C: any, A: string, L: string) { const p = function (a: any, ar: any) { a.q.push(ar); }; const d = C.document; C.Cal = C.Cal || function () { const cal = C.Cal; const ar = arguments; if (!cal.loaded) { cal.ns = {}; cal.q = cal.q || []; d.head.appendChild(d.createElement("script")).src = A; cal.loaded = true; } if (ar[0] === L) { const api: any = function () { p(api, arguments); }; const namespace = ar[1]; api.q = api.q || []; if (typeof namespace === "string") { cal.ns[namespace] = cal.ns[namespace] || api; p(cal.ns[namespace], ar); p(cal, ["initNamespace", namespace]); } else p(cal, ar); return; } p(cal, ar); }; })(window, "https://app.cal.com/embed/embed.js", "init");
    /* eslint-enable */
    w.Cal!("init", { origin: "https://cal.com" });
  }
  w.Cal!("modal", { calLink: new URL(url).pathname.replace(/^\/+/, ""), config: name ? { name } : {} });
}

const keypadKeys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"];
// Seconds between calls: enough to glance at the next lead's fact before it rings.
const autoDialSeconds = 5;

function AutoDialBar({ next, onPause, onSkip, onCallNow, onStop }: { next: { lead: Lead; seconds: number; paused: boolean }; onPause: () => void; onSkip: () => void; onCallNow: () => void; onStop: () => void }) {
  return (
    <div className="in-call-bar auto-dial-bar" role="region" aria-label="Next call">
      <span className="in-call-bar__dot" aria-hidden="true" />
      <div>
        <b>Next: {leadLabel(next.lead)}</b>
        <small>{next.paused ? "Paused" : `Calling in ${next.seconds}`} · {formatPhone(next.lead.phone, next.lead.extension)}</small>
      </div>
      <button type="button" className="quiet-button" onClick={onPause} aria-pressed={next.paused}>
        {next.paused ? <Play size={16} /> : <Pause size={16} />} {next.paused ? "Resume" : "Pause"}
      </button>
      <button type="button" className="quiet-button" onClick={onSkip}>
        <SkipForward size={16} /> Skip
      </button>
      <button type="button" className="primary-button" onClick={onCallNow}>
        <Phone size={16} /> Call now
      </button>
      <button type="button" className="icon-button" onClick={onStop} aria-label="Stop auto-dial">
        <X size={18} />
      </button>
    </div>
  );
}

function InCallBar({ active, onMute, onHangUp, onBook }: { active: ActiveCall; onMute: () => void; onHangUp: () => void; onBook: () => void }) {
  const [, setTick] = useState(0);
  const [keypadOpen, setKeypadOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const live = active.status === "in-call" && Boolean(active.call);
  // Sends a phone-menu tone ("press 1 for sales") into the call.
  const press = (key: string) => {
    if (!live) return;
    active.call!.sendDigits(key);
    setTyped((current) => (current + key).slice(-24));
  };
  // While the keypad is open, the keyboard's number keys, * and # press it too.
  useEffect(() => {
    if (!keypadOpen || !live) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (event.key === "Escape") return setKeypadOpen(false);
      if (keypadKeys.includes(event.key)) {
        event.preventDefault();
        press(event.key);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  useEffect(() => {
    const timer = window.setInterval(() => setTick((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const seconds = active.startedAt ? Math.floor((Date.now() - active.startedAt) / 1000) : 0;
  const status = active.status === "in-call" ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}` : active.status === "ringing" ? "Ringing…" : "Connecting…";
  return (
    <div className="in-call-bar" role="region" aria-label="Call in progress">
      <span className={`in-call-bar__dot${active.status === "in-call" ? " is-live" : ""}`} aria-hidden="true" />
      <div>
        <b>{leadLabel(active.lead)}</b>
        <small>{formatPhone(active.lead.phone, active.lead.extension)} · {status}</small>
      </div>
      <button type="button" className="quiet-button" onClick={onMute} disabled={active.status !== "in-call"} aria-pressed={active.muted}>
        {active.muted ? <MicOff size={16} /> : <Mic size={16} />} {active.muted ? "Unmute" : "Mute"}
      </button>
      <button type="button" className="quiet-button" onClick={() => setKeypadOpen((open) => !open)} disabled={!live} aria-expanded={keypadOpen}>
        <Grid3x3 size={16} /> Keypad
      </button>
      <button type="button" className="quiet-button" onClick={onBook}>
        <CalendarPlus size={16} /> Book a call
      </button>
      <button type="button" className="hang-up-button" onClick={onHangUp}>
        <PhoneOff size={16} /> Hang up
      </button>
      {keypadOpen && live && (
        <section className="in-call-keypad" aria-label="Keypad">
          <output aria-live="polite" className={typed ? undefined : "is-empty"}>{typed || "Press a key or type numbers"}</output>
          <div role="group" aria-label="Keys">
            {keypadKeys.map((key) => (
              <button type="button" key={key} onClick={() => press(key)}>{key}</button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

// Messages that came from a failed request; their toasts stay open until dismissed instead of closing on a timer.
const recentErrors = new Set<string>();

function Status({
  children,
  tone = "quiet",
}: {
  children: React.ReactNode;
  tone?: "quiet" | "good" | "alert";
}) {
  return <span className={`status status--${tone}`}>{children}</span>;
}

function localTime(timezone: string) {
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
      timeZone: timezone,
    }).format(new Date());
  } catch {
    return timezone.replace("America/", "").replace("_", " ");
  }
}

// Splits "540-586-1045 ext. 10257" into a dialable +1 number and an extension; unreadable input comes back unchanged with ok=false.
function normalizePhone(raw: string) {
  const match = raw.trim().match(/^(.*?)(?:[\s,;]*(?:ext\.?|extension|x|#)\s*(\d{1,10}))?$/i);
  const main = match?.[1] || raw;
  const extension = match?.[2] || "";
  const digits = main.replace(/\D/g, "");
  if (/^\D*\+/.test(main) && digits.length >= 8 && digits.length <= 15) return { phone: `+${digits}`, extension, ok: true };
  if (digits.length === 10) return { phone: `+1${digits}`, extension, ok: true };
  if (digits.length === 11 && digits[0] === "1") return { phone: `+${digits}`, extension, ok: true };
  return { phone: raw.trim(), extension: "", ok: false };
}

function formatPhone(phone: string, extension?: string) {
  const us = phone.replace(/[^\d+]/g, "").match(/^\+?1?(\d{3})(\d{3})(\d{4})$/);
  return `${us ? `(${us[1]}) ${us[2]}-${us[3]}` : phone}${extension ? ` ext. ${extension}` : ""}`;
}

function leadLabel(lead: Lead) {
  return lead.name || (lead.company && lead.company !== "Unassigned" ? lead.company : "") || lead.phone;
}

function leadSubtitle(lead: Lead) {
  const role = lead.role && lead.role !== "Contact" ? lead.role : "";
  if (lead.name) return [role, lead.company !== "Unassigned" ? lead.company : ""].filter(Boolean).join(" · ") || "No company";
  return role || "Main line · no contact name yet";
}

// The pipeline: a lead's status is its stage. Logging a call moves it forward; the board and the stage menu override.
const leadStages = ["New", "Follow-up", "Meeting booked", "Won", "Lost"] as const;

function campaignsOf(leads: Lead[]) {
  return [...new Set(leads.flatMap((lead) => lead.campaigns || []))].sort((left, right) => left.localeCompare(right));
}

function CampaignPicker({ campaigns, value, onChange }: { campaigns: string[]; value: string; onChange: (name: string) => void }) {
  if (!campaigns.length) return null;
  return (
    <label className="campaign-picker">
      <Tag size={16} aria-hidden="true" />
      <select value={value} onChange={(event) => onChange(event.target.value)} aria-label="Campaign">
        <option value="">All campaigns</option>
        {campaigns.map((name) => <option key={name}>{name}</option>)}
      </select>
    </label>
  );
}

// The lead's own note, ignoring the placeholder older imports wrote when a row had none.
function realNote(lead: Lead) {
  return lead.note === "Imported from CSV." ? "" : lead.note;
}

function inQueue(lead: Lead) {
  return !lead.dnc && !["Meeting booked", "Won", "Lost"].includes(lead.status);
}

// Called before: a call logged in the app, or an imported call history marking it "called".
// shortcut: reads the imported "Called" column by name (the district import); a campaign setting can replace it later.
function calledBefore(lead: Lead, calledIds: Set<string>) {
  return calledIds.has(lead.id) || /^called$/i.test(lead.details?.Called?.trim() || "");
}

// A dial that reached nobody. "In progress" counts too: a call that just ended may not have Twilio's result yet.
const missedOutcomes = ["Didn't connect", "No answer", "Busy", "Voicemail", "In progress"];
const reachedOutcomes = ["Interested", "Meeting booked", "Callback", "Maybe later", "Not interested", "Wrong number", "Do not call"];
const restAfterMisses = 3;
const restDays = 14;
type CallStat = { lastAt: string; misses: number; lastMissAt: string; reached: boolean };

// Per lead: when it was last called, and how many misses in a row since anyone last picked up.
function callStats(calls: CallRecord[]) {
  const stats = new Map<string, CallStat>();
  for (const call of calls) { // newest first
    const entry = stats.get(call.leadId) || { lastAt: call.at, misses: 0, lastMissAt: "", reached: false };
    if (!entry.reached) {
      if (reachedOutcomes.includes(call.outcome)) entry.reached = true;
      else if (missedOutcomes.includes(call.outcome)) { entry.misses += 1; entry.lastMissAt ||= call.at; }
    }
    stats.set(call.leadId, entry);
  }
  return stats;
}

// Three misses in a row: set the lead aside for two weeks so it isn't dialed every day, then it comes back.
function resting(entry: CallStat | undefined) {
  return Boolean(entry && entry.misses >= restAfterMisses && Date.now() - new Date(entry.lastMissAt).getTime() < restDays * 86_400_000);
}

// The calling order: leads never called first (in the order they were added), then retries, least recently called first.
function callQueue(leads: Lead[], calls: CallRecord[]) {
  const calledIds = new Set(calls.map((call) => call.leadId));
  const stats = callStats(calls);
  const queue = leads.filter((lead) => inQueue(lead) && !resting(stats.get(lead.id)));
  const lastAt = (lead: Lead) => stats.get(lead.id)?.lastAt || "";
  return [...queue.filter((lead) => !calledBefore(lead, calledIds)), ...queue.filter((lead) => calledBefore(lead, calledIds)).sort((left, right) => lastAt(left).localeCompare(lastAt(right)))];
}

function exportLeads(leads: Lead[], fileName: string) {
  const detailKeys = [...new Set(leads.flatMap((lead) => Object.keys(lead.details || {})))];
  const lines = [
    ["Name", "Company", "Role", "Phone", "Time zone", "Status", "Next step", "Do not call", "Note", ...detailKeys],
    ...leads.map((lead) => [lead.name, lead.company === "Unassigned" ? "" : lead.company, lead.role === "Contact" ? "" : lead.role, formatPhone(lead.phone, lead.extension), lead.timezone === "Unknown" ? "" : lead.timezone, lead.status, lead.due, lead.dnc ? "yes" : "no", lead.note, ...detailKeys.map((key) => lead.details?.[key] || "")]),
  ];
  const csv = lines.map((row) => row.map((item) => `"${String(item ?? "").replaceAll('"', '""')}"`).join(",")).join("\n");
  const href = URL.createObjectURL(new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(href);
}

// Sign in. Accounts are invite-only; "Forgot password" emails a reset link.
function Login({ onSignedIn }: { onSignedIn: () => void }) {
  const [mode, setMode] = useState<"signin" | "forgot">("signin");
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const fields = Object.fromEntries(new FormData(event.currentTarget));
    try {
      if (mode === "forgot") {
        setSent((await api<{ message: string }>("/api/password/forgot", { method: "POST", body: JSON.stringify(fields) })).message);
      } else {
        await api("/api/session", { method: "POST", body: JSON.stringify({ ...fields, remember }) });
        onSignedIn();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not sign in.");
    } finally {
      setBusy(false);
    }
  };
  const forgot = mode === "forgot";
  return (
    <main className="login-page">
      <form className="login-card" onSubmit={submit} key={mode}>
        <Brand />
        <h1>{forgot ? "Reset your password" : "Sign in"}</h1>
        <p>{forgot ? "Enter your email and we'll send you a link to choose a new password." : "Sign in with your email and password. New here? Ask your company's owner for an invite."}</p>
        <label>Email<input name="email" type="email" autoComplete="email" required /></label>
        {!forgot && (
          <>
            <label>Password<input name="password" type="password" autoComplete="current-password" required /></label>
            <label className="login-remember">
              <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
              <span>Keep me signed in for 30 days</span>
            </label>
          </>
        )}
        {error && <p className="form-error">{error}</p>}
        {sent && <p className="login-sent" role="status">{sent}</p>}
        <button className="primary-button" type="submit" disabled={busy || Boolean(sent)}>
          {busy ? <LoaderCircle className="spin" size={17} /> : forgot ? <Mail size={17} /> : <LockKeyhole size={17} />} {forgot ? "Send reset link" : "Sign in"}
        </button>
        <p className="login-switch">
          <button type="button" className="text-link" onClick={() => { setMode(forgot ? "signin" : "forgot"); setError(null); setSent(null); }}>{forgot ? "Back to sign in" : "Forgot your password?"}</button>
        </p>
      </form>
    </main>
  );
}

// Opened from an invite or reset email (#welcome/<token>): set a password and you're signed in.
function Welcome({ token, onDone }: { token: string; onDone: () => void }) {
  const [info, setInfo] = useState<{ name: string; email: string; kind: "invite" | "reset"; company: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<{ name: string; email: string; kind: "invite" | "reset"; company: string }>(`/api/welcome?token=${encodeURIComponent(token)}`).then(setInfo, (cause) => setError(cause instanceof Error ? cause.message : "This link doesn't work."));
  }, [token]);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/api/welcome", { method: "POST", body: JSON.stringify({ token, password: new FormData(event.currentTarget).get("password") }) });
      onDone();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't save your password.");
      setBusy(false);
    }
  };
  return (
    <main className="login-page">
      <form className="login-card" onSubmit={submit}>
        <Brand />
        <h1>{info?.kind === "reset" ? "Choose a new password" : info ? `Welcome, ${info.name}` : "Open Dialer"}</h1>
        {info && <p>{info.kind === "reset" ? `For ${info.email}.` : `You've been invited to ${info.company}. Set a password for ${info.email} to sign in.`}</p>}
        {!info && !error && <p><LoaderCircle className="spin" size={16} /> Checking your link…</p>}
        {info && (
          <label>
            New password
            <input name="password" type="password" autoComplete="new-password" minLength={10} required autoFocus />
            <small className="field-hint">At least 10 characters.</small>
          </label>
        )}
        {error && <p className="form-error">{error}</p>}
        {info && <button className="primary-button" type="submit" disabled={busy}>{busy ? <LoaderCircle className="spin" size={17} /> : <LockKeyhole size={17} />} {info.kind === "reset" ? "Save and sign in" : "Set password and sign in"}</button>}
        {error && !info && <p className="login-switch"><a className="text-link" href="#">Go to sign in</a></p>}
      </form>
    </main>
  );
}

// The current screen (and the open lead on the dashboard) lives in the address, e.g. #dashboard/lead_123,
// so reload, back/forward and bookmarks keep it.
const screenHashes: Record<Screen, string> = { queue: "dashboard", campaigns: "campaigns", leads: "leads", calls: "calls", followups: "tasks", activity: "activity", pipeline: "pipeline", analytics: "analytics", settings: "settings" };
// The logo is the owner's artwork; which color version shows is set in CSS by theme.
function Brand() {
  return (
    <div className="brand">
      <span className="brand-logo" role="img" aria-label="Open Dialer" />
    </div>
  );
}

function hashParts() {
  const [page = "", lead = ""] = window.location.hash.slice(1).split("/");
  return { page, lead: lead ? decodeURIComponent(lead) : null };
}
function screenFromHash(): Screen {
  return (Object.keys(screenHashes) as Screen[]).find((key) => screenHashes[key] === hashParts().page) || "leads";
}

function App() {
  const [screen, setScreen] = useState<Screen>(screenFromHash);
  const [selectedId, setSelectedId] = useState<string | null>(() => hashParts().lead);
  useEffect(() => {
    const hash = `#${screenHashes[screen]}${screen === "queue" && selectedId ? `/${encodeURIComponent(selectedId)}` : ""}`;
    if (window.location.hash === hash) return;
    // Switching leads replaces the entry so Back goes to the previous screen, not through every lead.
    if (window.location.hash && hashParts().page !== screenHashes[screen]) window.history.pushState(null, "", hash);
    else window.history.replaceState(null, "", hash);
  }, [screen, selectedId]);
  useEffect(() => {
    const onBack = () => {
      // An invite or reset link opened in a tab that already has the app.
      if (hashParts().page === "welcome") return setWelcomeToken(hashParts().lead);
      setScreen(screenFromHash());
      const lead = hashParts().lead;
      if (lead) setSelectedId(lead);
    };
    window.addEventListener("popstate", onBack);
    return () => window.removeEventListener("popstate", onBack);
  }, []);
  const [state, setState] = useState<State | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // A toast can carry one next step ("Start calling", "Import more leads"); it shows only with its own message.
  const [noticeAction, setNoticeAction] = useState<{ message: string; label: string; run: () => void } | null>(null);
  const notifyWith = (message: string, label: string, run: () => void) => {
    setNotice(message);
    setNoticeAction({ message, label, run });
  };
  // Which list a shortcut opens: the Leads bucket or the Calls tab. The sidebar resets both.
  const [leadsView, setLeadsView] = useState<"all" | "to-call" | "try-again" | "follow-up" | "closed">("all");
  const [callsView, setCallsView] = useState<"conversations" | "attempts" | "callbacks">("conversations");
  const [showLeadForm, setShowLeadForm] = useState(false);
  // "campaign" when opened from the Campaigns page, where the import must name a campaign.
  const [importOpen, setImportOpen] = useState<false | "leads" | "campaign">(false);
  const [dncOpen, setDncOpen] = useState(false);
  const [campaign, setCampaign] = useState(() => { try { return localStorage.getItem("open-dialer-campaign") || ""; } catch { return ""; } });
  useEffect(() => { try { localStorage.setItem("open-dialer-campaign", campaign); } catch { /* private mode: keep it for this visit only */ } }, [campaign]);
  const [outcomeLead, setOutcomeLead] = useState<Lead | null>(null);
  const [editLead, setEditLead] = useState<Lead | null>(null);
  const [guideOpen, setGuideOpen] = useState(false);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [welcomeToken, setWelcomeToken] = useState(() => (hashParts().page === "welcome" ? hashParts().lead : null));
  const [loadError, setLoadError] = useState<string | null>(null);
  const [lightMode, setLightMode] = useState(() => localStorage.getItem("open-dialer-theme") === "light");

  const refresh = async () => {
    try {
      const next = await api<State>("/api/state").catch((error) => {
        if (error instanceof ApiError && error.status === 401) setNeedsLogin(true);
        throw error;
      });
      if (!Array.isArray(next.leads) || !Array.isArray(next.activity)) {
        throw new Error("The Open Dialer v2 API is unavailable. Check that the service is running with node server.mjs.");
      }
      setState(next);
      setLoadError(null);
      setSelectedId((current) => current || next.leads[0]?.id || null);
      return next;
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : "Could not load the workspace.",
      );
      setLoadError(
        error instanceof Error
          ? error.message
          : "Could not load the workspace.",
      );
    }
  };
  useEffect(() => {
    void api<Session>("/api/session")
      .then((session) => {
        if (!session.authenticated) {
          setNeedsLogin(true);
          return;
        }
        void refresh();
      })
      .catch((error) =>
        setLoadError(
          error instanceof Error
            ? error.message
            : "Could not check the session.",
        ),
      );
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = lightMode ? "light" : "dark";
    localStorage.setItem("open-dialer-theme", lightMode ? "light" : "dark");
  }, [lightMode]);
  // Success toasts close themselves; error toasts stay until dismissed.
  useEffect(() => {
    if (!notice || recentErrors.has(notice)) return;
    const timer = window.setTimeout(() => setNotice(null), Math.min(15_000, 5_000 + notice.length * 60));
    return () => window.clearTimeout(timer);
  }, [notice]);
  // While a call from the last 15 minutes is still "In progress", re-check every 5s so Twilio's result shows up.
  const liveCall = state?.calls.some((call) => call.outcome === "In progress" && Date.now() - new Date(call.at).getTime() < 15 * 60_000);
  useEffect(() => {
    if (!liveCall) return;
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => window.clearInterval(timer);
  }, [liveCall]);
  const selected = useMemo(
    () =>
      state?.leads.find((lead) => lead.id === selectedId) || state?.leads[0],
    [state, selectedId],
  );
  // Tasks: every follow-up, plus meetings that have a date set, until they're checked off.
  const followUps =
    state?.leads.filter((lead) => !lead.dnc && !lead.taskDone && (lead.status === "Follow-up" || (lead.status === "Meeting booked" && /^\d{4}-\d{2}-\d{2}/.test(lead.due)))) || [];
  const todayLabel = new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric",
  }).format(new Date());

  const [activeCall, setActiveCall] = useState<ActiveCall | null>(null);
  // Auto-dial: after a missed call or a saved outcome, count down and call the next lead in the queue.
  const [autoNext, setAutoNext] = useState<{ lead: Lead; seconds: number; paused: boolean; skipped: string[] } | null>(null);
  const hungUpByMe = useRef(false);
  const nextInQueue = (fresh: State, exclude: string[]) => {
    const inCampaign = campaign && fresh.leads.some((lead) => lead.campaigns?.includes(campaign)) ? fresh.leads.filter((lead) => lead.campaigns?.includes(campaign)) : fresh.leads;
    return callQueue(inCampaign, fresh.calls).find((lead) => !exclude.includes(lead.id)) || null;
  };
  // Select the next lead and, when calls go through the app, start the countdown to it.
  const advanceFrom = (fresh: State | undefined, done: Lead, message: string) => {
    const next = fresh ? nextInQueue(fresh, [done.id]) : null;
    if (!next) return notifyWith(`${message} That was the last lead in the queue.`, "Import more leads", () => { setScreen("leads"); setImportOpen("leads"); });
    setSelectedId(next.id);
    setNotice(message);
    if (usesAppPhone(fresh?.connection)) setAutoNext({ lead: next, seconds: autoDialSeconds, paused: false, skipped: [done.id] });
  };
  const showError = (message: string) => {
    recentErrors.add(message);
    console.error(`[Open Dialer] ${message}`);
    setNotice(message);
  };
  const startAppCall = async (lead: Lead) => {
    if (activeCall) return;
    setAutoNext(null);
    hungUpByMe.current = false;
    setActiveCall({ lead, call: null, status: "connecting", muted: false, startedAt: null });
    try {
      const start = await api<{ callId: string; leadId: string; token: string; userId: string }>("/api/calls/browser-start", { method: "POST", body: JSON.stringify({ leadId: lead.id }) });
      const phone = await getPhone(state?.connection?.accountSid || "");
      const call = await phone.connect({ params: { leadId: start.leadId, callId: start.callId, token: start.token, userId: start.userId } });
      setActiveCall((current) => current && { ...current, call });
      const end = (message?: string, isError = false) => {
        setActiveCall(null);
        void refresh();
        if (message) (isError ? showError : setNotice)(message);
      };
      call.on("ringing", () => setActiveCall((current) => current && { ...current, status: "ringing" }));
      // accept fires only once the lead answers (answerOnBridge), so it marks a real conversation.
      let connected = false;
      call.on("accept", () => { connected = true; setActiveCall((current) => current && { ...current, status: "in-call", startedAt: Date.now() }); });
      call.on("disconnect", () => {
        if (connected) {
          end();
          return setOutcomeLead(lead);
        }
        setActiveCall(null);
        // Hanging up while it rings means "stop", so the dialer waits for you instead of moving on.
        if (hungUpByMe.current) return void refresh().then(() => setNotice("Stopped. Press Call when you're ready."));
        void refresh().then((fresh) => {
          const misses = (fresh && callStats(fresh.calls).get(lead.id)?.misses) || 1;
          advanceFrom(fresh, lead, `No answer from ${leadLabel(lead)} (${misses} ${misses === 1 ? "miss" : "misses"} in a row${misses >= restAfterMisses ? `, resting it for ${restDays} days` : ""}).`);
        });
      });
      call.on("cancel", () => end());
      call.on("error", (error: { message?: string; code?: number }) =>
        end(error.code === 31005 ? `The call to ${leadLabel(lead)} was ended by Twilio. The reason is on the call card ("Last attempt").` : `Call failed: ${error.message || "unknown error"}${error.code ? ` (Twilio ${error.code})` : ""}`, true));
      void refresh();
    } catch (error) {
      setActiveCall(null);
      const message = error instanceof Error ? error.message : String(error);
      showError(/permission|denied|notallowed|31401|31402/i.test(message)
        ? "Microphone access is blocked. Allow the microphone for this site (the icon in the address bar) and press Call again."
        : message || "Could not start the call.");
    }
  };
  useEffect(() => {
    if (!autoNext || autoNext.paused || activeCall) return;
    if (autoNext.seconds <= 0) {
      const lead = state?.leads.find((item) => item.id === autoNext.lead.id) || autoNext.lead;
      setAutoNext(null);
      void startAppCall(lead);
      return;
    }
    const timer = window.setTimeout(() => setAutoNext((current) => current && { ...current, seconds: current.seconds - 1 }), 1000);
    return () => window.clearTimeout(timer);
  }, [autoNext, activeCall]);
  const prepareCall = async (lead: Lead) => {
    if (usesAppPhone(state?.connection)) return startAppCall(lead);
    try {
      await api("/api/calls/start", {
        method: "POST",
        body: JSON.stringify({ leadId: lead.id }),
      });
      await refresh();
      setNotice(`Ringing ${state?.connection?.bridgeNumber?.startsWith("sip:") ? "Zoiper" : "your phone"} now. Answer it to connect with ${leadLabel(lead)}.`);
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : "Could not prepare the call.",
      );
    }
  };
  const setDnc = async (lead: Lead, dnc: boolean) => {
    try {
      await api(`/api/leads/${lead.id}`, {
        method: "PATCH",
        body: JSON.stringify({ dnc }),
      });
      await refresh();
      setNotice(
        dnc
          ? `${leadLabel(lead)} is now suppressed from calling.`
          : `${leadLabel(lead)} is active again.`,
      );
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : "Could not update the lead.",
      );
    }
  };
  const setStatus = async (lead: Lead, status: string) => {
    // Move the card right away; the refresh below confirms or corrects it.
    setState((current) => current && { ...current, leads: current.leads.map((item) => (item.id === lead.id ? { ...item, status } : item)) });
    try {
      await api(`/api/leads/${lead.id}`, { method: "PATCH", body: JSON.stringify({ status }) });
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not change the status.");
    }
  };
  const setTaskDone = async (lead: Lead, done: boolean) => {
    // Move the task across right away; the refresh confirms it.
    setState((current) => current && { ...current, leads: current.leads.map((item) => (item.id === lead.id ? { ...item, taskDone: done ? { at: new Date().toISOString(), due: item.due } : undefined } : item)) });
    try {
      await api(`/api/leads/${lead.id}/task`, { method: "POST", body: JSON.stringify({ done }) });
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not update the task.");
      await refresh();
    }
  };
  const [scriptFor, setScriptFor] = useState<string | null>(null);
  const [pdfFor, setPdfFor] = useState<string | null>(null);
  // The task dialog: "new" to add one, or the task being viewed and edited.
  const [taskDialog, setTaskDialog] = useState<{ task?: Task; leadId?: string } | null>(null);
  const saveTask = async (fields: TaskFields, task?: Task) => {
    await api(task ? `/api/tasks/${task.id}` : "/api/tasks", { method: task ? "PATCH" : "POST", body: JSON.stringify(fields) });
    setTaskDialog(null);
    await refresh();
    setNotice(task ? "Task updated." : "Task added.");
  };
  const changeTask = async (task: Task, change: { done: boolean } | "delete") => {
    // Update the list right away; the refresh confirms it.
    setState((current) => current && { ...current, tasks: change === "delete" ? (current.tasks || []).filter((item) => item.id !== task.id) : (current.tasks || []).map((item) => (item.id === task.id ? { ...item, doneAt: change.done ? new Date().toISOString() : null } : item)) });
    try {
      await api(`/api/tasks/${task.id}`, change === "delete" ? { method: "DELETE" } : { method: "PATCH", body: JSON.stringify(change) });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not update the task.");
    }
    await refresh();
  };
  const tagLeads = async (ids: string[], name: string) => {
    try {
      const result = await api<{ added: number; already: number }>("/api/leads/campaign", { method: "POST", body: JSON.stringify({ ids, campaign: name }) });
      await refresh();
      setNotice(`Added ${result.added} lead${result.added === 1 ? "" : "s"} to ${name.trim()}.${result.already ? ` ${result.already} ${result.already === 1 ? "was" : "were"} already in it.` : ""}`);
      return true;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not add those leads to the campaign.");
      return false;
    }
  };
  const assignLeads = async (ids: string[], userId: string) => {
    try {
      const result = await api<{ assigned: number }>("/api/leads/assign", { method: "POST", body: JSON.stringify({ ids, userId: userId || null }) });
      await refresh();
      const who = state?.team.find((member) => member.id === userId)?.name;
      setNotice(`${result.assigned} lead${result.assigned === 1 ? "" : "s"} ${who ? `assigned to ${who}` : "unassigned"}.`);
      return true;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not assign those leads.");
      return false;
    }
  };
  const signOut = async () => {
    await api("/api/session", { method: "DELETE" }).catch(() => {});
    setState(null);
    setNeedsLogin(true);
  };
  const deleteLeads = async (ids: string[]) => {
    try {
      const result = await api<{ deleted: number }>("/api/leads/delete", { method: "POST", body: JSON.stringify({ ids }) });
      if (selectedId && ids.includes(selectedId)) setSelectedId(null);
      await refresh();
      setNotice(`${result.deleted} lead${result.deleted === 1 ? "" : "s"} deleted.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not delete those leads.");
    }
  };
  if (welcomeToken)
    return (
      <Welcome
        token={welcomeToken}
        onDone={() => {
          window.history.replaceState(null, "", "#dashboard");
          setWelcomeToken(null);
          setNeedsLogin(false);
          setScreen("queue");
          void refresh();
        }}
      />
    );
  if (needsLogin)
    return (
      <Login
        onSignedIn={() => {
          setNeedsLogin(false);
          void refresh();
        }}
      />
    );
  if (!state && loadError)
    return (
      <main className="loading loading--error">
        <CircleAlert size={28} />
        <span>{loadError}</span>
        <button className="primary-button" onClick={() => void refresh()}>
          Try again
        </button>
      </main>
    );
  if (!state)
    // A grey outline of the real layout, so the page fills in rather than jumping from a blank screen.
    return (
      <main className="app-shell is-loading" aria-busy="true">
        <aside className="sidebar">
          <Brand />
          <div className="skeleton-nav">{Array.from({ length: 7 }, (_, index) => <i className="skeleton" key={index} />)}</div>
        </aside>
        <section className="workbench">
          <span className="sr-only">Loading</span>
          <div className="skeleton-page" aria-hidden="true">
            <i className="skeleton skeleton--title" />
            <div className="skeleton-card skeleton-card--banner"><i className="skeleton" /><i className="skeleton" /><i className="skeleton" /></div>
            <div className="skeleton-row">{Array.from({ length: 4 }, (_, index) => <div className="skeleton-card" key={index}><i className="skeleton" /><i className="skeleton" /></div>)}</div>
            <div className="skeleton-card skeleton-card--table">{Array.from({ length: 5 }, (_, index) => <i className="skeleton" key={index} />)}</div>
          </div>
        </section>
      </main>
    );
  const campaigns = campaignsOf(state.leads);
  const activeCampaign = campaigns.includes(campaign) ? campaign : "";
  // The campaign picker narrows the dashboard, leads list and board together.
  const scoped = activeCampaign
    ? (() => {
        const leads = state.leads.filter((lead) => lead.campaigns?.includes(activeCampaign));
        const ids = new Set(leads.map((lead) => lead.id));
        return { ...state, leads, calls: state.calls.filter((call) => ids.has(call.leadId)) };
      })()
    : state;
  const scopedSelected = scoped.leads.find((lead) => lead.id === selected?.id) || scoped.leads[0];
  const picker = <CampaignPicker campaigns={campaigns} value={activeCampaign} onChange={setCampaign} />;
  const startCampaign = (name: string) => {
    setCampaign(name);
    const first = callQueue(state.leads.filter((lead) => lead.campaigns?.includes(name)), state.calls)[0];
    if (first) setSelectedId(first.id);
    setScreen("queue");
  };
  return (
    <main className="app-shell">
      <aside className="sidebar">
        <Brand />
        <div className="workspace-label">Workspace</div>
        <nav aria-label="Workspace navigation">
          {nav.map(({ id, key, label, icon: Icon }) => (
            <button
              key={id}
              className={screen === key ? "nav-item nav-item--active" : "nav-item"}
              onClick={() => { setLeadsView("all"); setCallsView("conversations"); setScreen(key); }}
            >
              <Icon size={18} />
              <span>{label}</span>
              {id === "tasks" && followUps.length + (state.tasks || []).filter((task) => !task.doneAt).length > 0 && <b>{followUps.length + (state.tasks || []).filter((task) => !task.doneAt).length}</b>}
            </button>
          ))}
          {/* Placeholder for tools that come later; for now it opens the logs. */}
          <button className="nav-item" type="button" onClick={() => setScreen("activity")}>
            <MoreHorizontal size={18} />
            <span>More</span>
          </button>
        </nav>
        <div className="sidebar-footer">
          <button className="nav-item sidebar-utility" type="button" onClick={() => setLightMode((current) => !current)}>
            <ShieldCheck size={18} />
            <span>{lightMode ? "Dark mode" : "Light mode"}</span>
          </button>
          <button className="nav-item sidebar-utility" type="button" onClick={() => setScreen("settings")}>
            <SlidersHorizontal size={18} />
            <span>Settings</span>
          </button>
          <button className="account-summary" type="button" onClick={() => setScreen("settings")}>
            {/* Notion-style face, the same DiceBear "notionists" avatar Guramo uses; seeded with the random user id, nothing personal. */}
            <span className="account-summary__avatar"><img src={`https://api.dicebear.com/7.x/notionists/svg?seed=${encodeURIComponent(state.me.id)}`} alt="" /></span>
            <span>
              <b>{state.me.name}</b>
              <small>{state.workspace.name}</small>
            </span>
            <ChevronRight size={15} />
          </button>
        </div>
      </aside>
      <section className="workbench">
        {screen !== "queue" && <header className="topbar">
          <div>
            <p className="date-line">Workspace</p>
            <h1>
              {screen === "settings" ? "Settings" : nav.find((item) => item.key === screen)?.label}
            </h1>
            {screen === "leads" && (
              <p className="page-subtitle">
                Everyone you’re calling, with the next action easy to spot.
              </p>
            )}
          </div>
          <div className="top-actions">
            {(screen === "leads" || screen === "pipeline" || screen === "analytics") && picker}
            <button
              className="quick-tour-button"
              onClick={() => setGuideOpen(true)}
            >
              <BadgeCheck size={17} /> Setup guide
            </button>
            <button
              className="primary-button"
              onClick={() => (screen === "followups" ? setTaskDialog({}) : setShowLeadForm(true))}
            >
              <Plus size={18} /> {screen === "followups" ? "Add task" : "Add lead"}
            </button>
          </div>
        </header>}
        {activeCall && (
          <InCallBar
            active={activeCall}
            onMute={() => {
              if (!activeCall.call) return;
              activeCall.call.mute(!activeCall.muted);
              setActiveCall({ ...activeCall, muted: !activeCall.muted });
            }}
            onHangUp={() => {
              hungUpByMe.current = activeCall.status !== "in-call";
              if (activeCall.call) activeCall.call.disconnect();
              else setActiveCall(null);
            }}
            onBook={() => {
              const url = state.settings?.bookingUrl;
              if (!url) return showError("Add your Calendly or Cal.com link first: Settings → Workspace → Booking link.");
              openBooking(url, activeCall.lead.name).catch((error) => showError(error instanceof Error ? error.message : "Couldn't open the booking page."));
            }}
          />
        )}
        {!activeCall && autoNext && (
          <AutoDialBar
            next={autoNext}
            onPause={() => setAutoNext({ ...autoNext, paused: !autoNext.paused })}
            onSkip={() => {
              const skipped = [...autoNext.skipped, autoNext.lead.id];
              const next = nextInQueue(state, skipped);
              if (!next) { setAutoNext(null); return notifyWith("No more leads in the queue.", "Import more leads", () => { setScreen("leads"); setImportOpen("leads"); }); }
              setSelectedId(next.id);
              setAutoNext({ lead: next, seconds: autoDialSeconds, paused: autoNext.paused, skipped });
            }}
            onCallNow={() => setAutoNext({ ...autoNext, seconds: 0, paused: false })}
            onStop={() => setAutoNext(null)}
          />
        )}
        {notice && (
          <div className={`notice toast${recentErrors.has(notice) ? " is-error" : ""}`} role={recentErrors.has(notice) ? "alert" : "status"} aria-live="polite" key={notice}>
            <CircleAlert size={18} />
            <span>{notice}</span>
            {noticeAction?.message === notice && (
              <button type="button" className="toast-action" onClick={() => { noticeAction.run(); setNotice(null); }}>{noticeAction.label}</button>
            )}
            <button aria-label="Dismiss notice" onClick={() => setNotice(null)}>
              <X size={18} />
            </button>
          </div>
        )}
        {screen === "queue" && scopedSelected && (
          <Queue
            state={scoped}
            selected={scopedSelected}
            picker={picker}
            onSelect={setSelectedId}
            onPrepare={prepareCall}
            calling={Boolean(activeCall)}
            onRecord={(lead) => setOutcomeLead(lead)}
            onDnc={setDnc}
            onEdit={setEditLead}
            onStatus={setStatus}
            onSettings={() => setScreen("settings")}
            onAddLead={() => setShowLeadForm(true)}
            onGuide={() => setGuideOpen(true)}
            onAddTask={(lead) => setTaskDialog({ leadId: lead.id })}
            onOpenPdf={setPdfFor}
            onEditScript={setScriptFor}
            onGo={(target) => {
              if (target === "followups") return setScreen("followups");
              if (target === "to-call") { setLeadsView("to-call"); return setScreen("leads"); }
              setCallsView(target === "conversations" ? "conversations" : "attempts");
              setScreen("calls");
            }}
          />
        )}
        {screen === "queue" && !scopedSelected && (
          <section className="dash-empty" aria-label="No leads yet">
            <h1>No leads yet</h1>
            <p>Import a CSV of the people you want to call, or add one lead by hand. They show up here, ready to dial.</p>
            <div>
              <button type="button" className="primary-button" onClick={() => setImportOpen("leads")}><FileUp size={16} aria-hidden="true" /> Import a CSV</button>
              <button type="button" className="quiet-button" onClick={() => setShowLeadForm(true)}><Plus size={16} aria-hidden="true" /> Add a lead</button>
            </div>
          </section>
        )}
        {screen === "calls" && (
          <CallHistory
            key={callsView}
            calls={state.calls}
            leads={state.leads}
            initialView={callsView}
            onOpenLead={(id) => { setSelectedId(id); setScreen("queue"); }}
            onStartDialing={() => setScreen("leads")}
            onOpenDialer={() => {
              setSelectedId(state.leads.find((lead) => !lead.dnc)?.id || null);
              setScreen("queue");
            }}
            onOpenPhoneNumbers={() => setScreen("settings")}
            onUpgrade={() => setScreen("settings")}
          />
        )}
        {screen === "leads" && (
          <LeadList
            key={leadsView}
            leads={scoped.leads}
            calls={state.calls}
            onEdit={setEditLead}
            onDelete={deleteLeads}
            onTag={tagLeads}
            team={state.me.role === "owner" ? state.team : []}
            onAssign={assignLeads}
            campaigns={campaigns}
            initialSegment={leadsView}
            onCampaign={setCampaign}
            onStatus={setStatus}
            onOpen={(id) => {
              setSelectedId(id);
              setScreen("queue");
            }}
            onImport={() => setImportOpen("leads")}
            onDncList={() => setDncOpen(true)}
          />
        )}
        {screen === "followups" && (
          <FollowUps
            leads={followUps}
            allLeads={state.leads}
            calls={state.calls}
            tasks={state.tasks || []}
            onOpenTask={(task) => setTaskDialog({ task })}
            onQuickAdd={(fields) => saveTask(fields)}
            onChangeTask={changeTask}
            done={state.leads.filter((lead) => lead.taskDone).sort((left, right) => right.taskDone!.at.localeCompare(left.taskDone!.at)).slice(0, 12)}
            onToggle={setTaskDone}
            onSelect={(id) => {
              setSelectedId(id);
              setScreen("queue");
            }}
          />
        )}
        {screen === "activity" && <ActivityLog activity={state.activity} leads={state.leads} onOpenLead={(id) => { setSelectedId(id); setScreen("queue"); }} />}
        {screen === "pipeline" && (
          <Pipeline
            leads={scoped.leads}
            calls={state.calls}
            onMove={setStatus}
            onEdit={setEditLead}
            onAddTask={(lead) => setTaskDialog({ leadId: lead.id })}
            onCall={(id) => {
              setSelectedId(id);
              setScreen("queue");
            }}
          />
        )}
        {screen === "analytics" && <Analytics calls={scoped.calls} team={state.team} isOwner={state.me.role === "owner"} onOpenCalls={() => setScreen("calls")} />}
        {screen === "campaigns" && (
          <Campaigns
            leads={state.leads}
            onStart={startCampaign}
            onView={(name) => { setCampaign(name); setScreen("leads"); }}
            onStage={(name) => { setCampaign(name); setScreen("pipeline"); }}
            settings={state.campaignSettings || {}}
            onScript={setScriptFor}
            onImport={() => setImportOpen("campaign")}
          />
        )}
        {screen === "settings" && (
          <Settings
            me={state.me}
            workspace={state.workspace}
            team={state.team}
            emailReady={Boolean(state.emailReady)}
            companies={state.companies || []}
            onSignOut={signOut}
            connection={state.connection}
            bookingUrl={state.settings?.bookingUrl || ""}
            onRefresh={refresh}
            onNotice={setNotice}
          />
        )}
      </section>
      {scriptFor && (
        <ScriptDialog
          campaign={scriptFor}
          settings={state.campaignSettings?.[scriptFor] || {}}
          onViewPdf={() => setPdfFor(scriptFor)}
          onClose={() => setScriptFor(null)}
          onChanged={async (message, close) => { await refresh(); setNotice(message); if (close) setScriptFor(null); }}
        />
      )}
      {pdfFor && <PdfViewer campaign={pdfFor} name={state.campaignSettings?.[pdfFor]?.pdf?.name || "Script"} onClose={() => setPdfFor(null)} />}
      {taskDialog && (
        <TaskDialog
          task={taskDialog.task}
          leadId={taskDialog.leadId}
          leads={state.leads}
          onSave={saveTask}
          onDelete={(task) => { setTaskDialog(null); void changeTask(task, "delete"); }}
          onOpenLead={(id) => { setTaskDialog(null); setSelectedId(id); setScreen("queue"); }}
          onClose={() => setTaskDialog(null)}
        />
      )}
      {showLeadForm && (
        <LeadForm
          campaigns={campaigns}
          defaultCampaign={activeCampaign}
          onClose={() => setShowLeadForm(false)}
          onImport={() => {
            setShowLeadForm(false);
            setScreen("leads");
            setImportOpen("leads");
          }}
          onSaved={async () => {
            setShowLeadForm(false);
            await refresh();
            setNotice("Lead added to the route.");
          }}
        />
      )}
      {importOpen && <ImportLeads campaigns={campaigns} defaultCampaign={activeCampaign} requireCampaign={importOpen === "campaign"} onClose={() => setImportOpen(false)} onSaved={async (message, name) => { setImportOpen(false); await refresh(); notifyWith(message, "Start calling", () => { setCampaign(name); setScreen("queue"); }); }} />}
      {dncOpen && <DncList onClose={() => setDncOpen(false)} onSaved={async (message) => { setDncOpen(false); await refresh(); setNotice(message); }} />}
      {outcomeLead && <CallOutcome lead={outcomeLead} bookingUrl={state.settings?.bookingUrl || ""} onBook={() => openBooking(state.settings!.bookingUrl!, outcomeLead.name).catch((error) => showError(error instanceof Error ? error.message : "Couldn't open the booking page."))} onClose={() => setOutcomeLead(null)} onSaved={async (outcome) => {
        setOutcomeLead(null);
        advanceFrom(await refresh(), outcomeLead, `${outcome} saved for ${leadLabel(outcomeLead)}.`);
      }} />}
      {editLead && <LeadForm lead={editLead} campaigns={campaigns} onClose={() => setEditLead(null)} onSaved={async () => { setEditLead(null); await refresh(); setNotice("Lead updated."); }} onDeleted={async () => { const name = leadLabel(editLead); setEditLead(null); if (selectedId === editLead.id) setSelectedId(null); await refresh(); setNotice(`${name} deleted.`); }} />}
      {guideOpen && (
        <SetupGuide
          state={state}
          onClose={() => setGuideOpen(false)}
          onGo={(target) => {
            setGuideOpen(false);
            setScreen(target);
          }}
        />
      )}
    </main>
  );
}

function CallHistory({
  calls,
  leads,
  onStartDialing,
  onOpenDialer,
  onOpenPhoneNumbers,
  onUpgrade,
  initialView,
  onOpenLead,
}: {
  calls: CallRecord[];
  leads: Lead[];
  onStartDialing: () => void;
  onOpenDialer: () => void;
  onOpenPhoneNumbers: () => void;
  onUpgrade: () => void;
  initialView: "conversations" | "attempts" | "callbacks";
  onOpenLead: (id: string) => void;
}) {
  const [view, setView] = useState(initialView);
  const [query, setQuery] = useState("");
  const [range, setRange] = useState("Last 30 days");
  const [outcome, setOutcome] = useState("All outcomes");
  const isCallbacks = view === "callbacks";
  const cutoff = range === "All time" ? 0 : Date.now() - ({ "Last 7 days": 7, "Last 30 days": 30, "Last 90 days": 90 }[range] || 30) * 86_400_000;
  const entries = calls
    .map((call) => ({ ...call, lead: leads.find((lead) => lead.id === call.leadId) }))
    .filter((call) => call.lead && new Date(call.at).getTime() >= cutoff)
    .filter((call) => view === "callbacks" ? call.outcome === "Callback" : view === "conversations" ? ["Interested", "Meeting booked", "Callback", "Maybe later", "Not interested"].includes(call.outcome) : true)
    .filter((call) => outcome === "All outcomes" || call.outcome === outcome)
    .filter((call) => [call.lead?.name, call.lead?.company, call.lead?.phone, call.outcome, call.note].join(" ").toLowerCase().includes(query.toLowerCase()));
  const exportCalls = () => {
    const lines = [["Date", "Lead", "Company", "Phone", "Outcome", "Note"], ...entries.map((call) => [new Date(call.at).toLocaleString(), call.lead ? leadLabel(call.lead) : "", call.lead?.company || "", call.lead ? formatPhone(call.lead.phone, call.lead.extension) : "", call.outcome, call.note])];
    const csv = lines.map((row) => row.map((item) => `"${String(item).replaceAll('"', '""')}"`).join(",")).join("\n");
    const href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = "open-dialer-calls.csv";
    anchor.click();
    URL.revokeObjectURL(href);
  };
  const subtitle = view === "conversations" ? `${entries.length} recorded conversations` : view === "attempts" ? `${entries.length} recorded call attempts` : `${entries.length} callbacks`;

  return (
    <section className="calls-page" aria-label="Calls">
      <header className="calls-page__header">
        <p className="calls-page__summary">{subtitle}</p>
        <div className="calls-page__actions">
          <button className="calls-outline-button" onClick={onOpenDialer}>
            <Phone size={15} /> Phone dialer
          </button>
          <button className="calls-export-button" onClick={exportCalls} disabled={!entries.length}>
            Export
          </button>
        </div>
      </header>

      <div className="calls-limit" aria-label="Call history status">
        <strong>{calls.length} calls recorded</strong>
        <span>Every outcome is retained in this workspace and can be exported.</span>
        <button type="button" onClick={onUpgrade}>Manage calling settings →</button>
      </div>

      <div className="calls-tabs" role="tablist" aria-label="Call history view">
        <button
          className={view === "conversations" ? "is-active" : ""}
          aria-selected={view === "conversations"}
          onClick={() => setView("conversations")}
        >
          Conversations
        </button>
        <button
          className={view === "attempts" ? "is-active" : ""}
          aria-selected={view === "attempts"}
          onClick={() => setView("attempts")}
        >
          All attempts
        </button>
        <button
          className={view === "callbacks" ? "is-active" : ""}
          aria-selected={view === "callbacks"}
          onClick={() => setView("callbacks")}
        >
          Callbacks
        </button>
      </div>

      {!isCallbacks && (
        <div className="calls-filters">
          <label className="calls-search">
            <Search size={17} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search"
              aria-label="Search calls"
            />
          </label>
          <label className="calls-select">
            <select value={range} onChange={(event) => setRange(event.target.value)} aria-label="Date range">
              <option>Last 7 days</option>
              <option>Last 30 days</option>
              <option>Last 90 days</option>
              <option>All time</option>
            </select>
          </label>
          <label className="calls-select">
            <select value={outcome} onChange={(event) => setOutcome(event.target.value)} aria-label="Call outcome">
              <option>All outcomes</option>
              <option>Interested</option>
              <option>Callback</option>
              <option>No answer</option>
              <option>Do not call</option>
              <option>Didn't connect</option>
              <option>Call ended</option>
            </select>
          </label>
        </div>
      )}

      {!entries.length ? <div className="calls-empty"><p>{isCallbacks ? "No callbacks are recorded yet." : "No calls match this view."}</p><span><button type="button" onClick={onStartDialing}>Open leads →</button> or <button type="button" onClick={onOpenPhoneNumbers}>review phone settings →</button></span></div> : <div className="call-history-list">{entries.map((call) => <article key={call.id}><div><button type="button" className="text-link" onClick={() => call.lead && onOpenLead(call.lead.id)}><b>{call.lead && leadLabel(call.lead)}</b></button><small>{call.lead?.company} · {call.lead && formatPhone(call.lead.phone, call.lead.extension)}</small></div><Status tone={call.outcome === "Do not call" || call.outcome === "Didn't connect" ? "alert" : call.outcome === "In progress" || call.outcome === "Call ended" ? "quiet" : "good"}>{call.outcome}</Status><div><small>{dueLabel(call.at).text}</small>{call.note && <p>{call.note}</p>}</div></article>)}</div>}
    </section>
  );
}

// Sorts imported columns into call-card sections by label and content, so any CSV gets a sensible layout.
function groupDetails(details: Lead["details"]) {
  const groups = { quick: [] as [string, string][], say: [] as [string, string][], research: [] as [string, string][], sources: [] as [string, string][] };
  for (const entry of Object.entries(details || {})) {
    const [label, value] = entry;
    // Talking points: what gets said on the call, e.g. "Current fact to use" is the opening line's hook.
    if (/opener|script|pitch|talk|question|objection|fact/i.test(label)) groups.say.push(entry);
    else if (/^https?:\/\//i.test(value) || /source|url|website|link|recorded|observed|evidence|touch|\bids?\b/i.test(label)) groups.sources.push(entry);
    else if (value.length <= 32) groups.quick.push(entry);
    else groups.research.push(entry);
  }
  return groups;
}

function DetailValue({ value }: { value: string }) {
  if (/^https?:\/\/\S+$/i.test(value)) {
    let label = value;
    try {
      const url = new URL(value);
      label = url.hostname.replace(/^www\./, "") + (url.pathname.length > 1 ? url.pathname : "");
    } catch {}
    return <a href={value} target="_blank" rel="noreferrer">{label} <ExternalLink size={12} aria-hidden="true" /></a>;
  }
  const items = value.split(/;\s*/).filter(Boolean);
  if (items.length > 3) return <details className="detail-list"><summary>{items.slice(0, 2).join("; ")} +{items.length - 2} more</summary>{items.slice(2).join("; ")}</details>;
  return <>{value}</>;
}

// One primary time zone per US state; good enough for a calling-hours check when a lead has no time zone.
const stateZones: [string, string, string][] = [
  ["AL", "Alabama", "America/Chicago"], ["AK", "Alaska", "America/Anchorage"], ["AZ", "Arizona", "America/Phoenix"], ["AR", "Arkansas", "America/Chicago"],
  ["CA", "California", "America/Los_Angeles"], ["CO", "Colorado", "America/Denver"], ["CT", "Connecticut", "America/New_York"], ["DE", "Delaware", "America/New_York"],
  ["DC", "District of Columbia", "America/New_York"], ["FL", "Florida", "America/New_York"], ["GA", "Georgia", "America/New_York"], ["HI", "Hawaii", "Pacific/Honolulu"],
  ["ID", "Idaho", "America/Boise"], ["IL", "Illinois", "America/Chicago"], ["IN", "Indiana", "America/Indiana/Indianapolis"], ["IA", "Iowa", "America/Chicago"],
  ["KS", "Kansas", "America/Chicago"], ["KY", "Kentucky", "America/New_York"], ["LA", "Louisiana", "America/Chicago"], ["ME", "Maine", "America/New_York"],
  ["MD", "Maryland", "America/New_York"], ["MA", "Massachusetts", "America/New_York"], ["MI", "Michigan", "America/Detroit"], ["MN", "Minnesota", "America/Chicago"],
  ["MS", "Mississippi", "America/Chicago"], ["MO", "Missouri", "America/Chicago"], ["MT", "Montana", "America/Denver"], ["NE", "Nebraska", "America/Chicago"],
  ["NV", "Nevada", "America/Los_Angeles"], ["NH", "New Hampshire", "America/New_York"], ["NJ", "New Jersey", "America/New_York"], ["NM", "New Mexico", "America/Denver"],
  ["NY", "New York", "America/New_York"], ["NC", "North Carolina", "America/New_York"], ["ND", "North Dakota", "America/Chicago"], ["OH", "Ohio", "America/New_York"],
  ["OK", "Oklahoma", "America/Chicago"], ["OR", "Oregon", "America/Los_Angeles"], ["PA", "Pennsylvania", "America/New_York"], ["RI", "Rhode Island", "America/New_York"],
  ["SC", "South Carolina", "America/New_York"], ["SD", "South Dakota", "America/Chicago"], ["TN", "Tennessee", "America/Chicago"], ["TX", "Texas", "America/Chicago"],
  ["UT", "Utah", "America/Denver"], ["VT", "Vermont", "America/New_York"], ["VA", "Virginia", "America/New_York"], ["WA", "Washington", "America/Los_Angeles"],
  ["WV", "West Virginia", "America/New_York"], ["WI", "Wisconsin", "America/Chicago"], ["WY", "Wyoming", "America/Denver"],
];

// A real time zone name like "America/New_York", as opposed to a state typed into the time zone field.
function isTimeZone(value: string | undefined) {
  if (!value || value === "Unknown") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

// A lead's US state, as a code or a name: from its "State" detail (what the import's State / province column saves),
// or from the time zone field when a state was put there (older imports mapped the state column to Time zone).
function leadState(lead: Lead) {
  const detail = Object.entries(lead.details || {}).find(([key]) => /^(state|st|state\/province|province)$/i.test(key.trim()))?.[1];
  const find = (value: string | undefined) => {
    const text = value?.trim().toLowerCase();
    return (text && stateZones.find(([code, name]) => code.toLowerCase() === text || name.toLowerCase() === text)) || null;
  };
  return find(detail) || find(lead.timezone);
}

function leadStateCode(lead: Lead) {
  return leadState(lead)?.[0] || null;
}

// Tile grid of the US: one square per state, [code, column, row].
const stateTiles: [string, number, number][] = [
  ["AK", 0, 0], ["ME", 10, 0],
  ["WI", 5, 1], ["VT", 9, 1], ["NH", 10, 1],
  ["WA", 0, 2], ["ID", 1, 2], ["MT", 2, 2], ["ND", 3, 2], ["MN", 4, 2], ["IL", 5, 2], ["MI", 6, 2], ["NY", 8, 2], ["MA", 9, 2],
  ["OR", 0, 3], ["NV", 1, 3], ["WY", 2, 3], ["SD", 3, 3], ["IA", 4, 3], ["IN", 5, 3], ["OH", 6, 3], ["PA", 7, 3], ["NJ", 8, 3], ["CT", 9, 3], ["RI", 10, 3],
  ["CA", 0, 4], ["UT", 1, 4], ["CO", 2, 4], ["NE", 3, 4], ["MO", 4, 4], ["KY", 5, 4], ["WV", 6, 4], ["VA", 7, 4], ["MD", 8, 4], ["DE", 9, 4],
  ["AZ", 1, 5], ["NM", 2, 5], ["KS", 3, 5], ["AR", 4, 5], ["TN", 5, 5], ["NC", 6, 5], ["SC", 7, 5], ["DC", 8, 5],
  ["OK", 3, 6], ["LA", 4, 6], ["MS", 5, 6], ["AL", 6, 6], ["GA", 7, 6],
  ["HI", 0, 7], ["TX", 3, 7], ["FL", 8, 7],
];

function StateTileMap({ leads, current, zone }: { leads: Lead[]; current: string | null; zone: string | null }) {
  const counts = new Map<string, number>();
  for (const lead of leads) { const code = leadStateCode(lead); if (code) counts.set(code, (counts.get(code) || 0) + 1); }
  const size = 22, gap = 3;
  return (
    <svg className="state-map" viewBox={`0 0 ${11 * (size + gap) - gap} ${8 * (size + gap) - gap}`} role="img" aria-label={`Leads by state${current ? `, current lead in ${current}` : ""}`}>
      {stateTiles.map(([code, col, row]) => {
        const count = counts.get(code) || 0;
        return (
          <g key={code} className={[code === current && "is-current", zone && stateZones.find(([c]) => c === code)?.[2] === zone && "in-zone", count && "has-leads"].filter(Boolean).join(" ")}>
            <title>{`${code}: ${count} lead${count === 1 ? "" : "s"}`}</title>
            <rect x={col * (size + gap)} y={row * (size + gap)} width={size} height={size} rx={4} />
          </g>
        );
      })}
    </svg>
  );
}

// 24-hour strip in the lead's time zone: the calling window (8 AM to 9 PM) shaded, a sun at their current time.
function DaylightStrip({ hour, minute }: { hour: number | null; minute: number }) {
  const at = (h: number) => `${(h / 24) * 100}%`;
  return (
    <div className="daylight" aria-hidden="true">
      <div className="daylight__bar">
        <span className="daylight__window" style={{ left: at(8), width: at(13) }} />
        {hour !== null && <span className={`daylight__sun${hour >= 8 && hour < 21 ? "" : " is-night"}`} style={{ left: at(hour + minute / 60) }} />}
      </div>
      <div className="daylight__ticks"><span>12 AM</span><span style={{ left: at(8) }}>8 AM</span><span style={{ left: at(12) }}>Noon</span><span style={{ left: at(21) }}>9 PM</span></div>
    </div>
  );
}

function leadZone(lead: Lead): { zone: string; place: string } | null {
  // A time zone set by hand wins; otherwise the state decides.
  if (isTimeZone(lead.timezone)) return { zone: lead.timezone, place: lead.timezone.split("/").pop()!.replace(/_/g, " ") };
  const match = leadState(lead);
  return match ? { zone: match[2], place: match[1] } : null;
}

function zoneClock(zone: string, now: Date) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
    const hour = Number(parts.find((part) => part.type === "hour")?.value);
    const minute = Number(parts.find((part) => part.type === "minute")?.value);
    return { label: new Intl.DateTimeFormat(undefined, { timeZone: zone, hour: "numeric", minute: "2-digit" }).format(now), hour, minute };
  } catch {
    return null;
  }
}

const conversationOutcomes = ["Interested", "Meeting booked", "Callback", "Maybe later", "Not interested"];

// Calling hours are 8 AM to 9 PM in the lead's own time.
function hoursNote(clock: { hour: number; minute: number }) {
  if (clock.hour >= 8 && clock.hour < 21) {
    const left = 21 * 60 - (clock.hour * 60 + clock.minute);
    return { open: true, text: left <= 90 ? `open ${left} more min` : "open until 9 PM" };
  }
  const until = ((8 * 60 - (clock.hour * 60 + clock.minute)) + 24 * 60) % (24 * 60);
  return { open: false, text: until < 60 ? `opens in ${until} min` : `opens in ${Math.round(until / 60)} h` };
}
// "America/New_York" → "Eastern"; cached because the banner re-renders every 30 seconds.
const zoneNames = new Map<string, string>();
function zoneName(zone: string) {
  if (!zoneNames.has(zone)) {
    let name = zone.split("/").pop()!.replace(/_/g, " ");
    try {
      name = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longGeneric" }).formatToParts(new Date()).find((part) => part.type === "timeZoneName")?.value.replace(/( Standard)? Time$/, "") || name;
    } catch { /* unknown zone: keep the city name */ }
    zoneNames.set(zone, name);
  }
  return zoneNames.get(zone)!;
}
// One clock per time zone that has leads still to work, biggest first, plus your own time.
function ZoneClocks({ leads, current, now }: { leads: Lead[]; current: string | null; now: Date }) {
  const zones = new Map<string, { zone: string; count: number }>();
  for (const lead of leads) {
    if (lead.dnc || ["Won", "Lost"].includes(lead.status)) continue;
    const found = leadZone(lead);
    if (!found) continue;
    const name = zoneName(found.zone);
    const entry = zones.get(name) || { zone: found.zone, count: 0 };
    entry.count += 1;
    zones.set(name, entry);
  }
  const rows = [...zones].sort((left, right) => right[1].count - left[1].count);
  const shown = rows.slice(0, 4);
  const currentName = current ? zoneName(current) : null;
  return (
    <ul className="zone-clocks" aria-label="Local times where your leads are">
      {shown.map(([name, { zone, count }]) => {
        const clock = zoneClock(zone, now);
        if (!clock) return null;
        const note = hoursNote(clock);
        return (
          <li key={name} className={`${note.open ? "is-open" : ""}${name === currentName ? " is-current" : ""}`} title={`${count} lead${count === 1 ? "" : "s"} in ${name} time`}>
            <i aria-hidden="true" />{name} <b>{clock.label}</b> <span>{note.text}</span>
          </li>
        );
      })}
      {rows.length > shown.length && <li title={rows.slice(shown.length).map(([name]) => name).join(", ")}>+{rows.length - shown.length} more</li>}
    </ul>
  );
}

// A dial leaves one or two records (Twilio's, plus the outcome you log); records for the same lead within
// two minutes are one call. A call counts as a conversation if any of its records is one.
function callAttempts(calls: CallRecord[]) {
  const attempts: { leadId: string; at: string; conversation: boolean }[] = [];
  const last = new Map<string, { at: number; index: number }>();
  for (const call of [...calls].sort((left, right) => left.at.localeCompare(right.at))) {
    const at = new Date(call.at).getTime();
    const previous = last.get(call.leadId);
    if (previous && at - previous.at <= 120_000) {
      if (conversationOutcomes.includes(call.outcome)) attempts[previous.index].conversation = true;
      last.set(call.leadId, { at, index: previous.index });
      continue;
    }
    attempts.push({ leadId: call.leadId, at: call.at, conversation: conversationOutcomes.includes(call.outcome) });
    last.set(call.leadId, { at, index: attempts.length - 1 });
  }
  return attempts;
}

// Where a lead in Follow-up stands: which follow-up is next (1 to 3) and why it's being followed up.
const followUpLimit = 3;
function followUpInfo(lead: Lead, calls: CallRecord[]) {
  if (lead.status !== "Follow-up" || lead.dnc) return null;
  const since = lead.followUpSince || "";
  const done = callAttempts(calls.filter((call) => call.leadId === lead.id && call.at > since)).length;
  return { done, step: Math.min(done + 1, followUpLimit), exhausted: done >= followUpLimit, reason: lead.followUpReason || "" };
}

// A row of dots before a short status line: filled dots carry the color, empty ones show what's left.
function Dots({ tones }: { tones: string[] }) {
  return <span className="dots" aria-hidden="true">{tones.map((tone, index) => <i key={index} className={`dot dot--${tone}`} />)}</span>;
}

function FollowUpTag({ lead, calls }: { lead: Lead; calls: CallRecord[] }) {
  const info = followUpInfo(lead, calls);
  if (!info) return null;
  const tones = info.exhausted ? ["done", "done", "done"] : [1, 2, 3].map((step) => (step <= info.step ? `fu${step}` : "empty"));
  return (
    <span className="stage-line">
      <Dots tones={tones} />
      {info.exhausted ? `${followUpLimit} follow-ups, no reply` : `Follow-up ${info.step} of ${followUpLimit}`}
      {info.reason && <em>{info.reason}</em>}
    </span>
  );
}

// What a pipeline card's dot line says for each stage. Follow-up uses FollowUpTag.
const lostOutcomes = ["Not interested", "Wrong number", "Do not call"];
function lostReason(lead: Lead, calls: CallRecord[]) {
  if (lead.dnc) return "Do not call";
  if (lead.followUpSince && callAttempts(calls.filter((call) => call.leadId === lead.id && call.at > lead.followUpSince!)).length >= followUpLimit) return "No reply";
  return calls.find((call) => call.leadId === lead.id && lostOutcomes.includes(call.outcome))?.outcome || "Lost";
}
function StageLine({ lead, calls }: { lead: Lead; calls: CallRecord[] }) {
  if (lead.status === "Follow-up") return <FollowUpTag lead={lead} calls={calls} />;
  if (lead.status === "New") {
    const tries = callAttempts(calls.filter((call) => call.leadId === lead.id)).length;
    if (resting(callStats(calls).get(lead.id))) return <span className="stage-line"><Dots tones={["tried", "tried", "tried"]} />Resting after {restAfterMisses} misses</span>;
    return <span className="stage-line"><Dots tones={[1, 2, 3].map((n) => (n <= tries ? "tried" : "empty"))} />{tries ? `${tries} ${tries === 1 ? "try" : "tries"}, no answer` : "Not called yet"}</span>;
  }
  if (lead.status === "Meeting booked") {
    if (!/^\d{4}-\d{2}-\d{2}/.test(lead.due)) return <span className="stage-line"><Dots tones={["empty"]} />No meeting time</span>;
    const at = new Date(lead.due);
    const today = new Date().toDateString() === at.toDateString();
    const past = at.getTime() < Date.now() && !today;
    return <span className="stage-line"><Dots tones={[past ? "bad" : today ? "warn" : "good"]} />{past ? `Was ${dueLabel(lead.due).text}, no result` : dueLabel(lead.due).text}</span>;
  }
  if (lead.status === "Won") return <span className="stage-line"><Dots tones={[lead.value ? "good" : "empty"]} />{lead.value ? `$${lead.value.toLocaleString()}` : "No deal value yet"}</span>;
  const reason = lostReason(lead, calls);
  return <span className="stage-line"><Dots tones={[reason === "Do not call" ? "bad" : reason === "No reply" ? "done" : "tried"]} />{reason}</span>;
}

const campaignStageTone: Record<string, string> = { New: "tried", "Follow-up": "fu1", "Meeting booked": "fu2", Won: "good", Lost: "bad" };

// One legend per column, in the same dot style as the cards.
const stageLegends: Record<string, [string, string][]> = {
  New: [["empty", "Not called"], ["tried", "Each try"]],
  "Follow-up": [["fu1", "1st"], ["fu2", "2nd"], ["fu3", "3rd"], ["done", "No reply"]],
  "Meeting booked": [["good", "Upcoming"], ["warn", "Today"], ["bad", "Past, no result"]],
  Won: [["good", "Deal value"], ["empty", "No value yet"]],
  Lost: [["tried", "Said no"], ["done", "No reply"], ["bad", "Do not call"]],
};

// Analytics: calls per day, how calls ended, and (for owners) who made them, over 7, 14 or 30 days.
const outcomeOrder = ["Meeting booked", "Interested", "Callback", "Maybe later", "Not interested", "Voicemail", "No answer", "Busy", "Wrong number", "Do not call", "Didn't connect", "Call ended"];
function Analytics({ calls, team, isOwner, onOpenCalls }: { calls: CallRecord[]; team: Member[]; isOwner: boolean; onOpenCalls: () => void }) {
  const [range, setRange] = useState(() => { try { return Number(localStorage.getItem("open-dialer-analytics-range")) || 14; } catch { return 14; } });
  useEffect(() => { try { localStorage.setItem("open-dialer-analytics-range", String(range)); } catch { /* private mode */ } }, [range]);
  const today = new Date();
  const since = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (range - 1)).toISOString();
  const inRange = calls.filter((call) => call.at >= since);
  const attempts = callAttempts(inRange);
  const conversations = attempts.filter((attempt) => attempt.conversation).length;
  // How each call ended: the outcome you logged, else what Twilio reported.
  const outcomes = new Map<string, number>();
  for (const call of inRange) if (call.outcome !== "In progress") outcomes.set(call.outcome, (outcomes.get(call.outcome) || 0) + 1);
  const rank = (outcome: string) => (outcomeOrder.includes(outcome) ? outcomeOrder.indexOf(outcome) : 99);
  const outcomeRows = [...outcomes].sort((left, right) => rank(left[0]) - rank(right[0]) || right[1] - left[1]);
  const outcomePeak = Math.max(1, ...outcomeRows.map(([, count]) => count));
  // Per person, counted as calls (a dial plus its logged result is one call), like the chart.
  const callerRows = [...new Set(inRange.map((call) => call.userId || ""))].map((id) => {
    const mine = callAttempts(inRange.filter((call) => (call.userId || "") === id));
    return { id, name: team.find((member) => member.id === id)?.name || (id ? "Removed teammate" : "Not recorded"), calls: mine.length, conversations: mine.filter((attempt) => attempt.conversation).length };
  }).sort((left, right) => right.calls - left.calls);
  return (
    <section className="analytics-page">
      <div className="analytics-head">
        <dl className="analytics-totals">
          <div><dt>Calls</dt><dd>{attempts.length}</dd></div>
          <div><dt>Conversations</dt><dd>{conversations}</dd></div>
          <div><dt>Connect rate</dt><dd>{attempts.length ? `${Math.round((conversations / attempts.length) * 100)}%` : "–"}</dd></div>
        </dl>
        <div className="segmented" role="group" aria-label="Date range">
          {[7, 14, 30].map((days) => <button key={days} type="button" className={range === days ? "is-active" : ""} aria-pressed={range === days} onClick={() => setRange(days)}>{days} days</button>)}
        </div>
      </div>
      <CallsChart key={range} calls={calls} range={range} onOpenCalls={onOpenCalls} />
      <div className="analytics-grid">
        <section className="analytics-card">
          <h2>How calls ended</h2>
          {outcomeRows.length ? (
            <ul className="analytics-bars">
              {outcomeRows.map(([outcome, count]) => (
                <li key={outcome}><span>{outcome}</span><i aria-hidden="true"><b style={{ width: `${(count / outcomePeak) * 100}%` }} /></i><em>{count}</em></li>
              ))}
            </ul>
          ) : <p className="analytics-empty">No call results in the last {range} days.</p>}
        </section>
        {isOwner && (
          <section className="analytics-card">
            <h2>Calls by person</h2>
            {callerRows.length ? (
              <table className="analytics-table">
                <thead><tr><th scope="col">Person</th><th scope="col">Calls</th><th scope="col">Conversations</th></tr></thead>
                <tbody>{callerRows.map((row) => <tr key={row.id}><td>{row.name}</td><td>{row.calls}</td><td>{row.conversations}</td></tr>)}</tbody>
              </table>
            ) : <p className="analytics-empty">No calls in the last {range} days.</p>}
            {callerRows.some((row) => !row.id) && <p className="field-hint">"Not recorded" is calls from before accounts, which don't say who made them.</p>}
          </section>
        )}
      </div>
    </section>
  );
}

// Calls and conversations for each of the last `count` days, oldest first.
function dailyCalls(calls: CallRecord[], count: number) {
  const today = new Date();
  const days = Array.from({ length: count }, (_, index) => {
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (count - 1 - index));
    return { date, key: date.toDateString(), calls: 0, conversations: 0 };
  });
  const byKey = new Map(days.map((day) => [day.key, day]));
  for (const attempt of callAttempts(calls)) {
    const day = byKey.get(new Date(attempt.at).toDateString());
    if (!day) continue;
    day.calls += 1;
    if (attempt.conversation) day.conversations += 1;
  }
  return days;
}

// Calls per day, with the conversations in each day.
function CallsChart({ calls, range: chartDays = 14, onOpenCalls }: { calls: CallRecord[]; range?: number; onOpenCalls: () => void }) {
  const [hover, setHover] = useState<number | null>(null);
  // Drawn at the box's real width, so labels keep their shape instead of stretching.
  const plot = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(280, Math.round(entry.contentRect.width))));
    if (plot.current) observer.observe(plot.current);
    return () => observer.disconnect();
  }, []);
  const days = dailyCalls(calls, chartDays);
  const total = days.reduce((sum, day) => sum + day.calls, 0);
  const todayCount = days[chartDays - 1].calls;
  const yesterday = days[chartDays - 2].calls;
  const average = Math.round(days.slice(0, -1).reduce((sum, day) => sum + day.calls, 0) / (chartDays - 1));
  // Scale to a round top so the gridlines land on whole numbers.
  const peak = Math.max(4, ...days.map((day) => day.calls));
  const top = peak <= 10 ? Math.ceil(peak / 2) * 2 : Math.ceil(peak / 10) * 10;
  const height = 160;
  const tickEvery = chartDays <= 14 ? 2 : 5;
  const slot = width / chartDays;
  const bar = Math.min(28, slot - 8);
  const y = (value: number) => height - (value / top) * height;
  const label = (date: Date) => new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
  // A rounded top on the highest segment, square at the baseline.
  const roundTop = (x: number, y0: number, y1: number) => {
    const r = Math.min(4, (y1 - y0) / 2, bar / 2);
    return `M${x},${y1}V${y0 + r}Q${x},${y0} ${x + r},${y0}H${x + bar - r}Q${x + bar},${y0} ${x + bar},${y0 + r}V${y1}Z`;
  };
  return (
    <section className="calls-chart" aria-label={`Calls per day, last ${chartDays} days`}>
      <header>
        <div>
          <h2>Calls per day</h2>
          <p><b>{todayCount}</b> today · <b>{yesterday}</b> yesterday · <b>{average}</b> a day on average over the last {chartDays - 1} days</p>
        </div>
        <ul className="calls-chart__legend" aria-label="Legend">
          <li><i className="is-conversation" aria-hidden="true" /> Conversations</li>
          <li><i className="is-other" aria-hidden="true" /> Other calls</li>
        </ul>
        <button type="button" className="quiet-button" onClick={onOpenCalls}>See calls</button>
      </header>
      <div className="calls-chart__plot" ref={plot}>
        {!total && <p className="calls-chart__empty">No calls logged in the last {chartDays} days. Calls you make or log in the app show up here.</p>}
        <svg viewBox={`0 -14 ${width} ${height + 34}`} role="img" aria-hidden="true">
          {[0.5, 1].map((share) => (
            <g key={share} className="calls-chart__grid">
              <line x1="0" x2={width} y1={y(top * share)} y2={y(top * share)} />
              <text x="0" y={y(top * share) - 4}>{top * share}</text>
            </g>
          ))}
          <line className="calls-chart__base" x1="0" x2={width} y1={height} y2={height} />
          {days.map((day, index) => {
            const x = index * slot + (slot - bar) / 2;
            const isToday = index === chartDays - 1;
            const conversationTop = y(day.conversations);
            const totalTop = y(day.calls);
            const other = day.calls - day.conversations;
            return (
              <g key={day.key} className={`calls-chart__day${isToday ? " is-today" : ""}${hover === index ? " is-hover" : ""}`}>
                {day.conversations > 0 && <path className="is-conversation" d={other > 0 ? `M${x},${height}V${conversationTop}H${x + bar}V${height}Z` : roundTop(x, conversationTop, height)} />}
                {other > 0 && <path className="is-other" d={roundTop(x, totalTop, conversationTop - (day.conversations > 0 ? 2 : 0))} />}
                {(isToday || hover === index) && day.calls > 0 && <text className="calls-chart__value" x={x + bar / 2} y={totalTop - 6}>{day.calls}</text>}
                {(chartDays - 1 - index) % tickEvery === 0 && <text className="calls-chart__tick" x={x + bar / 2} y={height + 18}>{isToday ? "Today" : label(day.date)}</text>}
                {/* Hit target: the whole column, taller and wider than the bar. */}
                <rect className="calls-chart__hit" x={index * slot} y={-14} width={slot} height={height + 34} onMouseEnter={() => setHover(index)} onMouseLeave={() => setHover(null)} />
              </g>
            );
          })}
        </svg>
        {hover !== null && (
          <div className="calls-chart__tip" style={{ left: `${((hover + 0.5) / chartDays) * 100}%` }}>
            <b>{hover === chartDays - 1 ? "Today" : new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" }).format(days[hover].date)}</b>
            <span>{days[hover].calls} call{days[hover].calls === 1 ? "" : "s"}</span>
            <span>{days[hover].conversations} conversation{days[hover].conversations === 1 ? "" : "s"}</span>
          </div>
        )}
      </div>
      <table className="sr-only">
        <caption>Calls per day</caption>
        <thead><tr><th scope="col">Day</th><th scope="col">Calls</th><th scope="col">Conversations</th></tr></thead>
        <tbody>{days.map((day) => <tr key={day.key}><td>{label(day.date)}</td><td>{day.calls}</td><td>{day.conversations}</td></tr>)}</tbody>
      </table>
    </section>
  );
}

// The last 14 days as a slim bar row above the day's numbers; today is the highlighted bar. Hover a bar for its count.
function CallStrip({ calls, onOpen }: { calls: CallRecord[]; onOpen: () => void }) {
  const days = dailyCalls(calls, 14);
  const peak = Math.max(1, ...days.map((day) => day.calls));
  const average = Math.round(days.slice(0, -1).reduce((sum, day) => sum + day.calls, 0) / 13);
  const label = (date: Date) => new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" }).format(date);
  return (
    <div className="call-strip">
      <p><span>Calls, last 14 days</span><span>{average} a day on average · <button type="button" className="text-link" onClick={onOpen}>See calls</button></span></p>
      <div className="call-strip__bars" role="img" aria-label={`Calls per day over the last 14 days: ${days.map((day) => day.calls).join(", ")}`}>
        {days.map((day, index) => (
          <i key={day.key} className={index === days.length - 1 ? "is-today" : ""} title={`${index === days.length - 1 ? "Today" : label(day.date)}: ${day.calls} call${day.calls === 1 ? "" : "s"}`}>
            <b style={{ height: `${day.calls ? 15 + (day.calls / peak) * 85 : 0}%` }} />
          </i>
        ))}
      </div>
    </div>
  );
}

type StatTarget = "calls-today" | "conversations" | "followups" | "to-call";

function DashboardBanner({ state, selected, picker, onStart, onAddLead, onGuide, onGo }: { state: State; selected: Lead; picker: ReactNode; onStart: () => void; onAddLead: () => void; onGuide: () => void; onGo: (target: StatTarget) => void }) {
  const setup = setupSteps(state);
  const setupDone = setup.filter((step) => step.done).length;
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const endOfDay = startOfDay + 86_400_000;
  const callsToday = state.calls.filter((call) => new Date(call.at).getTime() >= startOfDay);
  const attemptsToday = callAttempts(callsToday);
  const followUpsDue = state.leads.filter((lead) => lead.status === "Follow-up" && !lead.dnc && (!/^\d{4}-\d{2}-\d{2}/.test(lead.due) || new Date(lead.due).getTime() < endOfDay)).length;
  const toCall = state.leads.filter(inQueue).length;
  // Today's progress: distinct leads called today out of everything that was in today's queue.
  const calledLeads = new Set(callsToday.map((call) => call.leadId));
  const progressTotal = new Set([...state.leads.filter(inQueue).map((lead) => lead.id), ...calledLeads]).size;
  const zone = leadZone(selected);
  const clock = zone && zoneClock(zone.zone, now);
  const inHours = clock ? clock.hour >= 8 && clock.hour < 21 : null;
  return (
    <section className="dash-banner" aria-label="Today">
      <div className="dash-banner__head">
        <h1 className="dash-date">{new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long" }).format(now)}<span> · {new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(now)} your time</span></h1>
        <div className="dash-banner__actions">
          {picker}
          {setupDone < setup.length && <button className="quiet-button" onClick={onGuide}><BadgeCheck size={16} /> Setup {setupDone}/{setup.length}</button>}
          <button className="quiet-button" onClick={onAddLead}><Plus size={16} /> Add lead</button>
          <button className="primary-button" onClick={onStart} disabled={!toCall}>Start calling <ChevronRight size={16} /></button>
        </div>
      </div>
      <div className="dash-banner__body">
        <div className="dash-banner__main">
        <ZoneClocks leads={state.leads} current={zone ? zone.zone : null} now={now} />
        <CallStrip calls={state.calls} onOpen={() => onGo("calls-today")} />
        <dl className="dash-stats">
          {/* Each number opens the list behind it; the label is a button stretched over the whole tile. */}
          <div><dt><button type="button" className="stretch-link" onClick={() => onGo("calls-today")}>Calls today</button></dt><dd>{attemptsToday.length}</dd></div>
          <div><dt><button type="button" className="stretch-link" onClick={() => onGo("conversations")}>Conversations</button></dt><dd>{attemptsToday.filter((attempt) => attempt.conversation).length}</dd></div>
          <div><dt><button type="button" className="stretch-link" onClick={() => onGo("followups")}>Follow-ups due</button></dt><dd>{followUpsDue}</dd></div>
          <div><dt><button type="button" className="stretch-link" onClick={() => onGo("to-call")}>Left to call</button></dt><dd>{toCall}</dd></div>
        </dl>
        <div className="dash-progress">
          <span><i style={{ width: `${progressTotal ? Math.round((calledLeads.size / progressTotal) * 100) : 0}%` }} /></span>
          <em>{calledLeads.size} of {progressTotal} leads called today</em>
        </div>
        </div>
        <figure className="dash-where">
          <StateTileMap leads={state.leads.filter((lead) => !lead.dnc)} current={leadStateCode(selected)} zone={zone ? zone.zone : null} />
          <DaylightStrip hour={clock ? clock.hour : null} minute={clock ? clock.minute : 0} />
          <figcaption>
            <b>{leadLabel(selected)}</b>
            {clock && zone ? <span className={inHours ? "is-open" : ""}>{zone.place} · {clock.label}, {hoursNote(clock).text}</span> : <span>No state yet. Add one with Edit to check calling hours.</span>}
          </figcaption>
        </figure>
      </div>
    </section>
  );
}

function Queue({
  state,
  selected,
  onSelect,
  onPrepare,
  onRecord,
  onDnc,
  onEdit,
  onStatus,
  onSettings,
  onAddLead,
  onGuide,
  onAddTask,
  onGo,
  onOpenPdf,
  onEditScript,
  calling,
  picker,
}: {
  onOpenPdf: (campaign: string) => void;
  onEditScript: (campaign: string) => void;
  calling: boolean;
  picker: ReactNode;
  onAddLead: () => void;
  onGuide: () => void;
  onAddTask: (lead: Lead) => void;
  onGo: (target: StatTarget) => void;
  state: State;
  selected: Lead;
  onSelect: (id: string) => void;
  onPrepare: (lead: Lead) => void;
  onRecord: (lead: Lead) => void;
  onDnc: (lead: Lead, value: boolean) => void;
  onEdit: (lead: Lead) => void;
  onStatus: (lead: Lead, status: string) => void;
  onSettings: () => void;
}) {
  const upcoming = callQueue(state.leads, state.calls);
  const groups = groupDetails(selected.details);
  // The script of the lead's first campaign that has one.
  const scriptCampaign = selected.campaigns?.find((name) => state.campaignSettings?.[name]?.script || state.campaignSettings?.[name]?.pdf);
  const script = scriptCampaign ? state.campaignSettings![scriptCampaign] : undefined;
  return (
    <div className="queue-page">
      <DashboardBanner
        state={state}
        selected={selected}
        picker={picker}
        onAddLead={onAddLead}
        onGuide={onGuide}
        onGo={onGo}
        onStart={() => {
          const next = upcoming[0];
          if (next) onSelect(next.id);
          document.querySelector(".call-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
        }}
      />
      <section className="queue-layout">
        <aside className="call-list" aria-label="Calling queue">
          {upcoming.map((lead) => (
            <button
              key={lead.id}
              className={
                selected.id === lead.id
                  ? "call-list-item is-selected"
                  : "call-list-item"
              }
              onClick={() => onSelect(lead.id)}
            >
              <span>
                <b>{leadLabel(lead)}</b>
                <small>{leadSubtitle(lead)}</small>
                {lead.due && lead.due !== "Unscheduled" && <span className="lead-time">{lead.due.replace("T", " ")}</span>}
              </span>
              <ChevronRight size={17} />
            </button>
          ))}
        </aside>
        <article className="call-panel">
          {selected.dnc && (
            <div className="call-panel__bar">
              <Status tone="alert">Suppressed</Status>
            </div>
          )}
          <div className="lead-heading">
            <div className="lead-heading__identity">
              <i aria-hidden="true">{leadLabel(selected).split(" ").map((part) => part[0]).join("").slice(0, 2).toUpperCase()}</i>
              <div>
                <h2>{leadLabel(selected)}</h2>
                <p>{leadSubtitle(selected)}</p>
              </div>
            </div>
            <div className="lead-heading__actions">
              <button className="quiet-button" onClick={() => onAddTask(selected)}>
                <ListTodo size={16} aria-hidden="true" /> Add task
              </button>
              <button className="quiet-button" onClick={() => onEdit(selected)}>
                Edit
              </button>
              <button
                className="quiet-button"
                onClick={() => onDnc(selected, !selected.dnc)}
              >
                {selected.dnc ? "Restore calling" : "Do not call"}
              </button>
            </div>
          </div>
          <section className="dial-strip" aria-label="Dial">
            <div className="dial-strip__number">
              <a href={`tel:${selected.phone.replace(/[^\d+]/g, "")}${selected.extension ? `,${selected.extension}` : ""}`}>{formatPhone(selected.phone, selected.extension)}</a>
              <div className="dial-strip__meta">
                <span>{(() => { const zone = leadZone(selected); return zone ? `${localTime(zone.zone)} in ${zone.place}` : <button type="button" className="text-link" onClick={() => onEdit(selected)}>Set the state to see local time</button>; })()}</span>
                <select className="status-select" value={selected.status} disabled={selected.dnc} onChange={(event) => onStatus(selected, event.target.value)} aria-label="Pipeline stage">
                  {leadStages.map((stage) => <option key={stage}>{stage}</option>)}
                </select>
                <FollowUpTag lead={selected} calls={state.calls} />
              </div>
              {followUpInfo(selected, state.calls)?.exhausted && (
                <p className="fu-nudge">{followUpLimit} follow-ups with no reply. <button type="button" className="text-link" onClick={() => onStatus(selected, "Lost")}>Move to Lost</button></p>
              )}
            </div>
            <div className="dial-strip__actions">
              <button className="call-button" onClick={() => onPrepare(selected)} disabled={selected.dnc || calling}>
                <Phone size={17} /> {state.connection ? "Call lead" : "Call via Twilio"}
              </button>
              <button className="quiet-button" onClick={() => onRecord(selected)}>Log outcome</button>
            </div>
            {(() => {
              const last = state.calls.find((call) => call.leadId === selected.id);
              if (!last || !["In progress", "Didn't connect", "Call ended"].includes(last.outcome)) return null;
              const text = last.outcome === "In progress" ? "Call in progress." : last.note;
              return (
                <div className={`dial-strip__last${last.outcome === "Didn't connect" ? " is-failed" : ""}`} role="status">
                  <p>Last attempt, {new Date(last.at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}: {text}</p>
                  {last.outcome === "Didn't connect" && <TwilioWhy callId={last.id} />}
                </div>
              );
            })()}
            <p className="dial-strip__note">
              <LockKeyhole size={14} aria-hidden="true" />
              <span>
                {selected.dnc ? "On the do-not-call list" : "Do-not-call clear"} ·{" "}
                {state.connection ? (
                  usesAppPhone(state.connection)
                    ? `The lead sees ${state.connection.selectedNumber}. You talk through this app's microphone and speaker.`
                    : `The lead sees ${state.connection.selectedNumber}. ${state.connection.bridgeNumber!.startsWith("sip:") ? "Zoiper" : "Your phone"} rings first, then the lead.`
                ) : (
                  <>
                    <button onClick={onSettings}>Connect Twilio</button> to call from here, or dial yourself and log the outcome.
                  </>
                )}
              </span>
            </p>
          </section>
          {groups.quick.length > 0 && (
            <dl className="call-facts">
              {groups.quick.map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          )}
          <section className="call-script" aria-label="Talking points">
            {realNote(selected) && (
              <div>
                <h3>Note</h3>
                <p>{realNote(selected)}</p>
              </div>
            )}
            {groups.say.map(([label, value]) => (
              <div key={label}>
                <h3>{label}</h3>
                <p>{value}</p>
              </div>
            ))}
            {!realNote(selected) && !groups.say.length && <p className="call-script__empty">No talking points yet. <button type="button" className="text-link" onClick={() => onEdit(selected)}>Add a note</button></p>}
          </section>
          {scriptCampaign && script && (
            <details className="call-more call-script-full" open>
              <summary><ChevronRight size={16} aria-hidden="true" /> Script <small>{scriptCampaign}</small></summary>
              <div className="call-script-full__body">
                <div className="call-script-full__tools">
                  {script.pdf && <button type="button" className="quiet-button" onClick={() => onOpenPdf(scriptCampaign)}><FileText size={16} aria-hidden="true" /> Open {script.pdf.name}</button>}
                  <button type="button" className="quiet-button" onClick={() => onEditScript(scriptCampaign)}>Edit script</button>
                </div>
                {script.script && <ScriptView text={script.script} lead={selected} />}
                {script.pdf && !script.script && <PdfPages campaign={scriptCampaign} />}
              </div>
            </details>
          )}
          {groups.research.length > 0 && (
            <details className="call-more">
              <summary><ChevronRight size={16} aria-hidden="true" /> Research <small>{groups.research.length}</small></summary>
              <dl>{groups.research.map(([label, value]) => <div key={label}><dt>{label}</dt><dd><DetailValue value={value} /></dd></div>)}</dl>
            </details>
          )}
          {groups.sources.length > 0 && (
            <details className="call-more">
              <summary><ChevronRight size={16} aria-hidden="true" /> Sources &amp; history <small>{groups.sources.length}</small></summary>
              <dl>{groups.sources.map(([label, value]) => <div key={label}><dt>{label}</dt><dd><DetailValue value={value} /></dd></div>)}</dl>
            </details>
          )}
        </article>
      </section>
    </div>
  );
}

function LeadList({
  leads,
  onOpen,
  onImport,
  onDncList,
  calls,
  onEdit,
  onDelete,
  onTag,
  team,
  onAssign,
  campaigns,
  initialSegment,
  onCampaign,
  onStatus,
}: {
  leads: Lead[];
  calls: CallRecord[];
  onEdit: (lead: Lead) => void;
  onDelete: (ids: string[]) => Promise<void>;
  onTag: (ids: string[], campaign: string) => Promise<boolean>;
  team: Member[];
  onAssign: (ids: string[], userId: string) => Promise<boolean>;
  campaigns: string[];
  initialSegment: "all" | "to-call" | "try-again" | "follow-up" | "closed";
  onCampaign: (name: string) => void;
  onStatus: (lead: Lead, status: string) => void;
  onOpen: (id: string) => void;
  onImport: () => void;
  onDncList: () => void;
}) {
  const [query, setQuery] = useState("");
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [tagName, setTagName] = useState("");
  const [filterOpen, setFilterOpen] = useState(false);
  const [sort, setSort] = useState<"newest" | "name">("newest");
  const [segment, setSegment] = useState<
    "all" | "to-call" | "try-again" | "follow-up" | "closed"
  >(initialSegment);
  const calledIds = new Set(calls.map((call) => call.leadId));
  const groups = {
    // New splits by call history: never called vs called without reaching anyone.
    "to-call": leads.filter((lead) => !lead.dnc && lead.status === "New" && !calledBefore(lead, calledIds)),
    "try-again": leads.filter((lead) => !lead.dnc && lead.status === "New" && calledBefore(lead, calledIds)),
    "follow-up": leads.filter((lead) => !lead.dnc && ["Follow-up", "Meeting booked"].includes(lead.status)),
    closed: leads.filter((lead) => lead.dnc || ["Won", "Lost"].includes(lead.status)),
  };
  const tabs = [
    { key: "all" as const, icon: Users, label: "All leads", detail: "Every active prospect", count: leads.length },
    { key: "to-call" as const, icon: Phone, label: "To call", detail: "New, not called yet", count: groups["to-call"].length },
    { key: "try-again" as const, icon: RotateCcw, label: "Try again", detail: "Called, no one reached yet", count: groups["try-again"].length },
    { key: "follow-up" as const, icon: CalendarClock, label: "Follow up", detail: "Follow-ups and meetings", count: groups["follow-up"].length },
    { key: "closed" as const, icon: Ban, label: "Closed", detail: "Won, lost or do not call", count: groups.closed.length },
  ];
  const visibleLeads = (segment === "all" ? leads : groups[segment])
    .filter((lead) => [lead.name, lead.company, lead.role, lead.phone, lead.status, lead.note, ...Object.values(lead.details || {})].join(" ").toLowerCase().includes(query.trim().toLowerCase()))
    .sort((left, right) => sort === "name" ? leadLabel(left).localeCompare(leadLabel(right)) : 0);
  const lastCall = new Map<string, CallRecord>();
  for (const call of calls) if (!lastCall.has(call.leadId)) lastCall.set(call.leadId, call);
  const picked = visibleLeads.filter((lead) => checked.has(lead.id));
  const allPicked = visibleLeads.length > 0 && picked.length === visibleLeads.length;
  const toggle = (id: string) => setChecked((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const tagPicked = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!tagName.trim()) return;
    if (await onTag(picked.map((lead) => lead.id), tagName)) {
      setChecked(new Set());
      setTagName("");
    }
  };
  const removePicked = async () => {
    if (!window.confirm(`Delete ${picked.length} lead${picked.length === 1 ? "" : "s"}? This cannot be undone.`)) return;
    await onDelete(picked.map((lead) => lead.id));
    setChecked(new Set());
  };

  return (
    <section className="lead-workspace">
      <div className="lead-buckets" role="tablist" aria-label="Lead status">
        {tabs.map((tab) => (
          <button
            type="button"
            key={tab.key}
            role="tab"
            aria-selected={segment === tab.key}
            className={segment === tab.key ? "lead-bucket is-active" : "lead-bucket"}
            onClick={() => setSegment(tab.key)}
          >
            <span><tab.icon size={16} aria-hidden="true" />{tab.label}</span>
            <strong>{tab.count}</strong>
            <small>{tab.detail}</small>
            {tab.key === "all" && (
              <div className="lead-bucket__quota" aria-label={`${leads.length} active leads`}>
                <span><i style={{ width: `${Math.min(100, leads.length * 8)}%` }} /></span>
                <em>{leads.length} active leads</em>
              </div>
            )}
          </button>
        ))}
      </div>

      <div className="lead-toolbar">
        <label className="lead-search">
          <Search size={18} aria-hidden="true" />
          <span className="sr-only">Search leads</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search leads…"
          />
        </label>
        <div className="lead-toolbar__actions">
          <button className="toolbar-button" type="button" aria-expanded={filterOpen} onClick={() => setFilterOpen((open) => !open)}>
            <Filter size={16} /> Filters
          </button>
          <button className="toolbar-button toolbar-button--select" type="button" onClick={() => setSort((current) => current === "newest" ? "name" : "newest")}>
            {sort === "newest" ? "Newest first" : "Name A–Z"} <ChevronRight size={15} />
          </button>
          <button className="toolbar-button" type="button" onClick={onImport}>
            <FileUp size={16} /> Import CSV
          </button>
          <button className="toolbar-button" type="button" onClick={() => exportLeads(visibleLeads, "open-dialer-leads.csv")} disabled={!visibleLeads.length}>
            Export
          </button>
          <button className="toolbar-button" type="button" onClick={onDncList}>
            DNC list
          </button>
        </div>
      </div>
      {picked.length > 0 && (
        <div className="lead-bulk-bar" role="region" aria-label="Selected leads">
          <b>{picked.length} selected</b>
          <form className="lead-bulk-tag" onSubmit={(event) => void tagPicked(event)}>
            <input value={tagName} onChange={(event) => setTagName(event.target.value)} placeholder="Campaign name" list="bulk-campaign-options" autoComplete="off" aria-label="Campaign for the selected leads" />
            <datalist id="bulk-campaign-options">{campaigns.map((name) => <option key={name} value={name} />)}</datalist>
            <button type="submit" className="toolbar-button" disabled={!tagName.trim()}><Tag size={16} aria-hidden="true" /> Add to campaign</button>
          </form>
          {team.length > 1 && (
            <select className="lead-bulk-assign" value="" aria-label="Assign the selected leads" onChange={(event) => { const value = event.target.value; if (value) void onAssign(picked.map((lead) => lead.id), value === "none" ? "" : value).then((done) => done && setChecked(new Set())); }}>
              <option value="">Assign to…</option>
              {team.map((member) => <option key={member.id} value={member.id}>{member.name}{member.role === "owner" ? " (owner)" : ""}</option>)}
              <option value="none">No one (owners only)</option>
            </select>
          )}
          <button type="button" className="toolbar-button" onClick={() => exportLeads(picked, "open-dialer-selected-leads.csv")}>Export selected</button>
          <button type="button" className="toolbar-button danger-button" onClick={() => void removePicked()}>Delete selected</button>
          <button type="button" className="toolbar-button" onClick={() => setChecked(new Set())}>Clear</button>
        </div>
      )}
      {filterOpen && <div className="lead-filter-menu" role="group" aria-label="Filter leads by status">{tabs.map((tab) => <button className={segment === tab.key ? "is-active" : ""} key={tab.key} type="button" onClick={() => { setSegment(tab.key); setFilterOpen(false); }}>{tab.label}</button>)}</div>}

      <div className="lead-table-wrap">
        <table className="lead-list-table">
          <colgroup>
            <col className="lead-col--select" />
            <col className="lead-col--prospect" />
            <col className="lead-col--contact" />
            <col className="lead-col--status" />
            <col className="lead-col--last-call" />
            <col className="lead-col--email" />
            <col className="lead-col--actions" />
          </colgroup>
          <thead>
            <tr>
              <th scope="col"><input type="checkbox" aria-label="Select all visible leads" checked={allPicked} onChange={() => setChecked(allPicked ? new Set() : new Set(visibleLeads.map((lead) => lead.id)))} /></th>
              <th scope="col">Prospect</th>
              <th scope="col">Contact</th>
              <th scope="col">Status</th>
              <th scope="col">Last call</th>
              <th scope="col">Campaign</th>
              <th scope="col"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {visibleLeads.map((lead) => {
              const initials = leadLabel(lead)
                .split(" ")
                .map((part) => part[0])
                .join("")
                .slice(0, 2)
                .toUpperCase();
              const tag = lead.dnc ? "do not call" : lead.due && !["Unscheduled", "Won", "Lost", "Follow up"].includes(lead.due) ? `next: ${lead.due.replace("T", " ")}` : lead.status.toLowerCase();
              const statusLabel = lead.dnc ? "DNC" : lead.status;
              const latest = lastCall.get(lead.id);
              return (
                <tr key={lead.id}>
                <td><input type="checkbox" aria-label={`Select ${leadLabel(lead)}`} checked={checked.has(lead.id)} onChange={() => toggle(lead.id)} /></td>
                <td>
                  <button className="prospect-button" type="button" onClick={() => onOpen(lead.id)}>
                    <span className="prospect-identity">
                      <i aria-hidden="true">{initials}</i>
                      <span>
                        <b>{leadLabel(lead)}</b>
                        <small>{leadSubtitle(lead)}</small>
                        <em>{tag}</em>
                      </span>
                    </span>
                  </button>
                </td>
                <td>
                  <span className="contact-phone">{formatPhone(lead.phone, lead.extension)}</span>
                  <small>{(() => { const zone = leadZone(lead); return zone ? `${localTime(zone.zone)} in ${zone.place}` : <button type="button" className="text-link" onClick={() => onEdit(lead)}>Set the state</button>; })()}</small>
                </td>
                <td>
                  {/* The stage pill opens the stage list: the native select sits invisibly over it. */}
                  <span className={`lead-status-menu ${lead.dnc || lead.status === "Lost" ? "lead-status is-dnc" : lead.status === "Won" ? "lead-status is-ready" : "lead-status"}`}>
                    {!lead.dnc && <Plus size={13} aria-hidden="true" />}
                    {statusLabel}
                    {!lead.dnc && (
                      <select value={lead.status} onChange={(event) => onStatus(lead, event.target.value)} aria-label={`Stage for ${leadLabel(lead)}`}>
                        {leadStages.map((option) => <option key={option}>{option}</option>)}
                      </select>
                    )}
                  </span>
                  <FollowUpTag lead={lead} calls={calls} />
                </td>
                <td><span className="next-step">{latest ? <>{latest.outcome}<small>{new Date(latest.at).toLocaleDateString()}</small></> : "Not yet"}</span></td>
                <td>{lead.campaigns?.length ? <span className="campaign-tags">{lead.campaigns.map((name, index) => <span key={name}>{index > 0 && ", "}<button type="button" className="text-link" onClick={() => onCampaign(name)} title={`Show only ${name}`}>{name}</button></span>)}</span> : <span className="empty-cell">—</span>}{team.length > 1 && <small className="lead-assignee">{team.find((member) => member.id === lead.assignedTo)?.name || "Unassigned"}</small>}</td>
                <td className="lead-row-actions">
                  <button type="button" onClick={() => onEdit(lead)}>Edit</button>
                  <button type="button" onClick={() => onOpen(lead.id)}>View</button>
                </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!visibleLeads.length && (
          <div className="lead-list-empty">
            <Search size={19} /> No leads match this view.
            {query.trim() && <button type="button" className="text-link" onClick={() => setQuery("")}>Clear search</button>}
            {segment !== "all" && <button type="button" className="text-link" onClick={() => setSegment("all")}>Show all leads</button>}
          </div>
        )}
      </div>
      <footer className="lead-pagination">
        <span>Showing <b>{visibleLeads.length ? 1 : 0}</b> to <b>{visibleLeads.length}</b> of <b>{visibleLeads.length}</b> prospects</span>
        <div>
          <span>Per page: <b>50</b></span>
          <button type="button" disabled>Previous</button>
          <span>Page <b>1</b> of <b>1</b></span>
          <button type="button" disabled>Next</button>
        </div>
      </footer>
    </section>
  );
}

// "2026-11-21T10:00" reads as "Tomorrow, 10:00 AM"; free text like "Follow up" stays as typed.
function dueLabel(due: string) {
  if (!/^\d{4}-\d{2}-\d{2}/.test(due)) return { text: due && due !== "Unscheduled" ? due : "No date", overdue: false };
  const at = new Date(due);
  const today = new Date();
  const days = Math.round((new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime() - new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) / 86_400_000);
  const day = days === 0 ? "Today" : days === 1 ? "Tomorrow" : days === -1 ? "Yesterday" : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(at);
  const time = due.includes("T") ? `, ${new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(at)}` : "";
  return { text: `${day}${time}`, overdue: at.getTime() < Date.now() };
}

function FollowUps({
  leads,
  allLeads,
  calls,
  tasks,
  onOpenTask,
  onQuickAdd,
  onChangeTask,
  done,
  onToggle,
  onSelect,
}: {
  leads: Lead[];
  allLeads: Lead[];
  calls: CallRecord[];
  tasks: Task[];
  onOpenTask: (task: Task) => void;
  onQuickAdd: (fields: TaskFields) => Promise<void>;
  onChangeTask: (task: Task, change: { done: boolean } | "delete") => void;
  done: Lead[];
  onToggle: (lead: Lead, done: boolean) => void;
  onSelect: (id: string) => void;
}) {
  const leadOption = (lead: Lead) => `${leadLabel(lead)} · ${lead.company}`;
  const [addOpen, setAddOpen] = useState(() => { try { return localStorage.getItem("open-dialer-task-add") !== "folded"; } catch { return true; } });
  const toggleAdd = () => setAddOpen((open) => { try { localStorage.setItem("open-dialer-task-add", open ? "folded" : "open"); } catch {} return !open; });
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [leadText, setLeadText] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const quickAdd = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const lead = leadText.trim() ? allLeads.find((item) => leadOption(item) === leadText.trim()) : null;
    if (leadText.trim() && !lead) return setFormError("Pick the lead from the list, or leave it empty.");
    setFormError(null);
    try {
      await onQuickAdd({ title, details: "", due, leadId: lead?.id || null });
      setTitle("");
      setDue("");
      setLeadText("");
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : "Could not add the task.");
    }
  };
  // Dated first, soonest on top; undated after.
  const soonest = (left: string, right: string) => (/^\d{4}-/.test(left) ? new Date(left).getTime() : Infinity) - (/^\d{4}-/.test(right) ? new Date(right).getTime() : Infinity);
  const open = [...leads].sort((left, right) => soonest(left.due, right.due));
  // The app's own tasks are grouped: one for booked meetings (they have a set time, so they come first), one for callbacks.
  const groups = [
    { key: "meetings", title: (count: number) => `${count} booked meeting${count === 1 ? "" : "s"}`, leads: open.filter((lead) => lead.status === "Meeting booked"), icon: CalendarClock, startOpen: true },
    { key: "callbacks", title: (count: number) => `Call back ${count} lead${count === 1 ? "" : "s"}`, leads: open.filter((lead) => lead.status !== "Meeting booked"), icon: PhoneOutgoing, startOpen: false },
  ].filter((group) => group.leads.length);
  const mine = tasks.filter((task) => !task.doneAt).sort((left, right) => soonest(left.due, right.due) || right.createdAt.localeCompare(left.createdAt));
  const leadById = new Map(allLeads.map((lead) => [lead.id, lead]));
  // Done recently: your tasks and callbacks together, newest first.
  const finished = [
    ...tasks.filter((task) => task.doneAt).map((task) => ({ key: task.id, at: task.doneAt!, label: task.title, undo: () => onChangeTask(task, { done: false }) })),
    ...done.map((lead) => ({ key: lead.id, at: lead.taskDone!.at, label: leadLabel(lead), undo: () => onToggle(lead, false) })),
  ].sort((left, right) => right.at.localeCompare(left.at)).slice(0, 12);
  return (
    <section className="tasks-page">
      <div className="tasks-main">
        <div className="tasks-open">
          <header>
            <h2>To do</h2>
            <span className="tasks-open__tools">
              <span>{mine.length + open.length}</span>
              <button type="button" className="icon-button" onClick={toggleAdd} aria-expanded={addOpen} aria-label={addOpen ? "Hide the add row" : "Show the add row"} title={addOpen ? "Hide the add row" : "Show the add row"}>
                <ChevronDown size={18} className={addOpen ? "is-flipped" : undefined} />
              </button>
            </span>
          </header>
          {addOpen && (
            <form className="task-add" onSubmit={(event) => void quickAdd(event)}>
              <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Add a task" aria-label="Task" maxLength={200} required />
              <input type="datetime-local" value={due} onChange={(event) => setDue(event.target.value)} aria-label="Due (optional)" />
              <input value={leadText} onChange={(event) => setLeadText(event.target.value)} placeholder="Lead (optional)" aria-label="Lead (optional)" list="task-lead-options" autoComplete="off" />
              <datalist id="task-lead-options">{allLeads.map((lead) => <option key={lead.id} value={leadOption(lead)} />)}</datalist>
              <button type="submit" className="primary-button" disabled={!title.trim()}><Plus size={16} aria-hidden="true" /> Add</button>
              {formError && <p className="form-error" role="alert">{formError}</p>}
            </form>
          )}
          {mine.map((task) => {
            const lead = task.leadId ? leadById.get(task.leadId) : undefined;
            const when = task.due ? dueLabel(task.due) : null;
            return (
              <article className="task-item" key={task.id}>
                <input type="checkbox" checked={false} onChange={() => onChangeTask(task, { done: true })} aria-label={`Mark "${task.title}" done`} />
                <button type="button" className="task-item__body" onClick={() => onOpenTask(task)}>
                  <b>{task.title}</b>
                  {lead && <small>{leadOption(lead)}</small>}
                </button>
                {when ? <span className={`task-item__due${when.overdue ? " is-overdue" : ""}`}><CalendarClock size={16} aria-hidden="true" />{when.text}</span> : <span />}
                <button type="button" className="icon-button" onClick={() => onChangeTask(task, "delete")} aria-label={`Delete "${task.title}"`}><Trash2 size={16} /></button>
              </article>
            );
          })}
          {groups.map((group) => {
            const overdue = group.leads.filter((lead) => dueLabel(lead.due).overdue).length;
            const next = group.leads.find((lead) => /^\d{4}-/.test(lead.due));
            return (
              <details className="task-group" key={group.key} open={group.startOpen}>
                <summary>
                  <group.icon size={18} aria-hidden="true" />
                  <b>{group.title(group.leads.length)}</b>
                  <span className={`task-item__due${overdue ? " is-overdue" : ""}`}>{overdue ? `${overdue} overdue` : next ? `Next: ${dueLabel(next.due).text}` : ""}</span>
                  <ChevronRight size={18} aria-hidden="true" className="task-group__chevron" />
                </summary>
                {group.leads.map((lead) => {
                  const when = dueLabel(lead.due);
                  return (
                    <article className="task-item" key={lead.id}>
                      <input type="checkbox" checked={false} onChange={() => onToggle(lead, true)} aria-label={`Mark ${leadLabel(lead)} done`} />
                      <button type="button" className="task-item__body" onClick={() => onSelect(lead.id)}>
                        <b>{leadLabel(lead)}</b>
                        <small>{[leadSubtitle(lead), realNote(lead)].filter(Boolean).join(" · ")}</small>
                        <FollowUpTag lead={lead} calls={calls} />
                      </button>
                      <span className={`task-item__due${when.overdue ? " is-overdue" : ""}`}><CalendarClock size={16} aria-hidden="true" />{when.text}</span>
                      <button type="button" className="icon-button" onClick={() => onSelect(lead.id)} aria-label={`Open ${leadLabel(lead)}`}><ChevronRight size={18} /></button>
                    </article>
                  );
                })}
              </details>
            );
          })}
          {!mine.length && !groups.length && <p className="tasks-done__empty">Nothing to do. Add a task with the button above, or log a callback or meeting on a call.</p>}
        </div>
      </div>
      <aside className="tasks-done" aria-label="Done recently">
        <header><h2>Done recently</h2><span>{finished.length}</span></header>
        {finished.map((item) => (
          <article className="task-done" key={item.key}>
            <input type="checkbox" checked onChange={item.undo} aria-label={`Undo ${item.label}`} />
            <span>
              <b>{item.label}</b>
              <small>Done {dueLabel(item.at).text}</small>
            </span>
          </article>
        ))}
        {!finished.length && <p className="tasks-done__empty">Checked-off tasks land here.</p>}
      </aside>
    </section>
  );
}

// A quick look at one lead from the board: who they are, where they stand, what was said. Stage changes here
// also cover keyboard and touch, where dragging doesn't work.
function LeadPeek({ lead, calls, onClose, onMove, onEdit, onCall, onAddTask }: { lead: Lead; calls: CallRecord[]; onClose: () => void; onMove: (lead: Lead, stage: string) => void; onEdit: (lead: Lead) => void; onCall: (id: string) => void; onAddTask: (lead: Lead) => void }) {
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);
  const zone = leadZone(lead);
  const due = lead.due && !["Unscheduled", "Won", "Lost", "Suppressed"].includes(lead.due) ? dueLabel(lead.due) : null;
  const history = calls.filter((call) => call.leadId === lead.id).sort((left, right) => right.at.localeCompare(left.at)).slice(0, 3);
  const details = Object.entries(lead.details || {}).filter(([, value]) => value?.trim());
  return (
    <div className="modal-backdrop" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="lead-form lead-peek" role="dialog" aria-modal="true" aria-labelledby="lead-peek-title">
        <button type="button" className="close-button" onClick={onClose} aria-label="Close" autoFocus><X /></button>
        <header>
          <h2 id="lead-peek-title">{leadLabel(lead)}</h2>
          {leadSubtitle(lead) && <p>{leadSubtitle(lead)}</p>}
        </header>
        <dl className="lead-peek__facts">
          <div><dt>Phone</dt><dd>{formatPhone(lead.phone, lead.extension)}{lead.dnc && <em> · Do not call</em>}{zone && <small>{localTime(zone.zone)} in {zone.place}</small>}</dd></div>
          <div><dt>Stage</dt><dd><select value={lead.status} onChange={(event) => onMove(lead, event.target.value)} aria-label="Stage">{leadStages.map((option) => <option key={option}>{option}</option>)}</select></dd></div>
          {due && <div><dt>Next step</dt><dd className={due.overdue ? "is-overdue" : undefined}>{due.text}</dd></div>}
          {!!lead.value && <div><dt>Deal value</dt><dd>${lead.value.toLocaleString()}</dd></div>}
          {!!lead.campaigns?.length && <div><dt>Campaign</dt><dd>{lead.campaigns.join(", ")}</dd></div>}
        </dl>
        {realNote(lead) && <section className="lead-peek__block"><h3>Note</h3><p>{realNote(lead)}</p></section>}
        <section className="lead-peek__block">
          <h3>Recent calls</h3>
          {history.length ? (
            <ul>{history.map((call) => <li key={call.id}><b>{call.outcome}</b> <small>{dueLabel(call.at).text}</small>{call.note && <p>{call.note}</p>}</li>)}</ul>
          ) : <p>Not called yet.</p>}
        </section>
        {!!details.length && (
          <details className="lead-peek__block">
            <summary>From the import ({details.length})</summary>
            <dl className="lead-peek__facts">{details.map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl>
          </details>
        )}
        <div className="lead-peek__actions">
          <button type="button" className="quiet-button" onClick={() => onAddTask(lead)}><ListTodo size={16} aria-hidden="true" /> Add task</button>
          <button type="button" className="quiet-button" onClick={() => onEdit(lead)}>Edit</button>
          <button type="button" className="primary-button" onClick={() => onCall(lead.id)} disabled={lead.dnc}><Phone size={16} aria-hidden="true" />Open in dialer</button>
        </div>
      </div>
    </div>
  );
}

// ---- Call scripts ----
// Pasted scripts use a few plain-text markers and render like the district call script:
//   # Section            ## Branch heading        > What you say (a "say this" box)
//   Label:               Note: call-flow note     Example: a muted example
//   - list item          lines indented by 2 spaces sit inside a branch
//   **bold**             [Name], [District Name], [fact] fill in from the lead on a call
const scriptHelp = "# Section · ## Branch · > What you say · Label: · Note: · Example: · - list · indent 2 spaces for a branch · [Name] fills in";

// What a [placeholder] becomes for this lead, or null to leave it marked.
function scriptSlot(key: string, lead?: Lead) {
  if (!lead) return null;
  const k = key.trim().toLowerCase();
  const detail = (pattern: RegExp) => Object.entries(lead.details || {}).find(([label, value]) => pattern.test(label) && value?.trim())?.[1] || null;
  if (k === "first name") return lead.name ? lead.name.replace(/^(dr|mr|mrs|ms|mx)\.?\s+/i, "").split(/\s+/)[0] : null;
  if (/^(name|contact|contact name|their name|full name)$/.test(k)) return lead.name || null;
  if (/^(district|district name|company|organization|school system|school district)$/.test(k)) return lead.company && lead.company !== "Unassigned" ? lead.company : null;
  if (k === "state") return leadState(lead)?.[1] || null;
  if (k.includes("fact")) return detail(/fact/i);
  return Object.entries(lead.details || {}).find(([label]) => label.trim().toLowerCase() === k)?.[1] || null;
}

function ScriptInline({ text, lead }: { text: string; lead?: Lead }) {
  return (
    <>
      {text.split(/(\*\*[^*]+\*\*|\[[^\]]+\])/).map((part, index) => {
        if (/^\*\*[^*]+\*\*$/.test(part)) return <strong key={index}>{part.slice(2, -2)}</strong>;
        if (/^\[[^\]]+\]$/.test(part)) {
          const value = scriptSlot(part.slice(1, -1), lead);
          return <mark key={index} className={value ? "script-fill" : "script-slot"}>{value || part}</mark>;
        }
        return part;
      })}
    </>
  );
}

function ScriptView({ text, lead }: { text: string; lead?: Lead }) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  const flushList = () => {
    if (list.length) blocks.push(<ul key={`list-${blocks.length}`}>{list.map((item, index) => <li key={index}><ScriptInline text={item} lead={lead} /></li>)}</ul>);
    list = [];
  };
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    // A run of indented lines is a branch: rendered the same way, inside an indented rule.
    if (/^(\s{2,}|\t)\S/.test(raw)) {
      flushList();
      const branch: string[] = [];
      while (index < lines.length && (/^(\s{2,}|\t)\S/.test(lines[index]) || (!lines[index].trim() && /^(\s{2,}|\t)\S/.test(lines[index + 1] || "")))) branch.push(lines[index++].replace(/^(\s{2}|\t)/, ""));
      index -= 1;
      blocks.push(<div className="script-branch" key={`branch-${index}`}><ScriptView text={branch.join("\n")} lead={lead} /></div>);
      continue;
    }
    const line = raw.trim();
    if (/^[-*]\s+/.test(line)) { list.push(line.replace(/^[-*]\s+/, "")); continue; }
    flushList();
    if (!line) continue;
    const key = `line-${index}`;
    if (/^##\s+/.test(line)) blocks.push(<h4 className="script-sub" key={key}><ScriptInline text={line.replace(/^##\s+/, "")} lead={lead} /></h4>);
    else if (/^#\s+/.test(line)) blocks.push(<h3 className="script-section" key={key}><ScriptInline text={line.replace(/^#\s+/, "")} lead={lead} /></h3>);
    else if (/^>\s?/.test(line)) blocks.push(<blockquote className="script-say" key={key}><ScriptInline text={line.replace(/^>\s?/, "")} lead={lead} /></blockquote>);
    else if (/^["“].+["”]$/.test(line)) blocks.push(<blockquote className="script-say" key={key}><ScriptInline text={line.slice(1, -1)} lead={lead} /></blockquote>);
    else if (/^(note|flow):\s*/i.test(line)) blocks.push(<blockquote className="script-note" key={key}><ScriptInline text={line.replace(/^(note|flow):\s*/i, "")} lead={lead} /></blockquote>);
    else if (/^example:\s*/i.test(line)) blocks.push(<p className="script-example" key={key}><ScriptInline text={line} lead={lead} /></p>);
    else if (line.endsWith(":") && line.length <= 70 && !/[.!?]\s/.test(line)) blocks.push(<p className="script-label" key={key}><ScriptInline text={line.slice(0, -1)} lead={lead} /></p>);
    else blocks.push(<p key={key}><ScriptInline text={line} lead={lead} /></p>);
  }
  flushList();
  return <div className="script">{blocks}</div>;
}

// ---- Live script editor ----
// Each line is a block styled as it will look on the call card. Typing a marker at the start of a line
// ("# ", "## ", "> ", "- ", "Note: ") turns the line into that block; the script still saves as plain text.
type ScriptBlockType = "p" | "section" | "sub" | "say" | "note" | "example" | "li";
const blockPrefix: Record<ScriptBlockType, string> = { p: "", section: "# ", sub: "## ", say: "> ", note: "Note: ", example: "", li: "- " };
const blockShortcuts: [RegExp, ScriptBlockType, boolean][] = [
  // [what was typed at the start of a plain line, block it becomes, keep the typed text?]
  [/^##\s/, "sub", false], [/^#\s/, "section", false], [/^>\s/, "say", false], [/^[-*]\s/, "li", false],
  [/^note:\s/i, "note", false], [/^example:\s/i, "example", true],
];

function parseScriptBlocks(text: string) {
  return text.replace(/\r\n/g, "\n").split("\n").map((raw) => {
    const indent = Math.min(3, (raw.match(/^(?: {2}|\t)*/)?.[0] || "").replace(/\t/g, "  ").length / 2);
    const line = raw.trim();
    const block = (type: ScriptBlockType, value: string) => ({ type, indent: Math.floor(indent), text: value });
    if (/^##\s+/.test(line)) return block("sub", line.replace(/^##\s+/, ""));
    if (/^#\s+/.test(line)) return block("section", line.replace(/^#\s+/, ""));
    if (/^>\s?/.test(line)) return block("say", line.replace(/^>\s?/, ""));
    if (/^["“].+["”]$/.test(line)) return block("say", line.slice(1, -1));
    if (/^(note|flow):\s*/i.test(line)) return block("note", line.replace(/^(note|flow):\s*/i, ""));
    if (/^example:\s*/i.test(line)) return block("example", line);
    if (/^[-*]\s+/.test(line)) return block("li", line.replace(/^[-*]\s+/, ""));
    return block("p", line);
  });
}

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// **bold** shows as bold while editing.
const inlineToHtml = (text: string) => escapeHtml(text).replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
const isLabelText = (text: string) => text.trim().endsWith(":") && text.trim().length <= 70 && !/[.!?]\s/.test(text);

function blockElement(type: ScriptBlockType, indent: number, html: string) {
  const line = document.createElement("div");
  line.className = "se-line";
  line.dataset.type = type;
  line.dataset.indent = String(indent);
  line.innerHTML = html || "<br>";
  return line;
}

// Text of one line, with bold written back as **bold**.
function lineText(node: Node): string {
  let out = "";
  node.childNodes.forEach((child) => {
    if (child.nodeType === Node.TEXT_NODE) out += child.textContent || "";
    else if (child instanceof HTMLElement && child.tagName !== "BR") {
      const inner = lineText(child);
      out += /^(B|STRONG)$/.test(child.tagName) && inner.trim() ? `**${inner}**` : inner;
    }
  });
  return out.replace(/\u00a0/g, " ");
}

function serializeScript(editor: HTMLElement) {
  const lines = [...editor.querySelectorAll<HTMLElement>(":scope > .se-line")].map((line) => {
    const type = (line.dataset.type || "p") as ScriptBlockType;
    let text = lineText(line).replace(/\*\*\*\*/g, "").trimEnd();
    if (type === "example" && !/^example:/i.test(text)) text = `Example: ${text}`;
    if (!text.trim() && type === "p") return "";
    return "  ".repeat(Number(line.dataset.indent || 0)) + blockPrefix[type] + text.trimStart();
  });
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function ScriptEditor({ initial, editorRef }: { initial: string; editorRef: { current: HTMLDivElement | null } }) {
  const [empty, setEmpty] = useState(!initial.trim());
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.replaceChildren(...(initial.trim() ? parseScriptBlocks(initial) : [{ type: "p" as const, indent: 0, text: "" }]).map((block) => blockElement(block.type, block.indent, inlineToHtml(block.text))));
    editor.querySelectorAll<HTMLElement>(".se-line").forEach(markLabel);
  }, []);
  const currentLine = () => {
    const node = window.getSelection()?.anchorNode;
    const element = node && (node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement);
    const line = element?.closest<HTMLElement>(".se-line");
    return line && editorRef.current?.contains(line) ? line : null;
  };
  const caretOffset = (line: HTMLElement) => {
    const selection = window.getSelection();
    if (!selection?.rangeCount) return 0;
    const range = selection.getRangeAt(0).cloneRange();
    range.selectNodeContents(line);
    range.setEnd(selection.getRangeAt(0).startContainer, selection.getRangeAt(0).startOffset);
    return range.toString().length;
  };
  const placeCaret = (line: HTMLElement, offset: number) => {
    const selection = window.getSelection();
    const range = document.createRange();
    let left = offset;
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const length = node.textContent?.length || 0;
      if (left <= length) {
        range.setStart(node, left);
        range.collapse(true);
        selection?.removeAllRanges();
        selection?.addRange(range);
        return;
      }
      left -= length;
    }
    range.selectNodeContents(line);
    range.collapse(false);
    selection?.removeAllRanges();
    selection?.addRange(range);
  };
  function markLabel(line: HTMLElement) {
    line.classList.toggle("is-label", line.dataset.type === "p" && isLabelText(line.textContent || ""));
  }
  const setType = (line: HTMLElement, type: ScriptBlockType) => {
    line.dataset.type = type;
    markLabel(line);
  };
  const setIndent = (line: HTMLElement, change: number) => {
    line.dataset.indent = String(Math.max(0, Math.min(3, Number(line.dataset.indent || 0) + change)));
  };
  // Keep every piece of text inside a line block (browsers sometimes type straight into the editor).
  const normalize = () => {
    const editor = editorRef.current;
    if (!editor) return;
    [...editor.childNodes].forEach((node) => {
      if (node instanceof HTMLElement && node.classList.contains("se-line")) return;
      const line = blockElement("p", 0, "");
      line.replaceChildren();
      editor.insertBefore(line, node);
      line.appendChild(node);
    });
    if (!editor.querySelector(".se-line")) editor.appendChild(blockElement("p", 0, ""));
    setEmpty(!editor.textContent?.trim() && editor.querySelectorAll(".se-line").length === 1);
  };
  const onInput = () => {
    normalize();
    const line = currentLine();
    if (!line) return;
    if (line.dataset.type === "p") {
      const text = (line.textContent || "").replace(/\u00a0/g, " ");
      for (const [pattern, type, keep] of blockShortcuts) {
        const match = text.match(pattern);
        if (!match) continue;
        const offset = caretOffset(line);
        if (!keep) {
          line.innerHTML = inlineToHtml(text.slice(match[0].length)) || "<br>";
          setType(line, type);
          placeCaret(line, Math.max(0, offset - match[0].length));
        } else setType(line, type);
        return;
      }
    }
    markLabel(line);
  };
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const line = currentLine();
    if (!line) return;
    const type = (line.dataset.type || "p") as ScriptBlockType;
    const atStart = caretOffset(line) === 0 && (window.getSelection()?.isCollapsed ?? true);
    if (event.key === "Tab") {
      event.preventDefault();
      setIndent(line, event.shiftKey ? -1 : 1);
      return;
    }
    if (event.key === "Backspace" && atStart) {
      // Undo formatting first, then indentation, before joining with the line above.
      if (type !== "p") { event.preventDefault(); setType(line, "p"); return; }
      if (Number(line.dataset.indent || 0) > 0) { event.preventDefault(); setIndent(line, -1); return; }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      const isEmpty = !(line.textContent || "").trim();
      // Enter on an empty formatted line ends that format, like a word processor's lists.
      if (isEmpty && type !== "p") { setType(line, "p"); return; }
      const selection = window.getSelection();
      if (!selection?.rangeCount) return;
      const range = selection.getRangeAt(0);
      range.deleteContents();
      const tail = document.createRange();
      tail.setStart(range.startContainer, range.startOffset);
      tail.setEnd(line, line.childNodes.length);
      const moved = tail.extractContents();
      const next = blockElement(type === "li" ? "li" : "p", Number(line.dataset.indent || 0), "");
      if (moved.textContent) next.replaceChildren(moved);
      if (!line.textContent && !line.querySelector("br")) line.innerHTML = "<br>";
      // Enter at the very start of a formatted line pushes it down as-is and opens a plain line above.
      if (atStart && !isEmpty) {
        const above = blockElement("p", Number(line.dataset.indent || 0), "");
        line.replaceChildren(...[...next.childNodes]);
        line.parentElement!.insertBefore(above, line);
        placeCaret(line, 0);
        markLabel(line);
        return;
      }
      line.after(next);
      markLabel(line);
      markLabel(next);
      placeCaret(next, 0);
    }
  };
  const onPaste = (event: React.ClipboardEvent<HTMLDivElement>) => {
    event.preventDefault();
    const text = event.clipboardData.getData("text/plain");
    if (!text.includes("\n")) { document.execCommand("insertText", false, text); return; }
    // Several lines: paste them as blocks after the current line (into it, if it's empty).
    const line = currentLine();
    const blocks = parseScriptBlocks(text).map((block) => blockElement(block.type, block.indent, inlineToHtml(block.text)));
    blocks.forEach(markLabel);
    if (line && !(line.textContent || "").trim()) line.replaceWith(...blocks);
    else if (line) line.after(...blocks);
    else editorRef.current?.append(...blocks);
    placeCaret(blocks[blocks.length - 1], Number.MAX_SAFE_INTEGER);
    normalize();
  };
  const apply = (type: ScriptBlockType | "indent" | "outdent" | "bold") => {
    editorRef.current?.focus();
    if (type === "bold") return void document.execCommand("bold");
    const line = currentLine() || editorRef.current?.querySelector<HTMLElement>(".se-line:last-child");
    if (!line) return;
    if (type === "indent" || type === "outdent") return setIndent(line, type === "indent" ? 1 : -1);
    setType(line, line.dataset.type === type ? "p" : type);
  };
  const tools: [ScriptBlockType | "indent" | "outdent" | "bold", string, string][] = [
    ["section", "Section", "# "], ["sub", "Branch", "## "], ["say", "Say this", "> "], ["note", "Note", "Note: "],
    ["li", "List", "- "], ["p", "Text", ""], ["bold", "Bold", "Ctrl+B"], ["indent", "Indent", "Tab"], ["outdent", "Outdent", "Shift+Tab"],
  ];
  return (
    <div className="script-editor-wrap">
      <div className="script-editor__toolbar" role="toolbar" aria-label="Formatting">
        {tools.map(([type, label, hint]) => (
          <button type="button" key={type} title={hint ? `${label} (${hint})` : label} onMouseDown={(event) => event.preventDefault()} onClick={() => apply(type)}>{label}</button>
        ))}
      </div>
      <div
        ref={editorRef}
        className={`script-editor script${empty ? " is-empty" : ""}`}
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label="Script"
        spellCheck
        onInput={onInput}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        data-placeholder="Type your script. Start a line with # for a section, > for what you say, - for a list."
      />
      <small className="script-dialog__help">Shortcuts at the start of a line: <b># </b> section · <b>## </b> branch · <b>&gt; </b> say this · <b>- </b> list · <b>Note: </b> note · a short line ending in <b>:</b> is a label · Tab indents into a branch · [Name], [District Name] and [fact] fill in on calls</small>
    </div>
  );
}

// Add or edit a campaign's script: write it in the live editor and/or upload a PDF.
function ScriptDialog({ campaign, settings, onViewPdf, onClose, onChanged }: { campaign: string; settings: CampaignSettings; onViewPdf: () => void; onClose: () => void; onChanged: (message: string, close: boolean) => Promise<void> }) {
  const editorRef = useRef<HTMLDivElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);
  const run = async (work: () => Promise<unknown>, message: string, close: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      await onChanged(message, close);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the script.");
    } finally {
      setBusy(false);
    }
  };
  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = editorRef.current ? serializeScript(editorRef.current) : settings.script || "";
    void run(() => api("/api/campaigns/script", { method: "PUT", body: JSON.stringify({ campaign, script: text }) }), text.trim() ? `Script saved for ${campaign}.` : `Script removed from ${campaign}.`, true);
  };
  const upload = (file: File | undefined) => {
    if (!file) return;
    // Uploads are capped at 5 MB of text, and base64 adds a third.
    if (file.size > 3_500_000) return setError("That PDF is over 3.5 MB. Export a smaller one, or paste the script as text.");
    const reader = new FileReader();
    reader.onload = () => void run(() => api("/api/campaigns/script-pdf", { method: "POST", body: JSON.stringify({ campaign, fileName: file.name, data: String(reader.result).split(",")[1] || "" }) }), `${file.name} added to ${campaign}.`, false);
    reader.readAsDataURL(file);
  };
  return (
    <div className="modal-backdrop" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <form className="lead-form script-dialog" onSubmit={save} role="dialog" aria-modal="true" aria-labelledby="script-dialog-title">
        <button type="button" className="close-button" onClick={onClose} aria-label="Close"><X /></button>
        <h2 id="script-dialog-title">Script for {campaign}</h2>
        <p>Shows on the call screen for every lead in this campaign. Paste it as text, upload a PDF, or both.</p>
        {error && <p className="form-error" role="alert">{error}</p>}
        <ScriptEditor initial={settings.script || ""} editorRef={editorRef} />
        <div className="script-dialog__pdf">
          <FileText size={18} aria-hidden="true" />
          {settings.pdf ? (
            <>
              <span><b>{settings.pdf.name}</b><small>{Math.max(1, Math.round(settings.pdf.size / 1024))} KB</small></span>
              <button type="button" className="quiet-button" onClick={onViewPdf}>View</button>
              <label className="quiet-button script-dialog__file">Replace<input type="file" accept="application/pdf,.pdf" onChange={(event) => upload(event.target.files?.[0])} /></label>
              <button type="button" className="quiet-button" disabled={busy} onClick={() => void run(() => api(`/api/campaigns/script-pdf?campaign=${encodeURIComponent(campaign)}`, { method: "DELETE" }), `PDF removed from ${campaign}.`, false)}>Remove</button>
            </>
          ) : (
            <>
              <span><b>Script PDF</b><small>Optional. Opens in a viewer from the call screen</small></span>
              <label className="quiet-button script-dialog__file">Upload PDF<input type="file" accept="application/pdf,.pdf" onChange={(event) => upload(event.target.files?.[0])} /></label>
            </>
          )}
        </div>
        <div className="task-dialog__actions">
          <button type="button" className="quiet-button" onClick={onClose}>Cancel</button>
          <button className="primary-button" disabled={busy}>{busy ? "Saving…" : "Save script"}</button>
        </div>
      </form>
    </div>
  );
}

// The PDF's pages drawn with pdf.js, fitted to the column width: no browser toolbar or thumbnail sidebar.
function PdfPages({ campaign }: { campaign: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [error, setError] = useState("");
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)));
    if (box.current) observer.observe(box.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!width || !box.current) return;
    let cancelled = false;
    (async () => {
      const [pdfjs, worker] = await Promise.all([import("pdfjs-dist"), import("pdfjs-dist/build/pdf.worker.min.mjs?url")]);
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
      const pdf = await pdfjs.getDocument(`/api/campaigns/script-pdf?campaign=${encodeURIComponent(campaign)}`).promise;
      const canvases: HTMLCanvasElement[] = [];
      for (let number = 1; number <= pdf.numPages; number++) {
        const page = await pdf.getPage(number);
        const viewport = page.getViewport({ scale: (width / page.getViewport({ scale: 1 }).width) * devicePixelRatio });
        const canvas = document.createElement("canvas");
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        canvas.setAttribute("aria-label", `Page ${number} of ${pdf.numPages}`);
        await page.render({ canvas, viewport }).promise;
        if (cancelled) return;
        canvases.push(canvas);
      }
      if (!cancelled && box.current) box.current.replaceChildren(...canvases);
    })().catch(() => { if (!cancelled) setError("Couldn't show this PDF. Try opening it in a new tab."); });
    return () => { cancelled = true; };
  }, [campaign, width]);
  return <>{error && <p className="call-script__empty">{error}</p>}<div className="pdf-pages" ref={box} /></>;
}

// The campaign's script PDF, large enough to read during a call.
function PdfViewer({ campaign, name, onClose }: { campaign: string; name: string; onClose: () => void }) {
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);
  const src = `/api/campaigns/script-pdf?campaign=${encodeURIComponent(campaign)}`;
  return (
    <div className="modal-backdrop" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="pdf-viewer" role="dialog" aria-modal="true" aria-label={name}>
        <header>
          <b>{name}</b>
          <a className="quiet-button" href={src} target="_blank" rel="noreferrer"><ExternalLink size={16} aria-hidden="true" /> Open in a new tab</a>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </header>
        <div className="pdf-viewer__body"><PdfPages campaign={campaign} /></div>
      </div>
    </div>
  );
}

// Add, view and edit one task. Details live here and stay out of the list.
function TaskDialog({ task, leadId, leads, onSave, onDelete, onOpenLead, onClose }: { task?: Task; leadId?: string; leads: Lead[]; onSave: (fields: TaskFields, task?: Task) => Promise<void>; onDelete: (task: Task) => void; onOpenLead: (id: string) => void; onClose: () => void }) {
  const leadOption = (lead: Lead) => `${leadLabel(lead)} · ${lead.company}`;
  const linkedId = task?.leadId || leadId;
  const linked = linkedId ? leads.find((lead) => lead.id === linkedId) : undefined;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const leadText = String(form.get("lead") || "").trim();
    const lead = leadText ? leads.find((item) => leadOption(item) === leadText) : null;
    if (leadText && !lead) return setError("Pick the lead from the list, or leave it empty.");
    setBusy(true);
    setError(null);
    try {
      await onSave({ title: String(form.get("title") || ""), details: String(form.get("details") || ""), due: String(form.get("due") || ""), leadId: lead?.id || null }, task);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the task.");
      setBusy(false);
    }
  };
  return (
    <div className="modal-backdrop" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <form className="lead-form task-dialog" onSubmit={(event) => void submit(event)} role="dialog" aria-modal="true" aria-labelledby="task-dialog-title">
        <button type="button" className="close-button" onClick={onClose} aria-label="Close"><X /></button>
        <h2 id="task-dialog-title">{task ? "Task" : "Add a task"}</h2>
        {error && <p className="form-error" role="alert">{error}</p>}
        <label>What to do<input name="title" defaultValue={task?.title} placeholder="Email Andrea Lilley the NC math sample" maxLength={200} required autoFocus={!task} /></label>
        <label>Details<textarea name="details" defaultValue={task?.details} placeholder="Anything you need to remember: what was promised, links, who to ask for" rows={5} maxLength={4000} /></label>
        <label>Due<input name="due" type="datetime-local" defaultValue={/^\d{4}-\d{2}-\d{2}T/.test(task?.due || "") ? task!.due : ""} /></label>
        <label>Lead<input name="lead" defaultValue={linked ? leadOption(linked) : ""} placeholder="Optional. Start typing a name or district" list="task-dialog-leads" autoComplete="off" /></label>
        <datalist id="task-dialog-leads">{leads.map((lead) => <option key={lead.id} value={leadOption(lead)} />)}</datalist>
        <div className="task-dialog__actions">
          {task && <button type="button" className="quiet-button task-dialog__delete" onClick={() => onDelete(task)}><Trash2 size={16} aria-hidden="true" /> Delete</button>}
          {linked && task && <button type="button" className="quiet-button" onClick={() => onOpenLead(linked.id)}><Phone size={16} aria-hidden="true" /> Open lead</button>}
          <button className="primary-button" disabled={busy}>{busy ? "Saving…" : task ? "Save" : "Add task"}</button>
        </div>
      </form>
    </div>
  );
}

function Pipeline({
  leads,
  calls,
  onMove,
  onEdit,
  onCall,
  onAddTask,
}: {
  leads: Lead[];
  calls: CallRecord[];
  onMove: (lead: Lead, stage: string) => void;
  onEdit: (lead: Lead) => void;
  onCall: (id: string) => void;
  onAddTask: (lead: Lead) => void;
}) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [peekId, setPeekId] = useState<string | null>(null);
  const peek = leads.find((lead) => lead.id === peekId);
  const [over, setOver] = useState<string | null>(null);
  const won = leads.filter((lead) => lead.status === "Won").reduce((sum, lead) => sum + (lead.value || 0), 0);
  return (
    <section className="pipeline-page">
      <header className="pipeline-header">
        <p>Drag a lead to another stage, or click it for details. Logging a call moves it for you.</p>
        <div><strong>{leads.filter((lead) => lead.status === "Won").length} won</strong><small>{won ? `$${won.toLocaleString()} in deals` : `${leads.filter(inQueue).length} still open`}</small></div>
      </header>
      <div className="pipeline-board">
        {leadStages.map((stage) => {
          const items = leads.filter((lead) => lead.status === stage);
          return (
            <section
              key={stage}
              className={`pipeline-column${over === stage ? " is-over" : ""}`}
              onDragOver={(event) => { event.preventDefault(); setOver(stage); }}
              onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setOver(null); }}
              onDrop={(event) => {
                event.preventDefault();
                setOver(null);
                const lead = leads.find((item) => item.id === event.dataTransfer.getData("text/plain"));
                if (lead && lead.status !== stage) onMove(lead, stage);
              }}
            >
              <header>
                <b>{stage}</b><span>{items.length}</span>
                <p className="stage-legend" aria-label={`${stage} legend`}>{stageLegends[stage].map(([tone, label]) => <span key={label}><Dots tones={[tone]} />{label}</span>)}</p>
              </header>
              <div className="pipeline-cards">
                {items.map((lead) => (
                  <article
                    key={lead.id}
                    className={`pipeline-card${dragging === lead.id ? " is-dragging" : ""}`}
                    draggable
                    onDragStart={(event) => { event.dataTransfer.setData("text/plain", lead.id); event.dataTransfer.effectAllowed = "move"; setDragging(lead.id); }}
                    onDragEnd={() => setDragging(null)}
                    role="button"
                    tabIndex={0}
                    aria-label={`Details for ${leadLabel(lead)}`}
                    onClick={() => setPeekId(lead.id)}
                    onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setPeekId(lead.id); } }}
                  >
                    <b>{leadLabel(lead)}</b>
                    <small>{leadSubtitle(lead)}</small>
                    <span className="pipeline-card__meta">{formatPhone(lead.phone, lead.extension)}</span>
                    <StageLine lead={lead} calls={calls} />
                    {lead.campaigns?.length ? <span className="pipeline-card__meta">{lead.campaigns.join(", ")}</span> : null}
                  </article>
                ))}
                {!items.length && <p className="pipeline-empty">Drop a lead here</p>}
              </div>
            </section>
          );
        })}
      </div>
      {peek && <LeadPeek lead={peek} calls={calls} onClose={() => setPeekId(null)} onMove={onMove} onEdit={(lead) => { setPeekId(null); onEdit(lead); }} onCall={onCall} onAddTask={(lead) => { setPeekId(null); onAddTask(lead); }} />}
    </section>
  );
}

function Campaigns({ leads, onStart, onView, onStage, onImport, settings, onScript }: { leads: Lead[]; onStart: (name: string) => void; onView: (name: string) => void; onStage: (name: string) => void; onImport: () => void; settings: Record<string, CampaignSettings>; onScript: (name: string) => void }) {
  const names = campaignsOf(leads);
  const untagged = leads.filter((lead) => !lead.campaigns?.length).length;
  return (
    <section className="campaigns-page">
      <div className="campaigns-head">
        <p>Each CSV you import goes into a campaign. Pick one to call only its leads.</p>
        <button type="button" className={names.length ? "quiet-button" : "primary-button"} onClick={onImport}><FileUp size={16} aria-hidden="true" /> Import into a campaign</button>
      </div>
      {!names.length && <div className="empty-state">No campaigns yet. Import a CSV and give it a campaign name.</div>}
      <div className="campaign-list">
        {names.map((name) => {
          const items = leads.filter((lead) => lead.campaigns?.includes(name));
          const toCall = items.filter(inQueue).length;
          return (
            <article className="campaign-card" key={name}>
              <header><h2>{name}</h2><span>{items.length} lead{items.length === 1 ? "" : "s"}{settings[name]?.script || settings[name]?.pdf ? " · Script" : ""}</span></header>
              {/* One bar for the whole campaign: each stage's share of its leads, same colors as the counts below. */}
              <div className="campaign-bar" aria-hidden="true">
                {leadStages.map((stage) => { const count = items.filter((lead) => lead.status === stage).length; return count ? <i key={stage} className={`dot--${campaignStageTone[stage]}`} style={{ flexGrow: count }} /> : null; })}
              </div>
              <dl className="campaign-stages">
                {leadStages.map((stage) => <div key={stage}><dt><button type="button" className="stretch-link" onClick={() => onStage(name)} title={`Open ${name} on the pipeline`}><Dots tones={[campaignStageTone[stage]]} />{stage === "Meeting booked" ? "Meetings" : stage}</button></dt><dd>{items.filter((lead) => lead.status === stage).length}</dd></div>)}
              </dl>
              <div className="campaign-card__actions">
                <button type="button" className="text-link" onClick={() => onScript(name)}>{settings[name]?.script || settings[name]?.pdf ? "Script" : "Add script"}</button>
                <button type="button" className="text-link" onClick={() => onView(name)}>View leads</button>
                <button type="button" className="primary-button" disabled={!toCall} onClick={() => onStart(name)}><PhoneCall size={16} aria-hidden="true" /> Start calling ({toCall})</button>
              </div>
            </article>
          );
        })}
      </div>
      {untagged > 0 && names.length > 0 && <p className="campaigns-note">{untagged} lead{untagged === 1 ? " isn't" : "s aren't"} in a campaign. Add one when you edit a lead, or import the CSV again into a campaign.</p>}
    </section>
  );
}

type ImportTarget = "phone" | "name" | "company" | "role" | "state" | "note" | "stage";
const importTargets: { key: ImportTarget; label: string; hint: string; guesses: string[] }[] = [
  { key: "phone", label: "Phone", hint: "Required", guesses: ["phone", "phonenumber", "mainphone", "directphone", "telephone", "tel", "mobile", "cell", "number"] },
  { key: "name", label: "Contact name", hint: "Optional. Leave blank for front desks and gatekeepers", guesses: ["name", "fullname", "contact", "contactname", "person", "firstname", "superintendent", "principal", "leader", "owner"] },
  { key: "company", label: "Company / organization", hint: "Optional", guesses: ["company", "companyname", "organization", "organisation", "account", "accountname", "business", "district", "school", "agency"] },
  { key: "role", label: "Role or title", hint: "Optional", guesses: ["role", "title", "jobtitle", "position"] },
  { key: "state", label: "State / province", hint: "Optional. Sets the lead's local time and its spot on the dashboard map (US states, as NC or North Carolina)", guesses: ["state", "st", "province", "stateprovince", "stateorprovince", "statename", "region"] },
  { key: "note", label: "Notes", hint: "Optional. Becomes the lead note", guesses: ["notes", "note", "comments", "comment", "description"] },
  { key: "stage", label: "Pipeline stage", hint: "Optional. New, Follow-up, Meeting booked, Won or Lost; anything else starts as New", guesses: ["stage", "pipelinestage", "leadstage", "status", "leadstatus"] },
];

function parseCsv(source: string) {
  const text = source.replace(/^﻿/, "");
  const firstLine = text.split(/\r?\n/, 1)[0] || "";
  const delimiter = [",", ";", "\t"].reduce((best, candidate) => (firstLine.split(candidate).length > firstLine.split(best).length ? candidate : best), ",");
  const rows: string[][] = [];
  let cell = "";
  let row: string[] = [];
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else quoted = !quoted;
    } else if (character === delimiter && !quoted) {
      row.push(cell.trim());
      cell = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(cell.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = "";
    } else cell += character;
  }
  row.push(cell.trim());
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

function guessMapping(headers: string[], rows: string[][]) {
  const sample = rows.slice(0, 25);
  const words = headers.map((header) => header.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  const looksLikePhone = (value = "") => value.replace(/\D/g, "").length >= 7 && /^[\d\s()+.extEXT-]+$/.test(value);
  const share = (index: number, test: (value: string) => boolean) => {
    const values = sample.map((row) => row[index] || "").filter(Boolean);
    return values.length ? values.filter(test).length / values.length : 0;
  };
  const fits = (target: ImportTarget, index: number) =>
    target === "phone" ? share(index, looksLikePhone) >= 0.5 : ["name", "company", "role"].includes(target) ? share(index, (value) => /[a-z]{2}/i.test(value)) >= 0.5 : true;
  const matches = (target: (typeof importTargets)[number], index: number) => {
    const parts = words[index];
    if (target.guesses.includes(parts.join(""))) return true;
    if (parts.some((part) => ["id", "date", "count", "at", "on", "by"].includes(part))) return false;
    return parts.some((part, position) => target.guesses.includes(part) || target.guesses.includes(part + (parts[position + 1] || "")));
  };
  const used = new Set<number>();
  const mapping = {} as Record<ImportTarget, number | null>;
  for (const target of importTargets) {
    const found = headers.findIndex((_, index) => !used.has(index) && matches(target, index) && fits(target.key, index));
    mapping[target.key] = found >= 0 ? found : null;
    if (found >= 0) used.add(found);
  }
  if (mapping.phone === null) {
    const phoneLike = headers.findIndex((_, index) => !used.has(index) && share(index, looksLikePhone) >= 0.6);
    if (phoneLike >= 0) {
      mapping.phone = phoneLike;
      used.add(phoneLike);
    }
  }
  if (mapping.company === null && mapping.name === null) {
    const textColumn = headers.findIndex((_, index) => !used.has(index) && share(index, (value) => /[a-z]{3}/i.test(value) && value.length > 3) >= 0.8 && new Set(sample.map((row) => row[index])).size > Math.min(5, sample.length / 2));
    if (textColumn >= 0) mapping.company = textColumn;
  }
  return mapping;
}

function ImportLeads({ campaigns, defaultCampaign, requireCampaign, onClose, onSaved }: { campaigns: string[]; defaultCampaign: string; requireCampaign: boolean; onClose: () => void; onSaved: (message: string, campaign: string) => Promise<void> }) {
  const [campaign, setCampaign] = useState(defaultCampaign);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<Record<ImportTarget, number | null> | null>(null);
  const [keepOthers, setKeepOthers] = useState(true);
  const [cleanPhones, setCleanPhones] = useState(true);
  const readFile = async (file: File | undefined) => {
    setError(null);
    setMapping(null);
    if (!file) return;
    setFileName(file.name);
    const parsed = parseCsv(await file.text());
    if (parsed.length < 2) return setError("This file needs a header row and at least one lead row.");
    // Spreadsheet exports often put title/summary rows above the real header: use the first well-filled row.
    const filled = parsed.slice(0, 20).map((row) => row.filter(Boolean).length);
    const headerIndex = filled.findIndex((count) => count >= Math.max(2, Math.max(...filled) * 0.6));
    const [head, ...body] = parsed.slice(Math.max(0, headerIndex));
    if (!body.length) return setError("This file needs a header row and at least one lead row.");
    const width = Math.max(...parsed.map((row) => row.length));
    const names = Array.from({ length: width }, (_, index) => head[index] || `Column ${index + 1}`);
    setHeaders(names);
    setRows(body);
    setMapping(guessMapping(names, body));
  };
  const mapped = new Set(Object.values(mapping || {}).filter((value): value is number => value !== null));
  const others = headers.map((header, index) => ({ header, index })).filter(({ index }) => !mapped.has(index));
  const shown = importTargets.filter((target) => mapping?.[target.key] != null);
  const cell = (row: string[], target: ImportTarget) => (mapping?.[target] == null ? "" : row[mapping[target] as number] || "");
  const buildLeads = () =>
    rows.map((row) => ({
      ...(cleanPhones ? normalizePhone(cell(row, "phone")) : { phone: cell(row, "phone"), extension: "" }),
      name: cell(row, "name"),
      company: cell(row, "company"),
      role: cell(row, "role"),
      timezone: "",
      note: cell(row, "note"),
      stage: cell(row, "stage"),
      details: {
        ...(keepOthers ? Object.fromEntries(others.map(({ header, index }) => [header, row[index] || ""]).filter(([, text]) => text)) : {}),
        // Saved under one name whatever the column was called, so local time and the map always find it.
        ...(cell(row, "state") ? { State: cell(row, "state") } : {}),
      },
    }));
  const unreadable = cleanPhones && mapping?.phone != null ? rows.map((row) => cell(row, "phone")).filter((value) => value.replace(/\D/g, "").length >= 7 && !normalizePhone(value).ok) : [];
  const shownCell = (row: string[], target: ImportTarget) => {
    if (target === "state" && cell(row, "state")) {
      const zone = leadZone({ details: { State: cell(row, "state") } } as unknown as Lead);
      return `${cell(row, "state")} · ${zone ? `${localTime(zone.zone)} there` : "not recognized"}`;
    }
    if (target !== "phone" || !cleanPhones) return cell(row, target);
    const result = normalizePhone(cell(row, "phone"));
    return result.ok ? formatPhone(result.phone, result.extension) : cell(row, "phone");
  };
  const withPhone = mapping?.phone == null ? 0 : rows.filter((row) => cell(row, "phone").replace(/\D/g, "").length >= 7).length;
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!mapping) return setError("Choose a CSV file first.");
    if (mapping.phone === null) return setError("Pick which column holds the phone number.");
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ imported: number; duplicates: number; invalid: number; tagged: number }>("/api/leads/import", { method: "POST", body: JSON.stringify({ leads: buildLeads(), campaign }) });
      const skipped = [result.duplicates && `${result.duplicates} already in the workspace${result.tagged ? ` (${result.tagged} added to ${campaign.trim()})` : ""}`, result.invalid && `${result.invalid} without a usable phone number`].filter(Boolean).join(", ");
      await onSaved(result.imported === 0 && result.tagged
        ? `Added ${result.tagged} leads already in your workspace to ${campaign.trim()}.`
        : `${result.imported} lead${result.imported === 1 ? "" : "s"} imported${campaign.trim() ? ` into ${campaign.trim()}` : ""}${skipped ? `. Skipped ${skipped}` : ""}.`, campaign.trim());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not import this CSV.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="modal-backdrop">
      <form className={mapping ? "lead-form import-form import-form--mapping" : "lead-form import-form"} onSubmit={submit} role="dialog" aria-modal="true" aria-labelledby="import-leads-title">
        <button type="button" className="close-button" onClick={onClose} aria-label="Close"><X /></button>
        <h2 id="import-leads-title">Import leads</h2>
        <p>Any CSV works. Pick the file, then tell Open Dialer v2 which column is which. Only a phone number is required.</p>
        {error && <p className="form-error" role="alert">{error}</p>}
        <label>Campaign{requireCampaign && <small>Required</small>}<input value={campaign} onChange={(event) => setCampaign(event.target.value)} placeholder="NC school districts" list="campaign-options" autoComplete="off" required={requireCampaign} autoFocus={requireCampaign && !campaign} /></label>
        <datalist id="campaign-options">{campaigns.map((name) => <option key={name} value={name} />)}</datalist>
        <label>CSV file<input type="file" accept=".csv,.tsv,.txt,text/csv" onChange={(event) => void readFile(event.target.files?.[0])} /></label>
        {mapping && (
          <>
            <div className="import-mapping">
              {importTargets.map((target) => (
                <label key={target.key}>
                  <span>{target.label} <small>{target.hint}</small></span>
                  <select value={mapping[target.key] ?? ""} onChange={(event) => setMapping({ ...mapping, [target.key]: event.target.value === "" ? null : Number(event.target.value) })}>
                    <option value="">{target.key === "phone" ? "Choose a column…" : "Not in this file"}</option>
                    {headers.map((header, index) => <option key={index} value={index}>{header}</option>)}
                  </select>
                  {mapping[target.key] != null && (
                    <small className="import-example">e.g. {rows.find((row) => row[mapping[target.key] as number])?.[mapping[target.key] as number] || "empty column"}</small>
                  )}
                </label>
              ))}
            </div>
            <label className="import-keep">
              <input type="checkbox" checked={cleanPhones} onChange={(event) => setCleanPhones(event.target.checked)} />
              <span>Clean up phone numbers <small>(saved as +13365706060 and shown as (336) 570-6060; extensions like "ext. 10257" are saved separately and dialed after the call connects)</small></span>
            </label>
            {others.length > 0 && (
              <label className="import-keep">
                <input type="checkbox" checked={keepOthers} onChange={(event) => setKeepOthers(event.target.checked)} />
                <span>Keep the other {others.length} columns as lead details <small>({others.map(({ header }) => header).join(", ")})</small></span>
              </label>
            )}
            {shown.length > 0 && (
              <div className="import-preview" aria-label="Import preview">
                <table>
                  <thead><tr>{shown.map((target) => <th key={target.key}>{target.label}</th>)}</tr></thead>
                  <tbody>{rows.slice(0, 4).map((row, rowIndex) => <tr key={rowIndex}>{shown.map((target) => <td key={target.key}>{shownCell(row, target.key) || "—"}</td>)}</tr>)}</tbody>
                </table>
              </div>
            )}
            <p className="import-summary">{fileName}: {rows.length} rows, {withPhone} with a phone number{rows.length - withPhone ? `. ${rows.length - withPhone} will be skipped` : ""}.{unreadable.length > 0 && ` ${unreadable.length} number${unreadable.length === 1 ? "" : "s"} couldn't be read and will be kept as written: ${unreadable.slice(0, 3).join(", ")}${unreadable.length > 3 ? "…" : ""}`}</p>
          </>
        )}
        <button className="primary-button" disabled={busy || !mapping || mapping.phone === null}>{busy ? "Importing…" : <><FileUp size={17} /> {mapping ? `Import ${withPhone} leads` : "Import leads"}</>}</button>
      </form>
    </div>
  );
}

function DncList({ onClose, onSaved }: { onClose: () => void; onSaved: (message: string) => Promise<void> }) {
  const [numbers, setNumbers] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => { event.preventDefault(); setBusy(true); setError(null); try { const result = await api<{ suppressed: number; matched: number }>("/api/dnc", { method: "POST", body: JSON.stringify({ numbers: numbers.split(/[\n,;]+/).map((item) => item.trim()).filter(Boolean) }) }); await onSaved(`${result.suppressed} numbers added to DNC; ${result.matched} existing leads suppressed.`); } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not update the DNC list."); } finally { setBusy(false); } };
  return <div className="modal-backdrop"><form className="lead-form" onSubmit={submit} role="dialog" aria-modal="true" aria-labelledby="dnc-list-title"><button type="button" className="close-button" onClick={onClose} aria-label="Close"><X /></button><h2 id="dnc-list-title">Do-not-call list</h2><p>Paste one phone number per line. Matching leads are immediately suppressed.</p>{error && <p className="form-error" role="alert">{error}</p>}<label>Phone numbers<textarea value={numbers} onChange={(event) => setNumbers(event.target.value)} placeholder={"+15551234567\n+15557654321"} required /></label><button className="primary-button" disabled={busy}>{busy ? "Saving…" : "Suppress numbers"}</button></form></div>;
}

function CallOutcome({ lead, bookingUrl, onBook, onClose, onSaved }: { lead: Lead; bookingUrl: string; onBook: () => void; onClose: () => void; onSaved: (outcome: string) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState("");
  const [followUpAt, setFollowUpAt] = useState("");
  // A dropped voicemail gets a follow-up two business days out at 10:00, unless a time is already set.
  const pickOutcome = (value: string) => {
    setOutcome(value);
    if (value !== "Voicemail" || followUpAt) return;
    const date = new Date();
    for (let added = 0; added < 2; ) {
      date.setDate(date.getDate() + 1);
      if (date.getDay() !== 0 && date.getDay() !== 6) added += 1;
    }
    setFollowUpAt(`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}T10:00`);
  };
  // A callback or a meeting without a time never becomes a task, so those two need one.
  const needsDate = outcome === "Callback" || outcome === "Meeting booked";
  const submit = async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); setBusy(true); setError(null); const form = new FormData(event.currentTarget); try { await api("/api/calls/record", { method: "POST", body: JSON.stringify({ leadId: lead.id, outcome: form.get("outcome"), note: form.get("note"), followUpAt: form.get("followUpAt") }) }); await onSaved(String(form.get("outcome"))); } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save this call outcome."); } finally { setBusy(false); } };
  return (
    <div className="modal-backdrop">
      <form className="lead-form" onSubmit={submit} role="dialog" aria-modal="true" aria-labelledby="outcome-title">
        <button type="button" className="close-button" onClick={onClose} aria-label="Close"><X /></button>
        <h2 id="outcome-title">Log call outcome</h2>
        <p>Record the result for {leadLabel(lead)}. This updates the lead and call history, then moves you to the next lead.</p>
        {error && <p className="form-error" role="alert">{error}</p>}
        <label>Outcome<select name="outcome" value={outcome} onChange={(event) => pickOutcome(event.target.value)} required><option value="" disabled>Choose what happened…</option><option>Interested</option><option>Meeting booked</option><option>Callback</option><option>Maybe later</option><option>No answer</option><option>Busy</option><option>Voicemail</option><option>Not interested</option><option>Wrong number</option><option>Do not call</option></select></label>
        {outcome === "Meeting booked" && (bookingUrl
          ? <button type="button" className="quiet-button outcome-book" onClick={onBook}><CalendarPlus size={16} aria-hidden="true" /> Open your booking page</button>
          : <p className="outcome-hint">Add your Calendly or Cal.com link in Settings to book from here.</p>)}
        <label>{outcome === "Meeting booked" ? "Meeting date and time" : outcome === "Callback" ? "Call back on" : outcome === "Voicemail" ? "Follow up on" : "Follow-up date and time"}{needsDate && <small>Required</small>}<input name="followUpAt" type="datetime-local" required={needsDate} value={followUpAt} onChange={(event) => setFollowUpAt(event.target.value)} /></label>
        <label>Notes<textarea name="note" placeholder="What happened on this call?" /></label>
        <button className="primary-button" disabled={busy}>{busy ? "Saving…" : "Save outcome"}</button>
      </form>
    </div>
  );
}

function ActivityLog({ activity, leads, onOpenLead }: { activity: State["activity"]; leads: Lead[]; onOpenLead: (id: string) => void }) {
  // Log lines about a lead start with its name ("Dr. Aaron Fleming · Follow-up").
  // shortcut: matched by name, so two leads with the same name open the first; store the lead id on events if that matters.
  const byLabel = new Map<string, Lead>();
  for (const lead of leads) if (!byLabel.has(leadLabel(lead))) byLabel.set(leadLabel(lead), lead);
  return (
    <section className="activity-log">
      {activity.map((event) => {
        const lead = byLabel.get(event.detail.split(" · ")[0]);
        return (
        <article key={event.id}>
          <span className="activity-mark">
            <ClipboardList size={18} />
          </span>
          <div>
            <h2>{event.action}</h2>
            <p>{lead ? <button type="button" className="text-link" onClick={() => onOpenLead(lead.id)}>{event.detail}</button> : event.detail}</p>
          </div>
          <time>{event.at}</time>
        </article>
        );
      })}
    </section>
  );
}

type GuideTarget = "settings" | "leads" | "queue";

function setupSteps(state: State) {
  const realCalls = state.calls.filter((call) => call.outcome !== "In progress" || "sid" in call);
  return [
    { done: Boolean(state.connection), title: "Connect your Twilio account", body: "Settings → Phone numbers: enter your Account SID and Auth Token. They're checked and stored encrypted on the server.", target: "settings" as GuideTarget, action: "Open Settings" },
    { done: Boolean(state.connection?.selectedNumber), title: "Pick the number leads will see", body: "After connecting, choose one of your Twilio numbers as the caller ID.", target: "settings" as GuideTarget, action: "Open Settings" },
    { done: true, title: "Choose how you take calls", body: "By default you talk in this app with your microphone and speaker (a headset works best). You can switch to Zoiper or your phone in Settings.", target: "settings" as GuideTarget, action: "Open Settings" },
    { done: Boolean(state.callbackReachable), title: "Let Twilio reach this app", body: "Works automatically when the app runs on its own web address. On your computer, start a tunnel (for example cloudflared) and put its address in OPEN_DIALER_PUBLIC_URL in .env, then restart.", target: null, action: "" },
    { done: state.leads.length > 0, title: "Add your leads", body: "Import any CSV and match its columns, or add leads one at a time. Only a phone number is required.", target: "leads" as GuideTarget, action: "Open Leads" },
    { done: realCalls.length > 0, title: "Make your first call", body: "Open the Dashboard, pick a lead, and press Call. Log the outcome afterwards to move to the next lead.", target: "queue" as GuideTarget, action: "Open Dashboard" },
  ];
}

function SetupGuide({ state, onClose, onGo }: { state: State; onClose: () => void; onGo: (target: GuideTarget) => void }) {
  const steps = setupSteps(state);
  const done = steps.filter((step) => step.done).length;
  return (
    <div className="modal-backdrop">
      <section className="lead-form setup-guide" role="dialog" aria-modal="true" aria-labelledby="setup-guide-title">
        <button type="button" className="close-button" onClick={onClose} aria-label="Close"><X /></button>
        <h2 id="setup-guide-title">Setup guide</h2>
        <p>{done === steps.length ? "Everything is set up. You're ready to call." : `${done} of ${steps.length} done. Each step updates on its own once it's finished.`}</p>
        <div className="dash-progress setup-guide__progress"><span><i style={{ width: `${Math.round((done / steps.length) * 100)}%` }} /></span></div>
        <ol className="setup-steps">
          {steps.map((step, index) => (
            <li key={step.title} className={step.done ? "is-done" : undefined}>
              <span className="setup-steps__mark" aria-hidden="true">{step.done ? <Check size={14} /> : index + 1}</span>
              <div>
                <b>{step.title}<span className="sr-only">{step.done ? " (done)" : " (to do)"}</span></b>
                <small>{step.body}</small>
              </div>
              {!step.done && step.target && <button type="button" className="quiet-button" onClick={() => onGo(step.target!)}>{step.action}</button>}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

function Settings({
  me,
  workspace,
  team,
  emailReady,
  companies,
  onSignOut,
  connection,
  bookingUrl,
  onRefresh,
  onNotice,
}: {
  me: Member;
  workspace: { id: string; name: string };
  team: Member[];
  emailReady: boolean;
  companies: { id: string; name: string; people: Member[] }[];
  onSignOut: () => void;
  connection: Connection | null;
  bookingUrl: string;
  onRefresh: () => Promise<unknown>;
  onNotice: (message: string) => void;
}) {
  const [accountSid, setAccountSid] = useState("");
  const [authToken, setAuthToken] = useState("");
  const [numbers, setNumbers] = useState<NumberOption[]>([]);
  const [selected, setSelected] = useState<NumberOption | null>(null);
  const [busy, setBusy] = useState(false);
  const [answerOn, setAnswerOn] = useState<"browser" | "voip" | "sim">(usesAppPhone(connection) ? "browser" : connection!.bridgeNumber!.startsWith("sip:") ? "voip" : "sim");
  const [bridgeNumber, setBridgeNumber] = useState(usesAppPhone(connection) ? "" : (connection?.bridgeNumber || "").replace(/^sip:/i, ""));
  const owner = me.role === "owner";
  const [area, setArea] = useState<SettingsArea>(owner ? "calling" : "account");
  const [page, setPage] = useState<SettingsPage>(owner ? "numbers" : "profile");
  const validate = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await api<{ numbers: NumberOption[] }>(
        "/api/twilio/validate",
        { method: "POST", body: JSON.stringify({ accountSid, authToken }) },
      );
      setNumbers(result.numbers);
      setSelected(result.numbers[0] || null);
      onNotice(
        result.numbers.length
          ? "Credentials checked. Choose the outbound number to save."
          : "Connected, but no voice-capable numbers were returned.",
      );
    } catch (error) {
      onNotice(
        error instanceof Error
          ? error.message
          : "Could not validate the connection.",
      );
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      await api("/api/twilio/connection", {
        method: "POST",
        body: JSON.stringify({ accountSid, authToken, number: selected }),
      });
      setAuthToken("");
      await onRefresh();
      onNotice("Twilio connection saved with encrypted credentials.");
    } catch (error) {
      onNotice(
        error instanceof Error
          ? error.message
          : "Could not save the connection.",
      );
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    try {
      await api("/api/twilio/connection", { method: "DELETE" });
      await onRefresh();
      onNotice("Telephony connection removed.");
    } catch (error) {
      onNotice(
        error instanceof Error
          ? error.message
          : "Could not remove the connection.",
      );
    }
  };
  const saveBridge = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await api("/api/twilio/connection", { method: "PATCH", body: JSON.stringify({ bridgeNumber: answerOn === "browser" ? "browser" : answerOn === "voip" ? `sip:${bridgeNumber.trim().replace(/^sip:/i, "")}` : bridgeNumber }) });
      await onRefresh();
      onNotice(answerOn === "browser" ? "Saved. You'll talk through this app's microphone and speaker." : answerOn === "voip" ? "Saved. Zoiper will ring first; answer it and the lead is dialed." : "Saved. Your phone will ring first; answer it and the lead is dialed.");
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "Could not save the calling bridge.");
    } finally {
      setBusy(false);
    }
  };
  const selectPage = (nextArea: SettingsArea, nextPage: SettingsPage) => {
    setArea(nextArea);
    setPage(nextPage);
  };
  const sections: Record<SettingsArea, { id: SettingsPage; label: string; icon: typeof Phone }[]> = {
    calling: [
      { id: "numbers", label: "Phone numbers", icon: Phone },
    ],
    workspace: [
      { id: "team", label: "Team", icon: Users },
      { id: "fields", label: "Custom fields", icon: SlidersHorizontal },
      { id: "booking", label: "Booking link", icon: CalendarPlus },
      ...(me.admin ? [{ id: "companies" as const, label: "Companies", icon: Building2 }] : []),
    ],
    account: [
      { id: "profile", label: "Profile", icon: UserRound },
      { id: "privacy", label: "Privacy", icon: ShieldCheck },
    ],
  };
  return (
    <section className="settings-page">
      <div className="settings-tabs" role="tablist" aria-label="Settings sections">
        {((owner ? ["calling", "workspace", "account"] : ["account"]) as SettingsArea[]).map((item) => (
          <button key={item} type="button" role="tab" aria-selected={area === item} className={area === item ? "is-active" : ""} onClick={() => selectPage(item, sections[item][0].id)}>
            {item}
          </button>
        ))}
      </div>
      <div className="settings-layout">
        <aside className="settings-nav" aria-label={`${area} settings`}>
          <span>{area} settings</span>
          {sections[area].map((item) => (
            <button key={item.id} type="button" className={page === item.id ? "is-active" : ""} onClick={() => setPage(item.id)}><item.icon size={16} aria-hidden="true" />{item.label}</button>
          ))}
        </aside>
        <div className="settings-content">
        {page === "numbers" ? (
          <section className="settings-grid">
      <article className="settings-card connection-card">
        <div>
          <span className="panel-kicker">Telephony</span>
          <h2>Your Twilio connection</h2>
          <p>
            Credentials travel directly to the Open Dialer v2 server for validation.
            The Auth Token is never returned to the browser and is encrypted
            before it is stored.
          </p>
        </div>
        {connection ? (
          <div className="connection-summary">
            <Status tone="good">
              <Check size={14} /> Connected
            </Status>
            <dl>
              <div>
                <dt>Account</dt>
                <dd>{connection.accountSid.slice(0, 6)}••••••••</dd>
              </div>
              <div>
                <dt>Outbound number</dt>
                <dd>{connection.selectedNumber}</dd>
              </div>
              <div>
                <dt>You answer on</dt>
                <dd>{usesAppPhone(connection) ? "This app (microphone and speaker)" : connection.bridgeNumber!.startsWith("sip:") ? `Calling app (${connection.bridgeNumber!.slice(4)})` : `Phone ${connection.bridgeNumber}`}</dd>
              </div>
            </dl>
            <AccountCheck />
            <form className="bridge-form" onSubmit={saveBridge}>
              <label>
                How will you take calls?
                <select value={answerOn} onChange={(event) => { setAnswerOn(event.target.value as "browser" | "voip" | "sim"); setBridgeNumber(""); }}>
                  <option value="browser">In this app (microphone and speaker)</option>
                  <option value="voip">On a calling app like Zoiper (VoIP)</option>
                  <option value="sim">On my phone (SIM card)</option>
                </select>
              </label>
              {answerOn === "browser" ? (
                <p className="bridge-form__hint">Press Call and talk straight away through your headset or computer's microphone and speaker. Your browser asks for microphone access the first time.</p>
              ) : (
              <label>
                {answerOn === "voip" ? "Your Zoiper address" : "Your phone number"}
                <input
                  value={bridgeNumber}
                  onChange={(event) => setBridgeNumber(event.target.value)}
                  placeholder={answerOn === "voip" ? "bayu@yourname.sip.twilio.com" : "+62 812 3456 7890"}
                  inputMode={answerOn === "voip" ? "email" : "tel"}
                  autoComplete="off"
                  spellCheck={false}
                  required
                />
                <small>
                  {answerOn === "voip"
                    ? "In Zoiper, open Settings → Accounts. It's your username and domain joined with @. Keep Zoiper open while you call."
                    : "Include the country code, like +62 for Indonesia. Your phone rings first; answer it and the lead is dialed."}
                </small>
              </label>
              )}
              <button className="primary-button" type="submit" disabled={busy}>Save</button>
            </form>
            <button className="quiet-button danger-button" onClick={remove}>
              Remove connection
            </button>
          </div>
        ) : (
          <form onSubmit={validate}>
            <label>
              Account SID
              <input
                value={accountSid}
                onChange={(event) => setAccountSid(event.target.value)}
                placeholder="AC…"
                autoComplete="off"
                required
              />
            </label>
            <label>
              Auth Token
              <input
                type="password"
                value={authToken}
                onChange={(event) => setAuthToken(event.target.value)}
                placeholder="Your token stays server-side"
                autoComplete="new-password"
                required
              />
            </label>
            <button className="primary-button" type="submit" disabled={busy}>
              {busy ? (
                <LoaderCircle className="spin" size={17} />
              ) : (
                <ShieldCheck size={17} />
              )}{" "}
              Validate securely
            </button>
          </form>
        )}
      </article>
      <article className="settings-card">
        <span className="panel-kicker">Outbound line</span>
        <h2>Select an existing number</h2>
        <p>
          Open Dialer v2 only lists numbers already owned by the connected Twilio
          account. It never purchases numbers.
        </p>
        {numbers.length > 0 ? (
          <>
            <div className="number-list">
              {numbers.map((number) => (
                <label
                  key={number.sid}
                  className={
                    selected?.sid === number.sid
                      ? "number-option is-selected"
                      : "number-option"
                  }
                >
                  <input
                    type="radio"
                    name="number"
                    checked={selected?.sid === number.sid}
                    onChange={() => setSelected(number)}
                  />
                  <span>
                    <b>{number.label}</b>
                    <small>{number.number}</small>
                  </span>
                </label>
              ))}
            </div>
            <button
              className="call-button"
              disabled={busy || !selected}
              onClick={save}
            >
              Save selected number
            </button>
          </>
        ) : (
          <div className="empty-state">
            <Phone size={22} />
            <span>
              Validate a Twilio account to list eligible voice numbers here.
            </span>
          </div>
        )}
      </article>
      <article className="settings-card settings-card--wide">
        <span className="panel-kicker">Production checklist</span>
        <div className="checklist">
          <span>
            <Check /> Set <code>OPEN_DIALER_ENCRYPTION_KEY</code> in Dokploy
          </span>
          <span>
            <Check /> Save the phone number that should ring before each outbound call
          </span>
          <span>
            <Check /> Invite your callers under Workspace, Team
          </span>
        </div>
      </article>
          </section>
        ) : (
          <SettingsPanel page={page} me={me} workspace={workspace} team={team} emailReady={emailReady} companies={companies} onSignOut={onSignOut} connection={connection} onNotice={onNotice} bookingUrl={bookingUrl} onRefresh={onRefresh} />
        )}
        </div>
      </div>
    </section>
  );
}

// Shows Twilio's own explanation for a failed call (read from its alerts log).
function TwilioWhy({ callId }: { callId: string }) {
  const [state, setState] = useState<{ busy: boolean; alerts?: { code: string; message: string; moreInfo: string }[]; error?: string }>({ busy: false });
  useEffect(() => setState({ busy: false }), [callId]);
  const ask = async () => {
    setState({ busy: true });
    try {
      const result = await api<{ alerts: { code: string; message: string; moreInfo: string }[] }>(`/api/calls/${callId}/why`);
      setState({ busy: false, alerts: result.alerts });
    } catch (cause) {
      setState({ busy: false, error: cause instanceof Error ? cause.message : "Could not ask Twilio." });
    }
  };
  return (
    <div className="twilio-why">
      <button type="button" onClick={() => void ask()} disabled={state.busy}>{state.busy ? "Asking Twilio…" : state.alerts ? "Ask again" : "Ask Twilio why"}</button>
      {state.error && <p>{state.error}</p>}
      {state.alerts && (state.alerts.length
        ? state.alerts.map((alert, index) => <p key={index}><b>Twilio {alert.code}:</b> {alert.message}{alert.moreInfo && <> (<a href={alert.moreInfo} target="_blank" rel="noreferrer">details</a>)</>}</p>)
        : <p>Twilio has no alert for this call yet. Alerts can take a minute to appear; try again shortly.</p>)}
    </div>
  );
}

type AccountCheckResult = {
  account: { type?: string; status?: string; name?: string; error?: string };
  verifiedNumbers: { numbers?: string[]; error?: string };
  countries: Record<"US", { allowed?: boolean; error?: string }>;
};

// Read-only check of the connected Twilio account, for people who have its credentials but no Console access.
function AccountCheck() {
  const [result, setResult] = useState<AccountCheckResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setResult(await api<AccountCheckResult>("/api/twilio/account-check"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not check the account.");
    } finally {
      setBusy(false);
    }
  };
  const trial = result?.account.type === "Trial";
  const country = (code: "US", name: string) => {
    const item = result?.countries[code];
    return <li key={code}><b>Calls to {name}</b><span>{item?.error ? `Couldn't read (${item.error})` : item?.allowed ? "Allowed" : "Not allowed. Ask the account owner to enable it under Voice → Settings → Geographic permissions"}</span></li>;
  };
  return (
    <section className="account-check" aria-label="Calling account check">
      <div className="account-check__head">
        <b>Calling account check</b>
        <button type="button" className="quiet-button" onClick={() => void run()} disabled={busy}>{busy ? "Checking…" : result ? "Check again" : "Check account"}</button>
      </div>
      <p>Looks up whether this Twilio account can call US numbers. Read-only: nothing in the account is changed.</p>
      {error && <p className="form-error" role="alert">{error}</p>}
      {result && (
        <ul>
          <li>
            <b>Account type</b>
            <span>{result.account.error ? `Couldn't read (${result.account.error})` : `${result.account.type}${result.account.status && result.account.status !== "active" ? ` (${result.account.status})` : ""}${trial ? ". Trial accounts can only call the verified numbers below." : ". Can call any number its permissions allow."}`}</span>
          </li>
          <li>
            <b>Verified caller IDs</b>
            <span>{result.verifiedNumbers.error ? `Couldn't read (${result.verifiedNumbers.error})` : trial
              ? (result.verifiedNumbers.numbers?.length ? `${result.verifiedNumbers.numbers.join(", ")}. On a trial account these are the only numbers you can call.` : "None. On a trial account no number can be called until the owner verifies one.")
              : `${result.verifiedNumbers.numbers?.length ? `${result.verifiedNumbers.numbers.join(", ")}. ` : ""}Not needed on a full account: these are other numbers the company may show as caller ID, not a limit on who you can call.`}</span>
          </li>
          {country("US", "the US")}
        </ul>
      )}
    </section>
  );
}

function SettingsPanel({
  page,
  me,
  workspace,
  team,
  emailReady,
  companies,
  onSignOut,
  connection,
  onNotice,
  bookingUrl,
  onRefresh,
}: {
  page: Exclude<SettingsPage, "numbers">;
  me: Member;
  workspace: { id: string; name: string };
  team: Member[];
  emailReady: boolean;
  companies: { id: string; name: string; people: Member[] }[];
  onSignOut: () => void;
  connection: Connection | null;
  onNotice: (message: string) => void;
  bookingUrl: string;
  onRefresh: () => Promise<unknown>;
}) {
  const [booking, setBooking] = useState(bookingUrl);

  const [fieldName, setFieldName] = useState("");
  const [fields, setFields] = useState<string[]>(() => JSON.parse(localStorage.getItem("open-dialer-lead-fields") || "[]"));

  if (page === "booking") {
    const save = async (event: FormEvent) => {
      event.preventDefault();
      try {
        await api("/api/settings", { method: "PATCH", body: JSON.stringify({ bookingUrl: booking }) });
        await onRefresh();
        onNotice(booking.trim() ? "Booking link saved. Book a call opens it during a call." : "Booking link removed.");
      } catch (error) {
        onNotice(error instanceof Error ? error.message : "Couldn't save the booking link.");
      }
    };
    return (
      <section className="settings-panel">
        <h2>Booking link</h2>
        <p>Paste your Calendly or Cal.com scheduling link. During a call, Book a call opens it so you can pick a time with the lead.</p>
        <form className="settings-form" onSubmit={save}>
          <label>
            Calendly or Cal.com link
            <input value={booking} onChange={(event) => setBooking(event.target.value)} placeholder="https://calendly.com/your-name/30min" inputMode="url" autoComplete="off" spellCheck={false} />
          </label>
          <div className="settings-form-actions">
            <button className="primary-button" type="submit">Save booking link</button>
            {bookingUrl && <button type="button" className="quiet-button" onClick={() => openBooking(bookingUrl, "").catch((error) => onNotice(error instanceof Error ? error.message : "Couldn't open the booking page."))}>Preview</button>}
          </div>
        </form>
      </section>
    );
  }
  if (page === "team") return <TeamSettings me={me} workspace={workspace} team={team} emailReady={emailReady} onRefresh={onRefresh} onNotice={onNotice} />;
  if (page === "companies") return <CompaniesSettings companies={companies} emailReady={emailReady} onRefresh={onRefresh} onNotice={onNotice} />;
  if (page === "fields") {
    return <section className="settings-panel"><span className="panel-kicker">Workspace</span><h2>Custom fields</h2><p>Capture the fields your team actually needs on every lead.</p><form className="inline-form" onSubmit={(event) => { event.preventDefault(); const value = fieldName.trim(); if (!value || fields.includes(value)) return; const next = [...fields, value]; setFields(next); localStorage.setItem("open-dialer-lead-fields", JSON.stringify(next)); setFieldName(""); }}><input value={fieldName} onChange={(event) => setFieldName(event.target.value)} placeholder="e.g. Territory" /><button className="primary-button" type="submit">Add field</button></form><div className="field-pills">{fields.length ? fields.map((field) => <button key={field} type="button" onClick={() => { const next = fields.filter((item) => item !== field); setFields(next); localStorage.setItem("open-dialer-lead-fields", JSON.stringify(next)); }}>{field} <X size={13} /></button>) : <span>No custom fields yet.</span>}</div></section>;
  }
  if (page === "profile") return <ProfileSettings me={me} onRefresh={onRefresh} onNotice={onNotice} onSignOut={onSignOut} />;
  return <section className="settings-panel"><span className="panel-kicker">Account</span><h2>Privacy</h2><p>Telephony credentials are encrypted server-side. This browser stores only non-sensitive workspace preferences such as your profile and custom field names.</p><div className="settings-callout"><ShieldCheck size={20} /><span>Never enter Twilio credentials into a third-party integration field.</span></div></section>;
}

// Shows a sign-in link the server couldn't email, with a copy button.
function LinkCallout({ who, link, onClose }: { who: string; link: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="settings-callout team-issued" role="status">
      <KeyRound size={20} aria-hidden="true" />
      <span>Send {who} this sign-in link yourself. It works once.<code>{link}</code></span>
      <button type="button" className="quiet-button" onClick={() => void navigator.clipboard.writeText(link).then(() => setCopied(true))}>{copied ? "Copied" : "Copy link"}</button>
      <button type="button" className="icon-button" onClick={onClose} aria-label="Hide link"><X size={16} /></button>
    </div>
  );
}
const linkNotice = (result: LinkResult, who: string, email: string, what: string) => (result.emailed ? `${what} emailed to ${email}.` : result.emailError ? `${result.emailError} Copy the link below and send it to ${who} yourself.` : `${what} ready for ${who}. Copy the link below.`);

// Owner only: the company name and who can sign in. People are invited by email and set their own password.
function TeamSettings({ me, workspace, team, emailReady, onRefresh, onNotice }: { me: Member; workspace: { id: string; name: string }; team: Member[]; emailReady: boolean; onRefresh: () => Promise<unknown>; onNotice: (message: string) => void }) {
  const [company, setCompany] = useState(workspace.name);
  const [issued, setIssued] = useState<{ who: string; link: string } | null>(null);
  const run = async <T,>(work: () => Promise<T>, done: (result: T) => string) => {
    try {
      const result = await work();
      await onRefresh();
      onNotice(done(result));
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "That didn't work.");
    }
  };
  const showLink = (who: string, result: LinkResult) => setIssued(result.link ? { who, link: result.link } : null);
  const add = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = Object.fromEntries(new FormData(form));
    await run(async () => {
      const result = await api<{ user: Member } & LinkResult>("/api/team", { method: "POST", body: JSON.stringify(fields) });
      showLink(result.user.name, result);
      form.reset();
      return result;
    }, (result) => linkNotice(result, result.user.name, result.user.email || "", "Invite"));
  };
  const sendLink = (member: Member) => {
    if (!member.pending && !window.confirm(`Send ${member.name} a link to choose a new password? Their current password keeps working until they use it.`)) return;
    void run(async () => {
      const result = await api<{ user: Member } & LinkResult>(`/api/team/${member.id}`, { method: "PATCH", body: JSON.stringify({ sendLink: true }) });
      showLink(member.name, result);
      return result;
    }, (result) => linkNotice(result, member.name, member.email || "", member.pending ? "New invite" : "Reset link"));
  };
  const remove = (member: Member) => {
    if (!window.confirm(`Remove ${member.name}? They can't sign in anymore and their leads go back to unassigned.`)) return;
    void run(() => api(`/api/team/${member.id}`, { method: "DELETE" }), () => `${member.name} removed.`);
  };
  return (
    <section className="settings-panel">
      <span className="panel-kicker">Workspace</span>
      <h2>Team</h2>
      <form className="inline-form" onSubmit={(event) => { event.preventDefault(); void run(() => api("/api/workspace", { method: "PATCH", body: JSON.stringify({ name: company }) }), () => "Company name saved."); }}>
        <input value={company} onChange={(event) => setCompany(event.target.value)} aria-label="Company name" required />
        <button className="quiet-button" type="submit" disabled={company.trim() === workspace.name}>Save name</button>
      </form>
      <p>Owners see every lead and change settings. Callers only see the leads you assign to them on the Leads page.</p>
      <ul className="team-list">
        {team.map((member) => (
          <li key={member.id}>
            <span className="account-summary__avatar"><img src={`https://api.dicebear.com/7.x/notionists/svg?seed=${encodeURIComponent(member.id)}`} alt="" /></span>
            <span><b>{member.name}{member.id === me.id ? " (you)" : ""}</b><small>{member.email}{member.pending ? " · invite not accepted yet" : ""}</small></span>
            {member.id === me.id ? <em>{member.role === "owner" ? "Owner" : "Caller"}</em> : (
              <>
                <select value={member.role} aria-label={`${member.name}'s role`} onChange={(event) => void run(() => api(`/api/team/${member.id}`, { method: "PATCH", body: JSON.stringify({ role: event.target.value }) }), () => `${member.name} is now ${event.target.value === "owner" ? "an owner" : "a caller"}.`)}>
                  <option value="caller">Caller</option>
                  <option value="owner">Owner</option>
                </select>
                <button type="button" className="text-link" onClick={() => sendLink(member)}>{member.pending ? "Resend invite" : "Send reset link"}</button>
                <button type="button" className="text-link danger-link" onClick={() => remove(member)}>Remove</button>
              </>
            )}
          </li>
        ))}
      </ul>
      {issued && <LinkCallout who={issued.who} link={issued.link} onClose={() => setIssued(null)} />}
      <h3>Invite someone</h3>
      {!emailReady && <p className="field-hint">Email isn't set up on this server yet, so you'll get a link to send them yourself.</p>}
      <form className="settings-form team-add" onSubmit={(event) => void add(event)}>
        <label>Name<input name="name" autoComplete="off" required /></label>
        <label>Email<input name="email" type="email" autoComplete="off" required /></label>
        <label>Role<select name="role" defaultValue="caller"><option value="caller">Caller</option><option value="owner">Owner</option></select></label>
        <button className="primary-button" type="submit"><Mail size={16} aria-hidden="true" /> Send invite</button>
      </form>
    </section>
  );
}

// App admins only: every company on this server, and inviting a new one (its owner gets the invite).
function CompaniesSettings({ companies, emailReady, onRefresh, onNotice }: { companies: { id: string; name: string; people: Member[] }[]; emailReady: boolean; onRefresh: () => Promise<unknown>; onNotice: (message: string) => void }) {
  const [issued, setIssued] = useState<{ who: string; link: string } | null>(null);
  const add = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      const result = await api<{ user: Member } & LinkResult>("/api/companies", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(form))) });
      setIssued(result.link ? { who: result.user.name, link: result.link } : null);
      form.reset();
      await onRefresh();
      onNotice(linkNotice(result, result.user.name, result.user.email || "", "Owner invite"));
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "Couldn't add that company.");
    }
  };
  return (
    <section className="settings-panel">
      <span className="panel-kicker">Admin</span>
      <h2>Companies</h2>
      <p>Each company has its own workspace. Nobody can see another company's leads, calls or scripts.</p>
      <ul className="team-list">
        {companies.map((company) => (
          <li key={company.id}>
            <span><b>{company.name}</b><small>{company.people.map((person) => `${person.name} (${person.role}${person.pending ? ", invited" : ""})`).join(", ") || "No one yet"}</small></span>
          </li>
        ))}
      </ul>
      {issued && <LinkCallout who={issued.who} link={issued.link} onClose={() => setIssued(null)} />}
      <h3>Add a company</h3>
      {!emailReady && <p className="field-hint">Email isn't set up on this server yet, so you'll get a link to send the owner yourself.</p>}
      <form className="settings-form team-add" onSubmit={(event) => void add(event)}>
        <label>Company<input name="company" autoComplete="off" required /></label>
        <label>Owner's name<input name="name" autoComplete="off" required /></label>
        <label>Owner's email<input name="email" type="email" autoComplete="off" required /></label>
        <button className="primary-button" type="submit"><Mail size={16} aria-hidden="true" /> Invite owner</button>
      </form>
    </section>
  );
}

// Your own name and password, and signing out.
function ProfileSettings({ me, onRefresh, onNotice, onSignOut }: { me: Member; onRefresh: () => Promise<unknown>; onNotice: (message: string) => void; onSignOut: () => void }) {
  const [name, setName] = useState(me.name);
  const save = async (body: Record<string, unknown>, done: string, form?: HTMLFormElement) => {
    try {
      await api("/api/account", { method: "PATCH", body: JSON.stringify(body) });
      await onRefresh();
      form?.reset();
      onNotice(done);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "Couldn't save that.");
    }
  };
  return (
    <section className="settings-panel">
      <span className="panel-kicker">Account</span>
      <h2>Profile</h2>
      <p>Signed in as <b>{me.email}</b>, {me.role === "owner" ? "owner" : "caller"}.</p>
      <form className="settings-form" onSubmit={(event) => { event.preventDefault(); void save({ name }, "Name saved."); }}>
        <label>Your name<input value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" required /></label>
        <button className="primary-button" type="submit" disabled={name.trim() === me.name}>Save name</button>
      </form>
      <h3>Change password</h3>
      <form className="settings-form" onSubmit={(event) => { event.preventDefault(); const form = event.currentTarget; const fields = Object.fromEntries(new FormData(form)); void save(fields, "Password changed. Other browsers are signed out.", form); }}>
        <label>Current password<input name="currentPassword" type="password" autoComplete="current-password" required /></label>
        <label>New password<input name="newPassword" type="password" autoComplete="new-password" minLength={10} required /><small className="field-hint">At least 10 characters.</small></label>
        <button className="primary-button" type="submit">Change password</button>
      </form>
      <button type="button" className="quiet-button profile-sign-out" onClick={onSignOut}><LogOut size={16} aria-hidden="true" /> Sign out</button>
    </section>
  );
}

function LeadForm({
  lead,
  campaigns = [],
  defaultCampaign = "",
  onClose,
  onSaved,
  onDeleted,
  onImport,
}: {
  lead?: Lead;
  campaigns?: string[];
  defaultCampaign?: string;
  onClose: () => void;
  onImport?: () => void;
  onSaved: () => Promise<void>;
  onDeleted?: () => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editing = Boolean(lead);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    try {
      await api(editing ? `/api/leads/${lead!.id}` : "/api/leads", {
        method: editing ? "PATCH" : "POST",
        body: JSON.stringify((() => {
          const body: Record<string, unknown> = Object.fromEntries(form);
          // Editing takes a comma-separated list of campaigns; adding takes one.
          if (typeof body.campaigns === "string") body.campaigns = body.campaigns.split(",").map((name) => name.trim()).filter(Boolean);
          if (body.value === "") delete body.value;
          return body;
        })()),
      });
      await onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save this lead.");
    } finally {
      setSaving(false);
    }
  };
  const remove = async () => {
    if (!lead || !window.confirm(`Delete ${leadLabel(lead)}? This cannot be undone.`)) return;
    setSaving(true);
    try {
      await api(`/api/leads/${lead.id}`, { method: "DELETE" });
      await onDeleted?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not delete this lead.");
      setSaving(false);
    }
  };
  const blank = (value: string | undefined, placeholder: string) => (value === placeholder ? "" : value || "");
  return (
    <div className="modal-backdrop">
      <form className="lead-form" onSubmit={submit} role="dialog" aria-modal="true" aria-labelledby="add-lead-title">
        <button type="button" className="close-button" onClick={onClose} aria-label="Close">
          <X />
        </button>
        <h2 id="add-lead-title">{editing ? "Edit lead" : "Add a lead"}</h2>
        <p>{editing ? "Fix anything that is wrong. Only the phone number is required." : "Only the phone number is required."}</p>
        {!editing && onImport && (
          <button type="button" className="lead-form__import" onClick={onImport}>
            <FileUp size={16} aria-hidden="true" /> Adding a lot? Import a CSV instead
          </button>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <label>
          Phone
          <input name="phone" type="tel" required placeholder="+1 555 0100" defaultValue={lead?.phone} />
        </label>
        <label>
          Extension (optional)
          <input name="extension" inputMode="numeric" placeholder="e.g. 10257" defaultValue={lead?.extension} />
        </label>
        <label>
          Contact name (optional)
          <input name="name" placeholder="Leave blank for a front desk or main line" defaultValue={lead?.name} />
        </label>
        <label>
          Company
          <input name="company" defaultValue={blank(lead?.company, "Unassigned")} />
        </label>
        <label>
          Role
          <input name="role" placeholder="e.g. Receptionist, Superintendent" defaultValue={blank(lead?.role, "Contact")} />
        </label>
        {editing ? (
          <>
            <label>
              Campaigns (separate with commas)
              <input name="campaigns" defaultValue={(lead?.campaigns || []).join(", ")} placeholder="NC school districts" />
            </label>
            <label>
              Deal value (optional)
              <input name="value" type="number" min="0" step="1" inputMode="numeric" defaultValue={lead?.value ?? ""} placeholder="0" />
            </label>
          </>
        ) : (
          <label>
            Campaign (optional)
            <input name="campaign" defaultValue={defaultCampaign} placeholder="NC school districts" list="lead-campaign-options" autoComplete="off" />
            <datalist id="lead-campaign-options">{campaigns.map((name) => <option key={name} value={name} />)}</datalist>
          </label>
        )}
        <label>
          Time zone
          <input name="timezone" placeholder="America/New_York" defaultValue={blank(lead?.timezone, "Unknown")} list="timezone-options" />
          <datalist id="timezone-options">
            {["America/New_York", "America/Chicago", "America/Denver", "America/Phoenix", "America/Los_Angeles", "America/Anchorage", "Pacific/Honolulu"].map((zone) => <option key={zone} value={zone} />)}
          </datalist>
        </label>
        {editing && (
          <label>
            Note
            <textarea name="note" defaultValue={lead?.note} />
          </label>
        )}
        <button className="primary-button" disabled={saving}>
          {saving ? "Saving…" : editing ? <><Check size={17} /> Save changes</> : <><UserPlus size={17} /> Add to route</>}
        </button>
        {editing && (
          <button type="button" className="quiet-button danger-button" onClick={remove} disabled={saving}>
            Delete lead
          </button>
        )}
      </form>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
