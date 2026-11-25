import { FormEvent, Fragment, ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Inbox,
  Send,
  Hourglass,
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
  Volume2,
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
  Pin,
  LayoutDashboard,
  ScrollText,
  Workflow,
  Voicemail,
} from "lucide-react";
import { Call, Device } from "@twilio/voice-sdk";
import { hoursStatus, nowIn, parseHours } from "./hours";
import { money, prices } from "./prices";
import { checkCondition, describeCondition, isOtherwise, parseCondition } from "./conditions";
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
  wonAt?: string;
  taskDone?: { at: string; due: string };
  followUpSince?: string;
  followUpReason?: string;
  assignedTo?: string;
  // AI-cleaned script values: kept while the raw value (from) is unchanged.
  spoken?: Record<string, { from: string; text: string }>;
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
  // Talk time of the lead's side, from Twilio; transcript lines when live transcription was on.
  seconds?: number;
  transcribing?: boolean;
  transcript?: { who: string; text: string; at: string }[];
};
type Task = { id: string; title: string; details?: string; due: string; leadId: string | null; createdAt: string; doneAt: string | null };
type TaskFields = { title: string; details: string; due: string; leadId: string | null };
type CampaignSettings = { script?: string; pdf?: { name: string; size: number; updatedAt: string }; variables?: Record<string, string>; value?: number; clean?: Record<string, CleanRule>; pinned?: string[]; transcribe?: boolean };
// The workspace's automations, n8n style: a trigger (with the campaigns it listens to, none meaning any), then
// steps run in order. "Only continue if" stops the rest
// when the lead doesn't match.
type AutomationTrigger = "lead" | "outcome" | "voicemail" | "transcribed";
type ConditionOp = "is" | "is not" | "contains" | "is empty" | "is not empty";
type AutomationStep =
  | { type: "if"; field: string; op: ConditionOp; value: string }
  | { type: "say"; text: string }
  | { type: "ask"; prompt: string; field: string }
  | { type: "wait"; amount: number; unit: "minutes" | "hours" | "days" }
  | { type: "email"; to: string; subject: string; body: string }
  | { type: "sms"; text: string }
  | { type: "play"; recordingId: string }
  | { type: "stage"; stage: string }
  | { type: "followup"; days: number };
type Automation = { id: string; name: string; on: boolean; trigger: AutomationTrigger; campaigns?: string[]; outcomes?: string[]; steps: AutomationStep[] };
type Recording = { id: string; name: string; size: number; seconds: number; createdAt: string };
type CleanRule = { from: string; to: string; notes: string };
// A won lead is worth its own value if set, else its campaign's deal value.
function dealValue(lead: Lead, settings: Record<string, CampaignSettings>) {
  return lead.value || Math.max(0, ...(lead.campaigns || []).map((name) => settings[name]?.value || 0));
}
type State = {
  automations?: Automation[];
  tasks?: Task[];
  campaignSettings?: Record<string, CampaignSettings>;
  leads: Lead[];
  activity: { id: string; at: string; action: string; detail: string }[];
  connection: Connection | null;
  calls: CallRecord[];
  dncNumbers: string[];
  callbackReachable?: boolean;
  settings?: { bookingUrl?: string; fields?: string[]; features?: Partial<Features> };
  email?: { from?: string; hint?: string; saved?: boolean; envFallback?: boolean };
  ai?: { provider?: string; model?: string; hint?: string; ready: boolean };
  voicemails?: Recording[];
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
type Screen = "home" | "queue" | "scripts" | "automations" | "voicemails" | "campaigns" | "calls" | "leads" | "followups" | "activity" | "pipeline" | "analytics" | "settings";
type SettingsArea = "general" | "account";
type SettingsPage =
  | "numbers"
  | "team"
  | "fields"
  | "profile"
  | "privacy"
  | "booking"
  | "ai"
  | "email"
  | "costs"
  | "companies";

class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

// Campaigns govern the dialer, scripts, automations and analytics, so those sit under it (sub: indented).
const nav = [
  { id: "home", key: "home", label: "Dashboard", icon: LayoutDashboard },
  { id: "campaigns", key: "campaigns", label: "Campaigns", icon: Tag },
  { id: "dashboard", key: "queue", label: "Dialer", icon: Activity, sub: true },
  { id: "scripts", key: "scripts", label: "Scripts", icon: ScrollText, sub: true },
  { id: "automations", key: "automations", label: "Automations", icon: Workflow, sub: true },
  { id: "voicemails", key: "voicemails", label: "Voicemails", icon: Voicemail, sub: true },
  { id: "analytics", key: "analytics", label: "Analytics", icon: ChartColumn, sub: true },
  { id: "leads", key: "leads", label: "Leads", icon: Users },
  { id: "calls", key: "calls", label: "Calls", icon: Phone },
  { id: "tasks", key: "followups", label: "Tasks", icon: CalendarClock },
  { id: "pipeline", key: "pipeline", label: "Pipeline", icon: SlidersHorizontal },
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
    // The microphone picked in the call bar last time; if it's unplugged, the browser default is used.
    try { const mic = localStorage.getItem("open-dialer-mic"); if (mic) void phoneDevice.audio?.setInputDevice(mic).catch(() => {}); } catch { /* private mode */ }
  }
  phoneTokenAt = Date.now();
  phoneAccount = accountSid;
  return phoneDevice;
}

const callOutcomes = ["Interested", "Meeting booked", "Callback", "Maybe later", "No answer", "Busy", "Voicemail", "Not interested", "Wrong number", "Do not call"];
// A follow-up some business days out at 10:00 (two for a voicemail), as datetime-local text.
function voicemailFollowUp(days = 2) {
  const date = new Date();
  for (let added = 0; added < days; ) {
    date.setDate(date.getDate() + 1);
    if (date.getDay() !== 0 && date.getDay() !== 6) added += 1;
  }
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}T10:00`;
}

// A lead's value for a step's field: a script variable like lead_type, a lead field, or a CSV column (detail:…).
function fieldValue(field: string, lead: Lead, variables?: Record<string, string>) {
  return (field.startsWith("detail:") || variableFields.some(([key]) => key === field) ? variableValue(field, lead) : rawVariable(field, lead, variables)).trim();
}
function matches(step: Extract<AutomationStep, { type: "if" }>, lead: Lead, variables?: Record<string, string>) {
  const have = fieldValue(step.field, lead, variables).toLowerCase();
  const want = step.value.trim().toLowerCase();
  if (step.op === "is empty") return !have;
  if (step.op === "is not empty") return Boolean(have);
  if (step.op === "contains") return have.includes(want);
  return step.op === "is not" ? have !== want : have === want;
}
// Which of a lead's campaigns an automation hears it through (its script variables fill the steps), or null when
// the trigger doesn't listen to any of them. No campaigns on the trigger means any lead.
function heardThrough(item: Automation, lead: Lead, settings: Record<string, CampaignSettings>) {
  const own = lead.campaigns || [];
  if (!item.campaigns?.length) return scriptCampaignOf(lead, settings) || own[0] || "";
  return own.find((name) => item.campaigns!.includes(name)) ?? null;
}
// What a trigger does for a lead: the steps of each switched-on automation listening to it, in order, up to the
// first "Only continue if" the lead doesn't match.
function automationSteps(trigger: AutomationTrigger, lead: Lead, automations: Automation[] = [], settings: Record<string, CampaignSettings>, outcome = "") {
  return automations
    .filter((item) => item.on && item.trigger === trigger && (trigger !== "outcome" || !item.outcomes?.length || item.outcomes.includes(outcome)))
    .flatMap((item) => {
      const campaign = heardThrough(item, lead, settings);
      if (campaign === null) return [];
      const out: { campaign: string; step: AutomationStep }[] = [];
      for (const step of item.steps) {
        if (step.type === "wait") break;
        if (step.type !== "if") out.push({ campaign, step });
        else if (!matches(step, lead, settings[campaign]?.variables)) break;
      }
      return out;
    });
}
// The recording a Drop voicemail plays: the first "Play a voicemail" step that runs for this lead.
function voicemailFor(lead: Lead, automations: Automation[] | undefined, settings: Record<string, CampaignSettings>, vault: Recording[] = []) {
  for (const { campaign, step } of automationSteps("voicemail", lead, automations, settings)) {
    const recording = step.type === "play" && vault.find((item) => item.id === step.recordingId);
    if (recording) return { campaign, recordingId: recording.id, name: recording.name };
  }
  return null;
}
// What "Call outcome logged" automations do for this outcome: a stage to move to and a follow-up date.
function outcomeActions(lead: Lead, automations: Automation[] | undefined, settings: Record<string, CampaignSettings>, outcome: string) {
  let stage = "";
  let followUpAt = "";
  for (const { step } of automationSteps("outcome", lead, automations, settings, outcome)) {
    if (step.type === "stage") stage = step.stage;
    if (step.type === "followup") followUpAt = voicemailFollowUp(step.days);
  }
  return { stage, followUpAt };
}

// Browser recordings come out as WebM, which Twilio can't play: decode, trim the silence at both ends, bring the
// loudest part up to a steady level, and save as a 16 kHz mono WAV. Returns the file and its length in seconds.
async function toWav(blob: Blob) {
  const decoded = await new AudioContext().decodeAudioData(await blob.arrayBuffer());
  const rate = 16000;
  const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * rate), rate);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const all = (await offline.startRendering()).getChannelData(0);
  const loud = (sample: number) => Math.abs(sample) > 0.02;
  const pad = Math.round(rate * 0.25);
  const first = all.findIndex(loud);
  let last = all.length - 1;
  while (last > 0 && !loud(all[last])) last--;
  const samples = first < 0 ? all : all.slice(Math.max(0, first - pad), Math.min(all.length, last + pad));
  const peak = samples.reduce((max, sample) => Math.max(max, Math.abs(sample)), 0) || 1;
  const gain = Math.min(4, 0.9 / peak);
  const view = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const text = (at: number, value: string) => [...value].forEach((char, index) => view.setUint8(at + index, char.charCodeAt(0)));
  text(0, "RIFF"); view.setUint32(4, 36 + samples.length * 2, true); text(8, "WAVE"); text(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, "data"); view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, index) => view.setInt16(44 + index * 2, Math.max(-1, Math.min(1, sample * gain)) * 0x7fff, true));
  return { blob: new Blob([view], { type: "audio/wav" }), seconds: Math.round(samples.length / rate) };
}
// The length of an uploaded MP3 or WAV, when the browser can read it.
async function audioSeconds(blob: Blob) {
  try { return Math.round((await new AudioContext().decodeAudioData(await blob.arrayBuffer())).duration); } catch { return 0; }
}
const clockOf = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
const blobToBase64 = (blob: Blob) => new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",")[1] || ""); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob); });

function usesAppPhone(connection: Connection | null | undefined) {
  return !connection?.bridgeNumber || connection.bridgeNumber === "browser";
}

type ActiveCall = { lead: Lead; call: Call | null; status: "connecting" | "ringing" | "in-call"; muted: boolean; startedAt: number | null; callId?: string };

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

function InCallBar({ active, onMute, onHangUp, onBook, voicemail, onDropVoicemail }: { active: ActiveCall; onMute: () => void; onHangUp: () => void; onBook: () => void; voicemail: string | null; onDropVoicemail: () => Promise<void> }) {
  const [dropping, setDropping] = useState(false);
  const [audioOpen, setAudioOpen] = useState(false);
  // How loud your microphone is right now (0 to 1), and how long it has been silent, to catch a wrong or dead mic.
  const [micLevel, setMicLevel] = useState(0);
  const [silentFor, setSilentFor] = useState(0);
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [micId, setMicId] = useState(() => phoneDevice?.audio?.inputDevice?.deviceId || "");
  useEffect(() => {
    const call = active.call;
    if (!call) return;
    let quietSince = Date.now();
    const onVolume = (input: number) => {
      setMicLevel(input);
      if (input > 0.02) quietSince = Date.now();
      setSilentFor(Math.floor((Date.now() - quietSince) / 1000));
    };
    call.on("volume", onVolume);
    const audio = phoneDevice?.audio;
    const list = () => { setMics([...(audio?.availableInputDevices.values() || [])].filter((device) => device.deviceId !== "communications")); setMicId(audio?.inputDevice?.deviceId || "default"); };
    list();
    audio?.on("deviceChange", list);
    return () => { call.removeListener("volume", onVolume); audio?.removeListener("deviceChange", list); };
  }, [active.call]);
  const pickMic = (deviceId: string) => {
    setMicId(deviceId);
    try { localStorage.setItem("open-dialer-mic", deviceId); } catch { /* private mode */ }
    void phoneDevice?.audio?.setInputDevice(deviceId).catch(() => {});
  };
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
      <div className="in-call-bar__who">
        {/* Your mic at a glance: the mic taskbar widget's three bars, green when it hears you, red when it hears nothing. */}
        <div className="mic-bars" data-state={active.muted ? "muted" : live && silentFor >= 5 ? "silent" : micLevel > 0.02 ? "heard" : "listening"} role="img" aria-label={active.muted ? "Muted" : live && silentFor >= 5 ? "No sound from your mic: they can't hear you" : micLevel > 0.02 ? "Your mic hears you" : "Your mic is listening"} title={active.muted ? "Muted" : live && silentFor >= 5 ? "No sound from your mic: they can't hear you. Pick another mic under the speaker button." : "Your mic"}>
          {[[8, 12], [15, 14], [10, 13]].map(([base, range], index) => <i key={index} style={{ height: base + Math.min(1, micLevel / 0.25) * range }} />)}
        </div>
        <div>
          <b>{leadLabel(active.lead)}</b>
          <small>{formatPhone(active.lead.phone, active.lead.extension)} · {status}</small>
        </div>
      </div>
      <div className="in-call-bar__actions">
        <button type="button" className="quiet-button" onClick={onMute} disabled={active.status !== "in-call"} aria-pressed={active.muted}>
          {active.muted ? <MicOff size={16} /> : <Mic size={16} />} {active.muted ? "Unmute" : "Mute"}
        </button>
        <button type="button" className="quiet-button" onClick={() => setKeypadOpen((open) => !open)} disabled={!live} aria-expanded={keypadOpen}>
          <Grid3x3 size={16} /> Keypad
        </button>
        <button type="button" className="quiet-button" onClick={onBook}>
          <CalendarPlus size={16} /> Book
        </button>
        {voicemail && <button type="button" className="quiet-button" disabled={!live || dropping} title={`At the beep: plays "${voicemail}" into their voicemail, hangs up and logs a voicemail`} onClick={() => { setDropping(true); void onDropVoicemail().finally(() => setDropping(false)); }}><MessageSquare size={16} /> {dropping ? "Dropping…" : "Voicemail"}</button>}
        <div className="in-call-bar__audio">
          <button type="button" className="quiet-button icon-button" onClick={() => setAudioOpen((open) => !open)} aria-expanded={audioOpen} aria-label="Microphone" title="Microphone"><Volume2 size={16} /></button>
          {audioOpen && (
            <div className="in-call-bar__popover" role="dialog" aria-label="Microphone">
              <label className="in-call-bar__mic">Microphone
                <select value={micId} onChange={(event) => pickMic(event.target.value)}>
                  {mics.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label || "Microphone"}</option>)}
                </select>
              </label>
            </div>
          )}
        </div>
        <button type="button" className="hang-up-button" onClick={onHangUp}>
          <PhoneOff size={16} /> Hang up
        </button>
      </div>
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
// #dashboard stays the Dialer so old links keep working; the Dashboard page is #home.
const screenHashes: Record<Screen, string> = { home: "home", queue: "dashboard", scripts: "scripts", automations: "automations", voicemails: "voicemails", campaigns: "campaigns", leads: "leads", calls: "calls", followups: "tasks", activity: "activity", pipeline: "pipeline", analytics: "analytics", settings: "settings" };
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
  return (Object.keys(screenHashes) as Screen[]).find((key) => screenHashes[key] === hashParts().page) || "home";
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
  const [tourAt, setTourAt] = useState<number | null>(null);
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
  // Set while a voicemail drop is under way, so the hang-up that follows logs it instead of asking.
  const droppedVoicemail = useRef<string | null>(null);
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
      setActiveCall((current) => current && { ...current, call, callId: start.callId });
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
        if (droppedVoicemail.current) {
          const recording = droppedVoicemail.current;
          droppedVoicemail.current = null;
          setActiveCall(null);
          const auto = outcomeActions(lead, state?.automations, state?.campaignSettings || {}, "Voicemail");
          void api("/api/calls/record", { method: "POST", body: JSON.stringify({ leadId: lead.id, outcome: "Voicemail", note: `Voicemail dropped: ${recording}`, followUpAt: auto.followUpAt || voicemailFollowUp() }) })
            .then(() => refresh())
            .then((fresh) => advanceFrom(fresh, lead, `Voicemail dropped for ${leadLabel(lead)}. Follow-up set for 2 business days out.`))
            .catch((error) => showError(error instanceof Error ? error.message : "Couldn't log the voicemail."));
          return;
        }
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
  // Which part of the campaign Settings popup opens first (Scripts and Automations link straight to one).
  const [scriptTab, setScriptTab] = useState<CampaignTab>("script");
  const editCampaign = (name: string, tab: CampaignTab = "script") => { setScriptTab(tab); setScriptFor(name); };
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
          window.history.replaceState(null, "", "#home");
          setWelcomeToken(null);
          setNeedsLogin(false);
          setScreen("home");
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
          {nav.map(({ id, key, label, icon: Icon, ...item }) => (
            <button
              key={id}
              data-tour={`nav-${key}`}
              className={`nav-item${"sub" in item ? " nav-item--sub" : ""}${screen === key ? " nav-item--active" : ""}`}
              onClick={() => { setLeadsView("all"); setCallsView("conversations"); setScreen(key); }}
            >
              <Icon size={18} />
              <span>{label}</span>
              {id === "tasks" && followUps.length + (state.tasks || []).filter((task) => !task.doneAt).length > 0 && <b>{followUps.length + (state.tasks || []).filter((task) => !task.doneAt).length}</b>}
            </button>
          ))}
          {/* Unibox: SMS and email replies in one place. Not built yet, so it can't be opened. */}
          <button className="nav-item nav-item--soon" type="button" disabled aria-disabled="true" title="Coming soon">
            <Inbox size={18} />
            <span>Unibox</span>
            <small className="nav-soon">Soon</small>
          </button>
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
            {(screen === "home" || screen === "leads" || screen === "pipeline" || screen === "analytics" || screen === "scripts" || screen === "voicemails") && picker}
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
        {activeCall?.callId && featuresOf(state).transcription && featuresOf(state).captions && <LiveCaptions callId={activeCall.callId} />}
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
            voicemail={voicemailFor(activeCall.lead, state.automations, state.campaignSettings || {}, state.voicemails)?.name || null}
            onDropVoicemail={async () => {
              const pick = voicemailFor(activeCall.lead, state.automations, state.campaignSettings || {}, state.voicemails);
              if (!pick || !activeCall.callId) return;
              droppedVoicemail.current = pick.name;
              try {
                await api("/api/calls/drop-voicemail", { method: "POST", body: JSON.stringify({ callId: activeCall.callId, campaign: pick.campaign, recordingId: pick.recordingId }) });
              } catch (error) {
                droppedVoicemail.current = null;
                showError(error instanceof Error ? error.message : "Couldn't drop the voicemail.");
              }
            }}
            onBook={() => {
              const url = state.settings?.bookingUrl;
              if (!url) return showError("Add your Calendly or Cal.com link first: Settings → General → Booking link.");
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
            onRefresh={refresh}
            onNotice={setNotice}
            onAddLead={() => setShowLeadForm(true)}
            onGuide={() => setGuideOpen(true)}
            onAddTask={(lead) => setTaskDialog({ leadId: lead.id })}
            onOpenPdf={setPdfFor}
            onEditScript={(name) => editCampaign(name)}
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
            settings={state.campaignSettings || {}}
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
        {screen === "home" && (
          <Home
            state={scoped}
            all={state}
            followUps={followUps}
            onOpenLead={(id) => { setSelectedId(id); setScreen("queue"); }}
            onStart={startCampaign}
            onGo={setScreen}
          />
        )}
        {screen === "scripts" && <ScriptsPage leads={state.leads} settings={state.campaignSettings || {}} campaign={activeCampaign} onEdit={editCampaign} />}
        {screen === "automations" && <AutomationsPage automations={state.automations || []} leads={state.leads} settings={state.campaignSettings || {}} vault={state.voicemails || []} onRefresh={refresh} onOpenVault={() => setScreen("voicemails")} />}
        {screen === "voicemails" && <VoicemailsPage vault={state.voicemails || []} automations={state.automations || []} settings={state.campaignSettings || {}} campaign={activeCampaign} onRefresh={refresh} onNotice={setNotice} />}
        {screen === "campaigns" && (
          <Campaigns
            leads={state.leads}
            onStart={startCampaign}
            onView={(name) => { setCampaign(name); setScreen("leads"); }}
            onStage={(name) => { setCampaign(name); setScreen("pipeline"); }}
            settings={state.campaignSettings || {}}
            onScript={(name) => editCampaign(name)}
            onImport={(name) => { if (name) setCampaign(name); setImportOpen("campaign"); }}
          />
        )}
        {screen === "settings" && (
          <Settings
            fullState={state}
            me={state.me}
            workspace={state.workspace}
            team={state.team}
            emailReady={Boolean(state.emailReady)}
            companies={state.companies || []}
            onSignOut={signOut}
            connection={state.connection}
            bookingUrl={state.settings?.bookingUrl || ""}
            ai={state.ai}
            campaignSettings={state.campaignSettings || {}}
            leads={state.leads}
            fields={state.settings?.fields}
            onRefresh={refresh}
            onNotice={setNotice}
          />
        )}
      </section>
      {scriptFor !== null && (
        <ScriptDialog
          campaign={scriptFor}
          initialTab={scriptTab}
          settings={state.campaignSettings?.[scriptFor] || {}}
          columns={[...new Set([...(state.settings?.fields || []), ...state.leads.filter((lead) => !scriptFor || lead.campaigns?.includes(scriptFor)).flatMap((lead) => Object.keys(lead.details || {}))])].sort()}
          leads={state.leads.filter((lead) => lead.campaigns?.includes(scriptFor))}
          aiReady={Boolean(state.ai?.ready)}
          vault={state.voicemails || []}
          onOpenVault={() => { setScriptFor(null); setScreen("voicemails"); }}
          onImport={() => { setCampaign(scriptFor); setScriptFor(null); setImportOpen("campaign"); }}
          onViewPdf={() => setPdfFor(scriptFor)}
          onClose={() => setScriptFor(null)}
          onChanged={async (message, close, name) => {
            await refresh();
            // A new campaign's next step is its leads.
            if (!scriptFor && close) notifyWith(message, "Import leads", () => { setCampaign(name); setImportOpen("campaign"); });
            else setNotice(message);
            if (close) setScriptFor(null);
          }}
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
          fields={state.settings?.fields}
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
      {importOpen && <ImportLeads campaigns={[...new Set([...campaigns, ...Object.keys(state.campaignSettings || {})])]} settings={state.campaignSettings || {}} fields={state.settings?.fields} defaultCampaign={importOpen === "campaign" && campaign ? campaign : activeCampaign} requireCampaign={importOpen === "campaign"} onClose={() => setImportOpen(false)} onSaved={async (message, name) => { setImportOpen(false); await refresh(); notifyWith(message, "Start calling", () => { setCampaign(name); setScreen("queue"); }); }} />}
      {dncOpen && <DncList onClose={() => setDncOpen(false)} onSaved={async (message) => { setDncOpen(false); await refresh(); setNotice(message); }} />}
      {outcomeLead && <CallOutcome lead={outcomeLead} automations={state.automations} settings={state.campaignSettings || {}} bookingUrl={state.settings?.bookingUrl || ""} onBook={() => openBooking(state.settings!.bookingUrl!, outcomeLead.name).catch((error) => showError(error instanceof Error ? error.message : "Couldn't open the booking page."))} onClose={() => setOutcomeLead(null)} onSaved={async (outcome) => {
        setOutcomeLead(null);
        advanceFrom(await refresh(), outcomeLead, `${outcome} saved for ${leadLabel(outcomeLead)}.`);
      }} />}
      {editLead && <LeadForm lead={editLead} campaigns={campaigns} fields={state.settings?.fields} onClose={() => setEditLead(null)} onSaved={async () => { setEditLead(null); await refresh(); setNotice("Lead updated."); }} onDeleted={async () => { const name = leadLabel(editLead); setEditLead(null); if (selectedId === editLead.id) setSelectedId(null); await refresh(); setNotice(`${name} deleted.`); }} />}
      {guideOpen && (
        <SetupGuide
          state={state}
          onClose={() => setGuideOpen(false)}
          onTour={(step) => {
            setGuideOpen(false);
            setTourAt(step);
          }}
        />
      )}
      {tourAt !== null && <SetupTour steps={setupSteps(state)} start={tourAt} onScreen={setScreen} onClose={() => setTourAt(null)} />}
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
    .filter((call) => view === "callbacks" ? call.outcome === "Callback" : view === "conversations" ? ["Interested", "Meeting booked", "Callback", "Maybe later", "Not interested"].includes(call.outcome) || Boolean(call.transcript?.length) : true)
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

      {!entries.length ? <div className="calls-empty"><p>{isCallbacks ? "No callbacks are recorded yet." : "No calls match this view."}</p><span><button type="button" onClick={onStartDialing}>Open leads →</button> or <button type="button" onClick={onOpenPhoneNumbers}>review phone settings →</button></span></div> : <div className="call-history-list">{entries.map((call) => <article key={call.id}><div><button type="button" className="text-link" onClick={() => call.lead && onOpenLead(call.lead.id)}><b>{call.lead && leadLabel(call.lead)}</b></button><small>{call.lead?.company} · {call.lead && formatPhone(call.lead.phone, call.lead.extension)}</small></div><Status tone={call.outcome === "Do not call" || call.outcome === "Didn't connect" ? "alert" : call.outcome === "In progress" || call.outcome === "Call ended" ? "quiet" : "good"}>{call.outcome}</Status><div><small>{dueLabel(call.at).text}{call.seconds ? ` · ${clockOf(call.seconds)}` : ""}</small>{call.note && <p>{call.note}</p>}{call.transcript?.length ? <details className="call-transcript"><summary>Transcript · {call.transcript.length} line{call.transcript.length === 1 ? "" : "s"}</summary>{call.transcript.map((line, index) => <p key={index} className={`is-${line.who}`}><b>{line.who === "you" ? "You" : "Them"}</b> {line.text}</p>)}</details> : null}</div></article>)}</div>}
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

// The state's flag from flagcdn.com (a free flag image service), e.g. us-tx; hidden if it doesn't load.
function StateFlag({ lead }: { lead: Lead }) {
  const code = leadStateCode(lead);
  if (!code) return null;
  return <img className="state-flag" src={`https://flagcdn.com/us-${code.toLowerCase()}.svg`} alt="" width={18} height={12} loading="lazy" onError={(event) => { event.currentTarget.style.display = "none"; }} />;
}

// Opening hours from a CSV column like "Hours" or "Opening hours" (Google Maps exports have one), checked against
// the time where the lead is. Null when there's no such column, it can't be read, or the lead has no state.
function leadHours(lead: Lead) {
  const text = Object.entries(lead.details || {}).find(([key]) => /hours|opening|open time|working time/i.test(key))?.[1];
  const zone = leadZone(lead);
  const week = text ? parseHours(text) : null;
  if (!week || !zone) return null;
  const now = nowIn(zone.zone);
  return hoursStatus(week, now.day, now.minute);
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
function StageLine({ lead, calls, value }: { lead: Lead; calls: CallRecord[]; value: number }) {
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
  if (lead.status === "Won") return <span className="stage-line"><Dots tones={[value ? "good" : "empty"]} />{value ? `$${value.toLocaleString()}` : "No deal value yet"}</span>;
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
  const setup = setupSteps(state).filter((step) => !step.optional);
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
          <button className="primary-button" data-tour="start-calling" onClick={onStart} disabled={!toCall}>Start calling <ChevronRight size={16} /></button>
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
  onRefresh,
  onNotice,
}: {
  onRefresh: () => Promise<unknown>;
  onNotice: (message: string) => void;
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
  // What the list shows: everything in calling order, only new leads, or callbacks (follow-ups and set call-back times).
  const [view, setView] = useState<"all" | "new" | "callbacks">(() => { try { return (localStorage.getItem("open-dialer-queue-view") as "all" | "new" | "callbacks") || "all"; } catch { return "all"; } });
  const [order, setOrder] = useState<"queue" | "newest" | "location">(() => { try { const saved = localStorage.getItem("open-dialer-queue-order"); return saved === "newest" || saved === "location" ? saved : "queue"; } catch { return "queue"; } });
  const remember = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* private mode */ } };
  const isCallback = (lead: Lead) => lead.status === "Follow-up" || /^\d{4}-\d{2}-\d{2}/.test(lead.due);
  const addedAt = (lead: Lead) => Number(lead.id.split("_")[1]) || 0;
  const filtered = upcoming.filter((lead) => view === "all" || (view === "new" ? lead.status === "New" && !isCallback(lead) : isCallback(lead)));
  // Location: by state name, then city (from a "City" column), leads with no state last; calling order breaks ties.
  const place = (lead: Lead) => [leadState(lead)?.[1] || "\uffff", Object.entries(lead.details || {}).find(([key]) => /^(city|town)$/i.test(key.trim()))?.[1]?.trim() || "\uffff"].join("|").toLowerCase();
  const shown = order === "newest" ? [...filtered].sort((left, right) => addedAt(right) - addedAt(left)) : order === "location" ? [...filtered].sort((left, right) => place(left).localeCompare(place(right))) : view === "callbacks" ? [...filtered].sort((left, right) => (left.due || "").localeCompare(right.due || "")) : filtered;
  const counts = { all: upcoming.length, new: upcoming.filter((lead) => lead.status === "New" && !isCallback(lead)).length, callbacks: upcoming.filter(isCallback).length };
  // The script of the lead's first campaign that has one.
  const scriptCampaign = scriptCampaignOf(selected, state.campaignSettings || {});
  const script = scriptCampaign ? state.campaignSettings![scriptCampaign] : undefined;
  // Pinned details (picked per campaign by the owner) sit at the top; the rest are grouped as before.
  const pinCampaign = scriptCampaign || selected.campaigns?.[0];
  const pinned = (pinCampaign && state.campaignSettings?.[pinCampaign]?.pinned) || [];
  const pinnedEntries = pinned.map((label) => [label, selected.details?.[label] || ""] as [string, string]).filter(([, value]) => value);
  const groups = groupDetails(Object.fromEntries(Object.entries(selected.details || {}).filter(([label]) => !pinned.includes(label))));
  const togglePin = async (label: string) => {
    const next = pinned.includes(label) ? pinned.filter((item) => item !== label) : [...pinned, label];
    try {
      await api("/api/campaigns/script", { method: "PUT", body: JSON.stringify({ campaign: pinCampaign, pinned: next }) });
      await onRefresh();
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "Couldn't pin that.");
    }
  };
  const pin = (label: string, name = label) => (pinCampaign && state.me.role === "owner"
    ? <button type="button" className={`pin-button${pinned.includes(label) ? " is-pinned" : ""}`} aria-pressed={pinned.includes(label)} aria-label={`${pinned.includes(label) ? "Unpin" : "Pin"} ${name}`} title={pinned.includes(label) ? `Unpin for ${pinCampaign}` : `Pin to the top for every lead in ${pinCampaign}`} onClick={(event) => { event.preventDefault(); event.stopPropagation(); void togglePin(label); }}><Pin size={13} aria-hidden="true" /></button>
    : null);
  // Whole sections can be pinned too ("@research", "@sources"): they move up under the pinned cards and stay open.
  const section = (key: "@research" | "@sources", title: string, items: [string, string][]) => items.length > 0 && (
    <details className={`call-more${pinned.includes(key) ? " is-pinned-section" : ""}`} open={pinned.includes(key) || undefined}>
      <summary><ChevronRight size={16} aria-hidden="true" /> {title} <small>{items.length}</small>{pin(key, title)}</summary>
      <dl>{items.map(([label, value]) => <div key={label}><dt>{label}{pin(label)}</dt><dd><DetailValue value={value} /></dd></div>)}</dl>
    </details>
  );
  const researchSection = section("@research", "Research", groups.research);
  const sourcesSection = section("@sources", "Sources & history", groups.sources);
  // While calling, clean the script values of this lead and the next 4 in the background (5 at a time, saved once).
  const nextFive = [selected, ...upcoming.filter((lead) => lead.id !== selected.id).slice(0, 4)];
  const pending = state.ai?.ready ? cleanupItems(nextFive, state.campaignSettings || {}) : [];
  const pendingKey = pending.map((item) => `${item.leadId}:${item.variable}:${item.text}`).join("|");
  const asked = useRef(new Set<string>());
  const [cleaning, setCleaning] = useState(false);
  const clean = async (items: typeof pending, force: boolean) => {
    setCleaning(true);
    try {
      await api("/api/ai/clean", { method: "POST", body: JSON.stringify({ items, force }) });
      await onRefresh();
    } catch (error) {
      if (force) onNotice(error instanceof Error ? error.message : "Couldn't clean the script values.");
    } finally {
      setCleaning(false);
    }
  };
  useEffect(() => {
    // Each value is asked for once per visit; a failure doesn't retry in a loop.
    const fresh = pending.filter((item) => !asked.current.has(`${item.leadId}:${item.variable}:${item.text}`));
    if (!fresh.length) return;
    fresh.forEach((item) => asked.current.add(`${item.leadId}:${item.variable}:${item.text}`));
    void clean(fresh, false);
  }, [pendingKey]);
  const cleanable = Boolean(state.ai?.ready && script?.clean && Object.keys(script.clean).length);
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
          const next = shown[0] || upcoming[0];
          if (next) onSelect(next.id);
          document.querySelector(".call-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
        }}
      />
      <section className="queue-layout">
        <aside className="call-list" aria-label="Calling queue">
          <div className="call-list__filters">
            <div className="call-list__views" role="group" aria-label="Show">
              {([["all", "All"], ["new", "New"], ["callbacks", "Callbacks"]] as const).map(([key, label]) => (
                <button key={key} type="button" className={view === key ? "is-active" : ""} aria-pressed={view === key} onClick={() => { setView(key); remember("open-dialer-queue-view", key); }}>{label} <small>{counts[key]}</small></button>
              ))}
            </div>
            <select value={order} aria-label="Order" onChange={(event) => { const next = event.target.value as "queue" | "newest" | "location"; setOrder(next); remember("open-dialer-queue-order", next); }}>
              <option value="queue">{view === "callbacks" ? "Soonest first" : "Calling order"}</option>
              <option value="newest">Newest added</option>
              <option value="location">Location (state, then city)</option>
            </select>
          </div>
          {!shown.length && <p className="call-list__empty">{view === "callbacks" ? "No callbacks waiting." : view === "new" ? "No new leads left to call." : "Nothing left to call."}</p>}
          {shown.map((lead) => (
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
                <span className="dial-strip__where">{(() => { const zone = leadZone(selected); const hours = leadHours(selected); return zone ? <>{`${localTime(zone.zone)} in ${zone.place}`}{hours && <em className={hours.open ? "is-open" : "is-closed"}>{hours.text}</em>}</> : <button type="button" className="text-link" onClick={() => onEdit(selected)}>Set the state to see local time</button>; })()}</span>
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
          {pinnedEntries.length > 0 && (
            <dl className="call-pinned" aria-label="Pinned details">
              {pinnedEntries.map(([label, value]) => (
                <div key={label}>
                  <dt>{label}{pin(label)}</dt>
                  <dd>{/^(state|st|state\/province|province)$/i.test(label.trim()) && leadState(selected)
                    ? <><StateFlag lead={selected} />{leadState(selected)![0]} · {leadState(selected)![1]}</>
                    : <DetailValue value={value} />}</dd>
                </div>
              ))}
            </dl>
          )}
          {pinned.includes("@sources") && sourcesSection}
          {pinned.includes("@research") && researchSection}
          {groups.quick.length > 0 && (
            <dl className="call-facts">
              {groups.quick.map(([label, value]) => (
                <div key={label}>
                  <dt>{label}{pin(label)}</dt>
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
                <h3>{label}{pin(label)}</h3>
                <p>{value}</p>
              </div>
            ))}
            {!realNote(selected) && !groups.say.length && !pinnedEntries.length && <p className="call-script__empty">No talking points yet. <button type="button" className="text-link" onClick={() => onEdit(selected)}>Add a note</button></p>}
          </section>
          {(() => {
            const lines = automationSteps("lead", selected, state.automations, state.campaignSettings || {}).flatMap(({ campaign, step }) => (step.type === "say" && step.text.trim() ? [{ campaign, text: step.text }] : []));
            return lines.length > 0 && (
              <section className="automation-lines" aria-label="From your automations">
                {lines.map((line, index) => <blockquote className="script-say" key={index}><ScriptInline text={line.text} lead={selected} variables={state.campaignSettings?.[line.campaign]?.variables} /></blockquote>)}
              </section>
            );
          })()}
          {scriptCampaign && script && (
            <details className="call-more call-script-full" open>
              <summary><ChevronRight size={16} aria-hidden="true" /> Script <small>{scriptCampaign}</small></summary>
              <div className="call-script-full__body">
                <div className="call-script-full__tools">
                  {script.pdf && <button type="button" className="quiet-button" onClick={() => onOpenPdf(scriptCampaign)}><FileText size={16} aria-hidden="true" /> Open {script.pdf.name}</button>}
                  <button type="button" className="quiet-button" onClick={() => onEditScript(scriptCampaign)}>Edit script</button>
                  {cleanable && <button type="button" className="quiet-button" disabled={cleaning} onClick={() => void clean(cleanupItems([selected], state.campaignSettings || {}, true), true)}><Sparkles size={16} aria-hidden="true" /> {cleaning ? "Cleaning…" : "Regenerate"}</button>}
                </div>
                {script.script && <ScriptView text={script.script} lead={selected} variables={script.variables} />}
                {script.pdf && !script.script && <PdfPages campaign={scriptCampaign} />}
              </div>
            </details>
          )}
          {!pinned.includes("@research") && researchSection}
          {!pinned.includes("@sources") && sourcesSection}
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
//   **bold**             {{variable}} fills in from the lead on a call (each campaign maps its own variables)
const scriptHelp = "# Section · ## Branch · > What you say · Label: · Note: · Example: · - list · indent 2 spaces for a branch · {{variable}} fills in";

// ---- Script variables ----
// A script names its own variables, like {{fact}}. Each campaign says where each one comes from: a lead field
// ("name", "first_name", "company", "state", "phone", "role") or a CSV column kept as a lead detail ("detail:Short fact").
// Without a choice, common names are matched for you; anything else stays highlighted until you map it.
const variablePattern = /\{\{\s*([^{}]+?)\s*\}\}/g;
function scriptVariables(text: string) {
  return [...new Set([...text.matchAll(variablePattern)].map((match) => match[1].trim()))];
}
const variableFields: [string, string][] = [["name", "Contact name"], ["first_name", "First name"], ["company", "Organization"], ["state", "State"], ["phone", "Phone"], ["role", "Role"]];
const simplify = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");
// The source a variable gets when nobody picked one: a lead field by its usual names, or a detail column of the same name.
function guessVariable(name: string, detailKeys: string[]) {
  const key = simplify(name);
  if (/^(firstname|first)$/.test(key)) return "first_name";
  if (/^(name|fullname|contact|contactname|theirname|ownername|owner)$/.test(key)) return "name";
  if (/^(company|companyname|district|districtname|organization|organisation|business|businessname|schooldistrict|schoolsystem)$/.test(key)) return "company";
  if (/^(state|province)$/.test(key)) return "state";
  if (/^(phone|phonenumber|number)$/.test(key)) return "phone";
  if (/^(role|title|jobtitle)$/.test(key)) return "role";
  const column = detailKeys.find((label) => simplify(label) === key);
  return column ? `detail:${column}` : "";
}
function variableValue(source: string, lead: Lead) {
  if (source === "first_name") return lead.name ? lead.name.replace(/^(dr|mr|mrs|ms|mx)\.?\s+/i, "").split(/\s+/)[0] : "";
  if (source === "name") return lead.name || "";
  if (source === "company") return lead.company && lead.company !== "Unassigned" ? lead.company : "";
  if (source === "state") return leadState(lead)?.[1] || "";
  if (source === "phone") return formatPhone(lead.phone, lead.extension);
  if (source === "role") return lead.role && lead.role !== "Contact" ? lead.role : "";
  if (source.startsWith("detail:")) return lead.details?.[source.slice(7)]?.trim() || "";
  return "";
}
function rawVariable(name: string, lead: Lead | undefined, variables: Record<string, string> | undefined) {
  if (!lead) return "";
  const source = variables?.[name] || guessVariable(name, Object.keys(lead.details || {}));
  return source ? variableValue(source, lead) : "";
}
// The AI-cleaned version when there is one for this exact value, else the value as imported.
function fillVariable(name: string, lead: Lead | undefined, variables: Record<string, string> | undefined) {
  const raw = rawVariable(name, lead, variables);
  const spoken = lead?.spoken?.[name];
  return spoken && spoken.from === raw ? spoken.text : raw;
}
// The campaign whose script a lead's call screen shows: its first campaign with a script.
function scriptCampaignOf(lead: Lead, settings: Record<string, CampaignSettings>) {
  return lead.campaigns?.find((name) => settings[name]?.script || settings[name]?.pdf);
}
// What still needs AI cleanup for these leads: variables with an example or notes whose value has no cleaned version yet.
function cleanupItems(leads: Lead[], settings: Record<string, CampaignSettings>, force = false) {
  return leads.flatMap((lead) => {
    const campaign = scriptCampaignOf(lead, settings);
    const config = campaign ? settings[campaign] : undefined;
    return Object.keys(config?.clean || {}).flatMap((variable) => {
      const text = rawVariable(variable, lead, config!.variables);
      return text && (force || lead.spoken?.[variable]?.from !== text) ? [{ leadId: lead.id, campaign: campaign!, variable, text }] : [];
    });
  });
}

function ScriptInline({ text, lead, variables }: { text: string; lead?: Lead; variables?: Record<string, string> }) {
  return (
    <>
      {text.split(/(\*\*[^*]+\*\*|\{\{[^{}]+\}\})/).map((part, index) => {
        if (/^\*\*[^*]+\*\*$/.test(part)) return <strong key={index}>{part.slice(2, -2)}</strong>;
        if (/^\{\{[^{}]+\}\}$/.test(part)) {
          const name = part.slice(2, -2).trim();
          const value = fillVariable(name, lead, variables);
          return <mark key={index} className={value ? "script-fill" : "script-slot"} title={value ? `{{${name}}}` : `No value for {{${name}}} on this lead`}>{value || `{{${name}}}`}</mark>;
        }
        return part;
      })}
    </>
  );
}

function ScriptView({ text, lead, variables }: { text: string; lead?: Lead; variables?: Record<string, string> }) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  const flushList = () => {
    if (list.length) blocks.push(<ul key={`list-${blocks.length}`}>{list.map((item, index) => <li key={index}><ScriptInline text={item} lead={lead} variables={variables} /></li>)}</ul>);
    list = [];
  };
  // "If {{variable}} rule:" and "Otherwise:" pick which indented block is said for this lead. A chain of them
  // shows the first match (or Otherwise); with no lead (a preview), every block shows under its rule.
  let chainMatched: boolean | null = null;
  const indented = (text: string | undefined) => /^(\s{2,}|\t)\S/.test(text || "");
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const condition = indented(raw) ? null : parseCondition(raw);
    const otherwise = !condition && chainMatched !== null && !indented(raw) && isOtherwise(raw);
    if (condition || otherwise) {
      flushList();
      const body: string[] = [];
      while (index + 1 < lines.length && (indented(lines[index + 1]) || (!lines[index + 1].trim() && indented(lines[index + 2])))) body.push(lines[++index].replace(/^(\s{2}|\t)/, ""));
      const matches: boolean = condition ? !chainMatched && checkCondition(condition, lead ? rawVariable(condition.variable, lead, variables) : "") : !chainMatched;
      if (condition) chainMatched = Boolean(chainMatched) || matches;
      else chainMatched = null;
      if (lead ? matches : true) blocks.push(
        <div className="script-branch script-if" key={`if-${index}`}>
          <small className="script-if__rule">{condition ? `Because ${describeCondition(condition)}` : "Otherwise"}</small>
          <ScriptView text={body.join("\n")} lead={lead} variables={variables} />
        </div>,
      );
      continue;
    }
    if (raw.trim() && !indented(raw)) chainMatched = null;
    // A run of indented lines is a branch: rendered the same way, inside an indented rule.
    if (/^(\s{2,}|\t)\S/.test(raw)) {
      flushList();
      const branch: string[] = [];
      while (index < lines.length && (/^(\s{2,}|\t)\S/.test(lines[index]) || (!lines[index].trim() && /^(\s{2,}|\t)\S/.test(lines[index + 1] || "")))) branch.push(lines[index++].replace(/^(\s{2}|\t)/, ""));
      index -= 1;
      blocks.push(<div className="script-branch" key={`branch-${index}`}><ScriptView text={branch.join("\n")} lead={lead} variables={variables} /></div>);
      continue;
    }
    const line = raw.trim();
    if (/^[-*]\s+/.test(line)) { list.push(line.replace(/^[-*]\s+/, "")); continue; }
    flushList();
    if (!line) continue;
    const key = `line-${index}`;
    if (/^##\s+/.test(line)) blocks.push(<h4 className="script-sub" key={key}><ScriptInline text={line.replace(/^##\s+/, "")} lead={lead} variables={variables} /></h4>);
    else if (/^#\s+/.test(line)) blocks.push(<h3 className="script-section" key={key}><ScriptInline text={line.replace(/^#\s+/, "")} lead={lead} variables={variables} /></h3>);
    else if (/^>\s?/.test(line)) blocks.push(<blockquote className="script-say" key={key}><ScriptInline text={line.replace(/^>\s?/, "")} lead={lead} variables={variables} /></blockquote>);
    else if (/^["“].+["”]$/.test(line)) blocks.push(<blockquote className="script-say" key={key}><ScriptInline text={line.slice(1, -1)} lead={lead} variables={variables} /></blockquote>);
    else if (/^(note|flow):\s*/i.test(line)) blocks.push(<blockquote className="script-note" key={key}><ScriptInline text={line.replace(/^(note|flow):\s*/i, "")} lead={lead} variables={variables} /></blockquote>);
    else if (/^example:\s*/i.test(line)) blocks.push(<p className="script-example" key={key}><ScriptInline text={line} lead={lead} variables={variables} /></p>);
    else if (line.endsWith(":") && line.length <= 70 && !/[.!?]\s/.test(line)) blocks.push(<p className="script-label" key={key}><ScriptInline text={line.slice(0, -1)} lead={lead} variables={variables} /></p>);
    else blocks.push(<p key={key}><ScriptInline text={line} lead={lead} variables={variables} /></p>);
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
// **bold** shows as bold while editing; {{variables}} show as chips that delete as one piece.
const variableChip = (name: string) => `<span class="se-var" contenteditable="false">{{${escapeHtml(name)}}}</span>`;
const inlineToHtml = (text: string) => escapeHtml(text).replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, name) => variableChip(name));
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
  return out.replace(/\u00a0/g, " ").replace(/\u200b/g, "");
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

function ScriptEditor({ initial, editorRef, onTextChange }: { initial: string; editorRef: { current: HTMLDivElement | null }; onTextChange?: (text: string) => void }) {
  const [empty, setEmpty] = useState(!initial.trim());
  const [variableOpen, setVariableOpen] = useState(false);
  const [variableName, setVariableName] = useState("");
  const savedRange = useRef<Range | null>(null);
  const changed = () => { if (editorRef.current && onTextChange) onTextChange(serializeScript(editorRef.current)); };
  const known = () => (editorRef.current ? scriptVariables(serializeScript(editorRef.current)) : []);
  // Puts {{name}} where the cursor was before the variable box opened.
  const insertVariable = (name: string) => {
    const clean = name.replace(/[{}]/g, "").trim();
    if (!clean) return;
    const editor = editorRef.current;
    if (!editor) return;
    editor.focus();
    // Into the line the cursor was in; with no cursor, at the end of the last line.
    const start = savedRange.current?.startContainer;
    const line = (start && (start.nodeType === Node.ELEMENT_NODE ? (start as Element) : start.parentElement)?.closest<HTMLElement>(".se-line")) || editor.querySelector<HTMLElement>(".se-line:last-child");
    if (!line) return;
    let range = savedRange.current && line.contains(savedRange.current.startContainer) ? savedRange.current : null;
    if (!range) { range = document.createRange(); range.selectNodeContents(line); range.collapse(false); }
    line.querySelector(":scope > br:only-child")?.remove();
    const holder = document.createElement("span");
    holder.innerHTML = variableChip(clean);
    const chip = holder.firstChild!;
    // An invisible character to put the cursor after the tag; it is dropped when the script is saved.
    const space = document.createTextNode("​");
    range.deleteContents();
    range.insertNode(space);
    range.insertNode(chip);
    const after = document.createRange();
    after.setStart(space, 1);
    after.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(after);
    setVariableOpen(false);
    setVariableName("");
    normalize();
    changed();
  };
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
    const rule = line.dataset.type === "p" && (Boolean(parseCondition(lineText(line))) || isOtherwise(lineText(line)));
    line.classList.toggle("is-condition", rule);
    line.classList.toggle("is-otherwise", rule && isOtherwise(lineText(line)));
    line.classList.toggle("is-label", !rule && line.dataset.type === "p" && isLabelText(line.textContent || ""));
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
  // A {{name}} typed by hand becomes a tag as soon as its closing braces are typed, same as the Variable button makes.
  const tagTypedVariable = () => {
    const line = currentLine();
    if (!line) return;
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
      if (node.parentElement?.closest(".se-var")) continue;
      const match = node.data.match(/\{\{\s*([^{}]+?)\s*\}\}|\(\(\s*([^()]+?)\s*\)\)/);
      if (!match) continue;
      const start = node.splitText(match.index!);
      const rest = start.splitText(match[0].length);
      const holder = document.createElement("span");
      holder.innerHTML = variableChip(match[1] || match[2]);
      start.replaceWith(holder.firstChild!);
      // The cursor goes after the tag; an invisible character holds its place and is dropped on save.
      if (!rest.data.startsWith("​")) rest.insertData(0, "​");
      const after = document.createRange();
      after.setStart(rest, 1);
      after.collapse(true);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(after);
      return;
    }
  };
  const onInput = () => {
    tagTypedVariable();
    normalize();
    changed();
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
    // Scripts written elsewhere often mark blanks as ((NAME)); those become {{NAME}} variables too.
    const text = event.clipboardData.getData("text/plain").replace(/\(\(\s*([^()]+?)\s*\)\)/g, "{{$1}}");
    if (!text.includes("\n")) {
      // One line: tag every variable in it, not just the first.
      if (/\{\{[^{}]+\}\}/.test(text)) document.execCommand("insertHTML", false, inlineToHtml(text));
      else document.execCommand("insertText", false, text);
      return;
    }
    // Several lines: paste them as blocks after the current line (into it, if it's empty).
    const line = currentLine();
    const blocks = parseScriptBlocks(text).map((block) => blockElement(block.type, block.indent, inlineToHtml(block.text)));
    blocks.forEach(markLabel);
    if (line && !(line.textContent || "").trim()) line.replaceWith(...blocks);
    else if (line) line.after(...blocks);
    else editorRef.current?.append(...blocks);
    placeCaret(blocks[blocks.length - 1], Number.MAX_SAFE_INTEGER);
    normalize();
    changed();
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
        <button
          type="button"
          title="Insert a variable, like {{fact}}, that fills in from each lead"
          aria-expanded={variableOpen}
          onMouseDown={(event) => { event.preventDefault(); const selection = window.getSelection(); savedRange.current = selection?.rangeCount && editorRef.current?.contains(selection.anchorNode) ? selection.getRangeAt(0).cloneRange() : null; }}
          onClick={() => setVariableOpen((open) => !open)}
        >{"{{ }}"} Variable</button>
        <button
          type="button"
          title="Lines that only show when a lead's value matches, e.g. If {{lead_type}} is no website"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            // A rule line plus one indented line to say; change the variable, the rule and the words in place.
            const editor = editorRef.current;
            if (!editor) return;
            const variable = known()[0] || "lead_type";
            const rule = blockElement("p", 0, `If ${variableChip(variable)}&#8203; is no website:`);
            const say = blockElement("say", 1, "What to say when it matches");
            markLabel(rule);
            const line = currentLine();
            if (line && editor.contains(line)) line.after(rule, say);
            else editor.append(rule, say);
            placeCaret(rule, Number.MAX_SAFE_INTEGER);
            normalize();
            changed();
          }}
        >Only if</button>
      </div>
      {variableOpen && (
        <div className="script-variable-box" role="group" aria-label="Insert a variable">
          {known().map((name) => <button type="button" key={name} className="se-var" onClick={() => insertVariable(name)}>{`{{${name}}}`}</button>)}
          <input value={variableName} onChange={(event) => setVariableName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); insertVariable(variableName); } if (event.key === "Escape") setVariableOpen(false); }} placeholder="New variable, like fact" aria-label="New variable name" autoFocus />
          <button type="button" className="quiet-button" onClick={() => insertVariable(variableName)} disabled={!variableName.trim()}>Insert</button>
        </div>
      )}
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
      <small className="script-dialog__help">Shortcuts at the start of a line: <b># </b> section · <b>## </b> branch · <b>&gt; </b> say this · <b>- </b> list · <b>Note: </b> note · a short line ending in <b>:</b> is a label · Tab indents into a branch · <b>{"{{fact}}"}</b> is a variable you fill from each lead</small>
    </div>
  );
}

// Where each script variable gets its value. Columns are the CSV's (at import) or the leads' saved details.
function VariableMap({ names, value, columns, onChange, auto }: { names: string[]; value: Record<string, string>; columns: string[]; onChange: (next: Record<string, string>) => void; auto: (name: string) => string }) {
  if (!names.length) return null;
  const label = (source: string) => variableFields.find(([key]) => key === source)?.[1] || source.replace(/^detail:/, "");
  return (
    <div className="variable-map">
      {names.map((name) => {
        const guess = auto(name);
        return (
          <label key={name}>
            <span className="se-var">{`{{${name}}}`}</span>
            <select value={value[name] || ""} onChange={(event) => onChange({ ...value, [name]: event.target.value })}>
              <option value="">{guess ? `Automatic: ${label(guess)}` : "Not set, shows as a blank"}</option>
              <optgroup label="Lead fields">{variableFields.map(([key, text]) => <option key={key} value={key}>{text}</option>)}</optgroup>
              {columns.length > 0 && <optgroup label="Columns">{columns.map((column) => <option key={column} value={`detail:${column}`}>{column}</option>)}</optgroup>}
            </select>
          </label>
        );
      })}
    </div>
  );
}

// Add or edit a campaign's script: write it in the live editor and/or upload a PDF.
// One campaign's settings, one part at a time from a sidebar: General (name, deal value, leads), Script (text, PDF),
// Variables (what fills each {{variable}}, and how AI should clean it). Every part stays mounted, so switching keeps edits.
type CampaignTab = "general" | "script" | "variables";
function ScriptDialog({ campaign, initialTab = "script", settings, columns, leads, aiReady, vault = [], onOpenVault = () => {}, onImport, onViewPdf, onClose, onChanged }: { campaign: string; initialTab?: CampaignTab; settings: CampaignSettings; columns: string[]; leads: Lead[]; aiReady: boolean; vault?: Recording[]; onOpenVault?: () => void; onImport: () => void; onViewPdf: () => void; onClose: () => void; onChanged: (message: string, close: boolean, name: string) => Promise<void> }) {
  const editorRef = useRef<HTMLDivElement | null>(null);
  // An empty campaign name means a new campaign: name it, write the script, then import its leads.
  const isNew = !campaign;
  const [name, setName] = useState(campaign);
  const [value, setValue] = useState(settings.value ? String(settings.value) : "");
  const [text, setText] = useState(settings.script || "");
  const [variables, setVariables] = useState<Record<string, string>>(settings.variables || {});
  const [clean, setClean] = useState<Record<string, CleanRule>>(settings.clean || {});
  const [tab, setTab] = useState<CampaignTab>(isNew ? "general" : initialTab);
  const names = scriptVariables(text);
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
      await onChanged(message, close, name.trim());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the script.");
    } finally {
      setBusy(false);
    }
  };
  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const script = editorRef.current ? serializeScript(editorRef.current) : settings.script || "";
    if (!name.trim()) return setError("Name the campaign first.");
    // Only keep choices for variables still in the script.
    const kept = Object.fromEntries(Object.entries(variables).filter(([key, source]) => source && scriptVariables(script).includes(key)));
    const rules = Object.fromEntries(Object.entries(clean).filter(([key, rule]) => scriptVariables(script).includes(key) && (rule.to.trim() || rule.notes.trim())));
    void run(() => api("/api/campaigns/script", { method: "PUT", body: JSON.stringify({ campaign: name.trim(), script, variables: kept, clean: rules, value: value.replace(/[$,\s]/g, "") }) }), isNew ? `${name.trim()} created.` : `${name.trim()} saved.`, true);
  };
  const upload = (file: File | undefined) => {
    if (!file) return;
    // Uploads are capped at 5 MB of text, and base64 adds a third.
    if (file.size > 3_500_000) return setError("That PDF is over 3.5 MB. Export a smaller one, or paste the script as text.");
    const reader = new FileReader();
    if (!name.trim()) return setError("Name the campaign first.");
    reader.onload = () => void run(() => api("/api/campaigns/script-pdf", { method: "POST", body: JSON.stringify({ campaign: name.trim(), fileName: file.name, data: String(reader.result).split(",")[1] || "" }) }), `${file.name} added to ${name.trim()}.`, false);
    reader.readAsDataURL(file);
  };
  return (
    <div className="modal-backdrop" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <form className="lead-form script-dialog campaign-settings" onSubmit={save} role="dialog" aria-modal="true" aria-labelledby="script-dialog-title">
        <button type="button" className="close-button" onClick={onClose} aria-label="Close"><X /></button>
        <h2 id="script-dialog-title">{isNew ? "New campaign" : campaign}</h2>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="campaign-settings__body">
          <nav className="campaign-settings__nav" aria-label="Campaign settings">
            {([["general", "General"], ["script", "Script"], ["variables", "Variables"]] as [CampaignTab, string][]).map(([id, label]) => (
              <button key={id} type="button" className={tab === id ? "is-active" : ""} aria-current={tab === id ? "page" : undefined} onClick={() => setTab(id)}>
                {label}{id === "variables" && names.length > 0 && <small>{names.length}</small>}
              </button>
            ))}
          </nav>
          <div className="campaign-settings__panel">
            <section hidden={tab !== "general"} className="campaign-settings__section">
              {isNew && <label>Campaign name<input value={name} onChange={(event) => setName(event.target.value)} placeholder="NC school districts" required autoFocus /></label>}
              <label><span>Deal value<small>for each won lead</small></span><input value={value} onChange={(event) => setValue(event.target.value)} inputMode="decimal" placeholder="$0" /></label>
              {!isNew && (
                <label className="campaign-settings__check">
                  <input type="checkbox" checked={settings.transcribe !== false} onChange={(event) => void run(() => api("/api/campaigns/script", { method: "PUT", body: JSON.stringify({ campaign, transcribe: event.target.checked }) }), event.target.checked ? "Calls in this campaign will be transcribed when Live transcription is on." : "Calls in this campaign won't be transcribed.", false)} />
                  <span>Transcribe calls in this campaign<small>When Live transcription is on in Settings → Features & costs ({money(prices.twilioTranscription.amount)} a minute)</small></span>
                </label>
              )}
              {!isNew && (
                <div className="campaign-settings__leads">
                  <span>Leads<b>{leads.length}</b></span>
                  <button type="button" className="quiet-button" onClick={onImport}><FileUp size={16} aria-hidden="true" /> Import leads</button>
                </div>
              )}
              {isNew && <p className="campaign-settings__hint">Next, write the script. Put {"{{variables}}"} where each lead's details go; you'll match them to your CSV's columns when you import the leads.</p>}
            </section>
            <section hidden={tab !== "script"} className="campaign-settings__section">
              <p className="campaign-settings__hint">Shows on the call screen for every lead in this campaign.</p>
              <ScriptEditor initial={settings.script || ""} editorRef={editorRef} onTextChange={setText} />
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
            </section>
            <section hidden={tab !== "variables"} className="campaign-settings__section">
              {names.length ? (
                <>
                  <p className="campaign-settings__hint">Pick what fills each variable on a call. Give an example of how you'd say it and AI cleans each lead's value while you call.{!aiReady && " Add an AI key in Settings, AI to turn that on."}</p>
                  {names.map((variable) => (
                    <VariableCard
                      key={variable}
                      variable={variable}
                      campaign={campaign}
                      source={variables[variable] || ""}
                      columns={columns}
                      leads={leads}
                      rule={clean[variable]}
                      aiReady={aiReady}
                      onSource={(source) => setVariables((current) => ({ ...current, [variable]: source }))}
                      onRule={(rule) => setClean((current) => { const next = { ...current }; if (rule) next[variable] = rule; else delete next[variable]; return next; })}
                    />
                  ))}
                </>
              ) : <p className="campaign-settings__hint">No variables yet. Add one in the script with the Variable button, like {"{{first_name}}"}.</p>}
            </section>
          </div>
        </div>
        <div className="task-dialog__actions">
          <button type="button" className="quiet-button" onClick={onClose}>Cancel</button>
          <button className="primary-button" disabled={busy}>{busy ? "Saving…" : isNew ? "Create campaign" : "Save"}</button>
        </div>
      </form>
    </div>
  );
}

function RecorderDialog({ script, onClose, onSaved }: { script: string; onClose: () => void; onSaved: (message: string) => Promise<void> }) {
  const [name, setName] = useState("");
  const [state, setState] = useState<"idle" | "recording" | "ready" | "saving">("idle");
  const [error, setError] = useState<string | null>(null);
  const [take, setTake] = useState<{ blob: Blob; seconds: number; url: string; fileName: string } | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const recorder = useRef<MediaRecorder | null>(null);
  useEffect(() => {
    if (state !== "recording") return;
    const started = Date.now();
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 250);
    return () => window.clearInterval(timer);
  }, [state]);
  useEffect(() => () => { if (take) URL.revokeObjectURL(take.url); }, [take]);
  const start = async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const media = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      media.ondataavailable = (event) => chunks.push(event.data);
      media.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        void toWav(new Blob(chunks, { type: media.mimeType })).then(({ blob, seconds }) => { setTake({ blob, seconds, url: URL.createObjectURL(blob), fileName: "recording.wav" }); setState("ready"); }).catch(() => { setError("Couldn't read that recording. Try again."); setState("idle"); });
      };
      recorder.current = media;
      setElapsed(0);
      media.start();
      setState("recording");
    } catch {
      setError("Allow the microphone for this site to record, or upload an MP3 or WAV instead.");
    }
  };
  const upload = async (file: File | undefined) => {
    if (!file) return;
    setTake({ blob: file, seconds: await audioSeconds(file), url: URL.createObjectURL(file), fileName: file.name });
    if (!name.trim()) setName(file.name.replace(/\.(mp3|wav)$/i, ""));
    setState("ready");
  };
  const save = async () => {
    if (!take) return;
    if (take.blob.size > 3_500_000) return setError("That recording is over 3.5 MB. Keep voicemails short.");
    setState("saving");
    try {
      await api("/api/voicemails", { method: "POST", body: JSON.stringify({ name: name.trim() || "Voicemail", seconds: take.seconds, data: await blobToBase64(take.blob) }) });
      await onSaved(`${name.trim() || "Voicemail"} saved.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't save the recording.");
      setState("ready");
    }
  };
  return (
    <div className="modal-backdrop">
      <section className="lead-form recorder" role="dialog" aria-modal="true" aria-labelledby="recorder-title">
        <button type="button" className="close-button" onClick={onClose} aria-label="Close"><X /></button>
        <h2 id="recorder-title">New voicemail</h2>
        {error && <p className="form-error" role="alert">{error}</p>}
        <label>Name<input value={name} onChange={(event) => setName(event.target.value)} placeholder="No website, friendly" maxLength={80} autoFocus /></label>
        {script && <div className="recorder__script"><small>What to say</small><p>{script}</p></div>}
        <div className="recorder__stage">
          {state === "recording"
            ? <button type="button" className="recorder__button is-recording" onClick={() => recorder.current?.stop()} aria-label="Stop recording"><span /></button>
            : <button type="button" className="recorder__button" onClick={() => void start()} disabled={state === "saving"} aria-label={take ? "Record again" : "Start recording"}><Mic size={28} aria-hidden="true" /></button>}
          <b>{state === "recording" ? clockOf(elapsed) : take ? clockOf(take.seconds) : "0:00"}</b>
          <small>{state === "recording" ? "Recording. Press to stop." : take ? "Listen back, then save or record again." : "Press to record."}</small>
          {state === "recording" && elapsed >= 30 && <small className="recorder__warn">Over 30 seconds: many voicemail boxes cut off around here.</small>}
          {take && state !== "recording" && <audio controls src={take.url} />}
          {take && take.seconds > 30 && state !== "recording" && <small className="recorder__warn">{clockOf(take.seconds)} long. Many voicemail boxes cut off around 30 seconds.</small>}
        </div>
        <div className="task-dialog__actions">
          <label className="quiet-button script-dialog__file">Upload MP3 or WAV<input type="file" accept="audio/mpeg,audio/wav,.mp3,.wav" onChange={(event) => { void upload(event.target.files?.[0]); event.target.value = ""; }} /></label>
          <button type="button" className="primary-button" disabled={!take || state !== "ready"} onClick={() => void save()}>{state === "saving" ? "Saving…" : "Save to Voicemails"}</button>
        </div>
      </section>
    </div>
  );
}

// The voicemail vault: every recording once, reusable in any campaign.
function VoicemailsPage({ vault, automations, settings, campaign, onRefresh, onNotice }: { vault: Recording[]; automations: Automation[]; settings: Record<string, CampaignSettings>; campaign: string; onRefresh: () => Promise<unknown>; onNotice: (message: string) => void }) {
  const [recording, setRecording] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const usedIn = (id: string) => automations.filter((item) => item.steps.some((step) => step.type === "play" && step.recordingId === id)).map((item) => item.name);
  // While recording, the picked campaign's first voicemail line (a Note or line mentioning voicemail) is shown as a prompt.
  const prompt = (settings[campaign]?.script || "").split("\n").map((line) => line.trim()).find((line) => /voicemail/i.test(line) && line.length > 20)?.replace(/^(>|note:|example:)\s*/i, "") || "";
  const act = async (work: () => Promise<unknown>, message: string) => {
    try { await work(); await onRefresh(); onNotice(message); } catch (cause) { onNotice(cause instanceof Error ? cause.message : "Something went wrong."); }
  };
  return (
    <section className="campaigns-page">
      <div className="campaigns-head">
        <p>Your recorded voicemails. Record once, then pick them in any campaign's automations.</p>
        <div className="campaigns-head__actions"><button type="button" className="primary-button" onClick={() => setRecording(true)}><Mic size={16} aria-hidden="true" /> New voicemail</button></div>
      </div>
      {!vault.length && <div className="empty-state">No voicemails yet. Press New voicemail to record one in your own voice, or upload an MP3.</div>}
      <div className="vault-list">
        {vault.map((item) => {
          const campaigns = usedIn(item.id);
          return (
            <article className="vault-item" key={item.id}>
              <div className="vault-item__head">
                {renaming === item.id
                  ? <form onSubmit={(event) => { event.preventDefault(); setRenaming(null); void act(() => api(`/api/voicemails/${item.id}`, { method: "PATCH", body: JSON.stringify({ name: draft }) }), "Renamed."); }}><input value={draft} onChange={(event) => setDraft(event.target.value)} autoFocus maxLength={80} aria-label="New name" onBlur={() => setRenaming(null)} /></form>
                  : <button type="button" className="vault-item__name" title="Rename" onClick={() => { setRenaming(item.id); setDraft(item.name); }}>{item.name}</button>}
                <small>{clockOf(item.seconds)}{item.seconds > 30 ? " · long" : ""}</small>
              </div>
              <audio controls preload="none" src={`/api/voicemails/${item.id}/audio`} />
              <div className="vault-item__foot">
                <small>{campaigns.length ? `Used in ${campaigns.join(", ")}` : "Not used in an automation yet"}</small>
                <button type="button" className="text-link" onClick={() => { if (window.confirm(`Delete ${item.name}?${campaigns.length ? " Automations using it will stop dropping it." : ""}`)) void act(() => api(`/api/voicemails/${item.id}`, { method: "DELETE" }), `${item.name} deleted.`); }}>Delete</button>
              </div>
            </article>
          );
        })}
      </div>
      {recording && <RecorderDialog script={prompt} onClose={() => setRecording(false)} onSaved={async (message) => { setRecording(false); await onRefresh(); onNotice(message); }} />}
    </section>
  );
}

// One variable: where its value comes from, and (optionally) how AI should clean it, with a try-out on real leads.
function VariableCard({ variable, campaign, source, columns, leads, rule, aiReady, onSource, onRule }: { variable: string; campaign: string; source: string; columns: string[]; leads: Lead[]; rule?: CleanRule; aiReady: boolean; onSource: (source: string) => void; onRule: (rule: CleanRule | null) => void }) {
  const mapping = source ? { [variable]: source } : {};
  const raws = [...new Set(leads.map((lead) => rawVariable(variable, lead, mapping)).filter(Boolean))];
  const cleaned = leads.filter((lead) => { const raw = rawVariable(variable, lead, mapping); return raw && lead.spoken?.[variable]?.from === raw; }).length;
  const [preview, setPreview] = useState<{ busy: boolean; results?: [string, string][]; error?: string }>({ busy: false });
  const [forgot, setForgot] = useState(false);
  const runPreview = async () => {
    if (!rule) return;
    const texts = raws.slice(0, 3);
    setPreview({ busy: true });
    try {
      const result = await api<{ results: string[] }>("/api/ai/preview", { method: "POST", body: JSON.stringify({ variable, rule, texts }) });
      setPreview({ busy: false, results: texts.map((text, index) => [text, result.results[index]]) });
    } catch (cause) {
      setPreview({ busy: false, error: cause instanceof Error ? cause.message : "The try-out failed." });
    }
  };
  return (
    <article className="variable-card">
      <VariableMap names={[variable]} value={mapping} columns={columns} onChange={(next) => onSource(next[variable] || "")} auto={(name) => guessVariable(name, columns)} />
      {/* What this variable actually says on calls, from real leads, so you can judge whether it needs cleaning. */}
      <div className="variable-card__samples" aria-label={`Values of {{${variable}}} from your leads`}>
        {raws.length
          ? <>{raws.slice(0, 3).map((value) => <span key={value}>{value}</span>)}{raws.length > 3 && <small>+{raws.length - 3} more</small>}</>
          : <small>{leads.length ? "None of this campaign's leads has a value for this yet." : "Import leads to see what this says."}</small>}
      </div>
      <label className="variable-card__toggle">
        <input type="checkbox" checked={Boolean(rule)} disabled={!aiReady && !rule} onChange={(event) => onRule(event.target.checked ? { from: raws[0] || "", to: "", notes: "" } : null)} />
        Clean with AI
        {rule && leads.length > 0 && <small>{cleaned} of {leads.length} leads cleaned so far</small>}
      </label>
      {rule && (
        <div className="variable-card__rule">
          <label>Example from a lead<textarea rows={2} value={rule.from} onChange={(event) => onRule({ ...rule, from: event.target.value })} placeholder="14 of 36 graded schools received D/F grades in 2024-25" /></label>
          <label>How you'd say it<textarea rows={2} value={rule.to} onChange={(event) => onRule({ ...rule, to: event.target.value })} placeholder="14 of your schools got a D or below last year" /></label>
          <label><span>Notes<small>optional</small></span><textarea rows={2} value={rule.notes} onChange={(event) => onRule({ ...rule, notes: event.target.value })} placeholder="Under 15 words. Say 'your schools'. Drop titles in brackets." /></label>
          <div className="variable-card__actions">
            <button type="button" className="quiet-button" disabled={preview.busy || !raws.length || !(rule.to.trim() || rule.notes.trim())} onClick={() => void runPreview()}><Sparkles size={16} aria-hidden="true" /> {preview.busy ? "Trying…" : "Try on 3 leads"}</button>
            {!!campaign && leads.some((lead) => lead.spoken?.[variable]) && <button type="button" className="text-link" disabled={forgot} onClick={() => void api("/api/ai/forget", { method: "POST", body: JSON.stringify({ campaign, variable }) }).then(() => setForgot(true))}>{forgot ? "Will regenerate as you call" : "Regenerate for all leads"}</button>}
          </div>
          {preview.error && <p className="form-error" role="alert">{preview.error}</p>}
          {preview.results && <ul className="variable-card__preview">{preview.results.map(([from, to], index) => <li key={index}><small>{from}</small><b>{to}</b></li>)}</ul>}
          <small className="variable-card__note">Changes apply to leads not cleaned yet. Leads already cleaned keep theirs until you regenerate.</small>
        </div>
      )}
    </article>
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
  settings,
}: {
  leads: Lead[];
  calls: CallRecord[];
  onMove: (lead: Lead, stage: string) => void;
  onEdit: (lead: Lead) => void;
  onCall: (id: string) => void;
  onAddTask: (lead: Lead) => void;
  settings: Record<string, CampaignSettings>;
}) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [peekId, setPeekId] = useState<string | null>(null);
  const peek = leads.find((lead) => lead.id === peekId);
  const [over, setOver] = useState<string | null>(null);
  const won = leads.filter((lead) => lead.status === "Won").reduce((sum, lead) => sum + dealValue(lead, settings), 0);
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
                    <StageLine lead={lead} calls={calls} value={dealValue(lead, settings)} />
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

// Campaigns with leads, plus new ones that so far only have a script.
function allCampaigns(leads: Lead[], settings: Record<string, CampaignSettings>) {
  return [...new Set([...campaignsOf(leads), ...Object.keys(settings).filter((name) => settings[name]?.script || settings[name]?.pdf)])].sort((left, right) => left.localeCompare(right));
}

function Campaigns({ leads, onStart, onView, onStage, onImport, settings, onScript }: { leads: Lead[]; onStart: (name: string) => void; onView: (name: string) => void; onStage: (name: string) => void; onImport: (name?: string) => void; settings: Record<string, CampaignSettings>; onScript: (name: string) => void }) {
  const names = allCampaigns(leads, settings);
  const untagged = leads.filter((lead) => !lead.campaigns?.length).length;
  return (
    <section className="campaigns-page">
      <div className="campaigns-head">
        <p>Start a campaign with its script, then import its leads. Pick a campaign to call only its leads.</p>
        <div className="campaigns-head__actions">
          <button type="button" className="quiet-button" onClick={() => onImport()}><FileUp size={16} aria-hidden="true" /> Import into a campaign</button>
          <button type="button" data-tour="new-campaign" className={names.length ? "quiet-button" : "primary-button"} onClick={() => onScript("")}><Plus size={16} aria-hidden="true" /> New campaign</button>
        </div>
      </div>
      {!names.length && <div className="empty-state">No campaigns yet. Start one with New campaign, or import a CSV and give it a campaign name.</div>}
      <div className="campaign-list">
        {names.map((name) => {
          const items = leads.filter((lead) => lead.campaigns?.includes(name));
          const toCall = items.filter(inQueue).length;
          return (
            <article className="campaign-card" key={name}>
              <header><h2>{name}</h2><span>{items.length} lead{items.length === 1 ? "" : "s"}{settings[name]?.script || settings[name]?.pdf ? " · Script" : ""}{settings[name]?.value ? ` · $${settings[name]!.value!.toLocaleString()} a deal` : ""}</span></header>
              {/* One bar for the whole campaign: each stage's share of its leads, same colors as the counts below. */}
              <div className="campaign-bar" aria-hidden="true">
                {leadStages.map((stage) => { const count = items.filter((lead) => lead.status === stage).length; return count ? <i key={stage} className={`dot--${campaignStageTone[stage]}`} style={{ flexGrow: count }} /> : null; })}
              </div>
              <dl className="campaign-stages">
                {leadStages.map((stage) => <div key={stage}><dt><button type="button" className="stretch-link" onClick={() => onStage(name)} title={`Open ${name} on the pipeline`}><Dots tones={[campaignStageTone[stage]]} />{stage === "Meeting booked" ? "Meetings" : stage}</button></dt><dd>{items.filter((lead) => lead.status === stage).length}</dd></div>)}
              </dl>
              <div className="campaign-card__actions">
                <button type="button" className="text-link" data-tour="campaign-settings" onClick={() => onScript(name)}><SlidersHorizontal size={14} aria-hidden="true" /> Settings</button>
                {items.length ? <button type="button" className="text-link" onClick={() => onView(name)}>View leads</button> : null}
                {items.length
                  ? <button type="button" className="primary-button" disabled={!toCall} onClick={() => onStart(name)}><PhoneCall size={16} aria-hidden="true" /> Start calling ({toCall})</button>
                  : <button type="button" className="primary-button" onClick={() => onImport(name)}><FileUp size={16} aria-hidden="true" /> Import leads</button>}
              </div>
            </article>
          );
        })}
      </div>
      {untagged > 0 && names.length > 0 && <p className="campaigns-note">{untagged} lead{untagged === 1 ? " isn't" : "s aren't"} in a campaign. Add one when you edit a lead, or import the CSV again into a campaign.</p>}
    </section>
  );
}

// The "If {{variable}} rule:" lines in a script (not the indented lines under them), as plain words.
function scriptRules(text = "") {
  return text.replace(/\r\n/g, "\n").split("\n").filter((line) => !/^(\s{2,}|\t)\S/.test(line)).map((line) => parseCondition(line)).filter((rule): rule is NonNullable<typeof rule> => Boolean(rule)).map((rule) => `If ${describeCondition(rule)}`);
}
// One card per campaign: what its script has, with links into that campaign's Settings popup.
function ScriptsPage({ leads, settings, campaign, onEdit }: { leads: Lead[]; settings: Record<string, CampaignSettings>; campaign: string; onEdit: (name: string, tab: CampaignTab) => void }) {
  const names = allCampaigns(leads, settings).filter((name) => !campaign || name === campaign);
  return (
    <section className="campaigns-page">
      <div className="campaigns-head"><p>Each campaign's script, its variables and voicemails. Edit them in the campaign's settings.</p></div>
      {!names.length && <div className="empty-state">No campaigns yet. Start one on the Campaigns page.</div>}
      <div className="campaign-list">
        {names.map((name) => {
          const own = settings[name] || {};
          const script = own.script?.trim() ? (own.pdf ? "Text and PDF" : "Text") : own.pdf ? "PDF" : "None";
          return (
            <article className="campaign-card" key={name}>
              <header><h2>{name}</h2><span>{(() => { const count = leads.filter((lead) => lead.campaigns?.includes(name)).length; return `${count} lead${count === 1 ? "" : "s"}`; })()}</span></header>
              <dl className="campaign-stages campaign-stages--static">
                <div><dt>Script</dt><dd>{script}</dd></div>
                <div><dt>Variables</dt><dd>{scriptVariables(own.script || "").length}</dd></div>
                <div><dt>Only-if rules</dt><dd>{scriptRules(own.script).length}</dd></div>
              </dl>
              <div className="campaign-card__actions">
                <button type="button" className="text-link" onClick={() => onEdit(name, "variables")}>Variables</button>
                <button type="button" className="primary-button" onClick={() => onEdit(name, "script")}><FileText size={16} aria-hidden="true" /> {script === "None" ? "Write the script" : "Edit script"}</button>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

// ---- Automations, n8n style ----
const triggerInfo: Record<AutomationTrigger, { title: string; detail: string; icon: typeof PhoneCall }> = {
  lead: { title: "Lead comes up", detail: "When a lead opens on the call screen", icon: UserRound },
  outcome: { title: "Call outcome logged", detail: "After you log how a call went", icon: ClipboardList },
  voicemail: { title: "Voicemail dropped", detail: "When you press Drop voicemail at the beep", icon: Voicemail },
  transcribed: { title: "Call transcribed", detail: "After a transcribed call ends and you log the outcome", icon: FileText },
};
const stepInfo: Record<AutomationStep["type"], { title: string; detail: string; icon: typeof PhoneCall }> = {
  if: { title: "Only continue if", detail: "Stop here unless the lead matches", icon: Filter },
  say: { title: "Show a line", detail: "A line to say, at the top of the call screen", icon: MessageSquare },
  ask: { title: "Ask AI", detail: "Ask about the call and save the answer to a lead field", icon: Sparkles },
  wait: { title: "Wait", detail: "Pause, then carry on with the next steps", icon: Hourglass },
  email: { title: "Send email", detail: "Email the lead from your own domain (Settings → Email)", icon: Mail },
  sms: { title: "Send text", detail: "Text the lead from your Twilio number", icon: Send },
  play: { title: "Play a voicemail", detail: "One of your Voicemails, then hang up", icon: Volume2 },
  stage: { title: "Move to stage", detail: "Put the lead in another pipeline stage", icon: Tag },
  followup: { title: "Follow up later", detail: "Set the follow-up some business days out", icon: CalendarClock },
};
// Which steps make sense after each trigger.
const stepsFor: Record<AutomationTrigger, AutomationStep["type"][]> = { lead: ["if", "say"], outcome: ["if", "wait", "email", "sms", "stage", "followup"], voicemail: ["if", "play"], transcribed: ["ask", "if", "wait", "email", "sms", "stage", "followup"] };
const conditionOps: ConditionOp[] = ["is", "is not", "contains", "is empty", "is not empty"];
function newStep(type: AutomationStep["type"]): AutomationStep {
  if (type === "if") return { type, field: "", op: "is", value: "" };
  if (type === "say") return { type, text: "" };
  if (type === "ask") return { type, prompt: "", field: "Call summary" };
  if (type === "wait") return { type, amount: 1, unit: "days" };
  if (type === "email") return { type, to: "", subject: "", body: "" };
  if (type === "sms") return { type, text: "" };
  if (type === "play") return { type, recordingId: "" };
  if (type === "stage") return { type, stage: "Follow-up" };
  return { type, days: 2 };
}
function fieldLabel(field: string) {
  if (field.startsWith("detail:")) return field.slice(7);
  return variableFields.find(([key]) => key === field)?.[1] || `{{${field}}}`;
}
function stepSummary(step: AutomationStep, vault: Recording[]) {
  if (step.type === "if") return step.field ? `${fieldLabel(step.field)} ${step.op}${step.op.includes("empty") ? "" : ` "${step.value}"`}` : "Pick a field";
  if (step.type === "say") return step.text.trim() || "Write the line";
  if (step.type === "ask") return step.prompt.trim() ? `${step.field}: ${step.prompt}` : "Write the question";
  if (step.type === "wait") return `${step.amount} ${step.amount === 1 ? step.unit.replace(/s$/, "") : step.unit}`;
  if (step.type === "email") return step.subject.trim() || "Write the email";
  if (step.type === "sms") return step.text.trim() || "Write the text";
  if (step.type === "play") return vault.find((item) => item.id === step.recordingId)?.name || (step.recordingId ? "Recording deleted" : "Pick a voicemail");
  if (step.type === "stage") return step.stage;
  return `${step.days} business day${step.days === 1 ? "" : "s"} out, 10:00`;
}
function triggerSummary(item: Automation) {
  const where = item.campaigns?.length ? item.campaigns.join(", ") : "Any campaign";
  if (item.trigger !== "outcome" && item.trigger !== "transcribed") return where;
  return `${where} · ${item.outcomes?.length ? item.outcomes.join(", ") : "any outcome"}`;
}
// A step isn't done until its main field is filled in.
const stepReady = (step: AutomationStep) => (step.type === "if" ? Boolean(step.field) : step.type === "say" ? Boolean(step.text.trim()) : step.type === "ask" ? Boolean(step.prompt.trim() && step.field.trim()) : step.type === "email" ? Boolean(step.to && step.subject.trim() && step.body.trim()) : step.type === "sms" ? Boolean(step.text.trim()) : step.type === "play" ? Boolean(step.recordingId) : true);

// The Automations page: every automation in the workspace. New ones start by picking a trigger, then open on the
// canvas, where the trigger node says which campaigns it listens to.
function AutomationsPage({ automations, leads, settings, vault, onRefresh, onOpenVault }: { automations: Automation[]; leads: Lead[]; settings: Record<string, CampaignSettings>; vault: Recording[]; onRefresh: () => Promise<unknown>; onOpenVault: () => void }) {
  const [openId, setOpenId] = useState<string | null>(null);
  // A new automation opens at once, before the save comes back.
  const [created, setCreated] = useState<Automation | null>(null);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const list = automations;
  const save = async (next: Automation[]) => {
    setError(null);
    try {
      await api("/api/automations", { method: "PUT", body: JSON.stringify({ automations: next }) });
      await onRefresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't save the automation.");
    }
  };
  const create = (trigger: AutomationTrigger) => {
    const item: Automation = { id: `au_${Date.now()}`, name: triggerInfo[trigger].title, on: true, trigger, campaigns: [], ...(trigger === "outcome" || trigger === "transcribed" ? { outcomes: [] } : {}), steps: [] };
    setPicking(false);
    setCreated(item);
    setOpenId(item.id);
    void save([...list, item]);
  };
  const open = list.find((item) => item.id === openId) || (created?.id === openId ? created : undefined);
  if (open) {
    return (
      <AutomationEditor key={open.id} automation={open} leads={leads} settings={settings} vault={vault} error={error}
        onBack={() => setOpenId(null)}
        onSave={(next) => save(list.some((item) => item.id === next.id) ? list.map((item) => (item.id === next.id ? next : item)) : [...list, next])}
        onDelete={() => { setOpenId(null); void save(list.filter((item) => item.id !== open.id)); }}
        onOpenVault={onOpenVault} />
    );
  }
  return (
    <section className="flow-page">
      <div className="campaigns-head">
        <p>Each automation starts with a trigger, from the campaigns you pick on it, and runs its steps in order.</p>
        <div className="campaigns-head__actions"><button type="button" className="primary-button" onClick={() => setPicking(true)}><Plus size={16} aria-hidden="true" /> New automation</button></div>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      {list.length ? (
        <div className="automation-list">
          {list.map((item) => {
            const Icon = triggerInfo[item.trigger].icon;
            return (
              <article className={`automation-row${item.on ? "" : " is-off"}`} key={item.id}>
                <button type="button" className="automation-row__open" onClick={() => setOpenId(item.id)}>
                  <span className="automation-row__icon" aria-hidden="true"><Icon size={18} /></span>
                  <span className="automation-row__text"><b>{item.name}</b><small>{triggerInfo[item.trigger].title} · {triggerSummary(item)} · {item.steps.length ? item.steps.map((step) => stepInfo[step.type].title).join(" → ") : "No steps yet"}</small></span>
                </button>
                <label className="automation-switch">
                  <input type="checkbox" role="switch" checked={item.on} onChange={() => void save(list.map((entry) => (entry.id === item.id ? { ...entry, on: !entry.on } : entry)))} />
                  <span>{item.on ? "Active" : "Off"}</span>
                </label>
              </article>
            );
          })}
        </div>
      ) : (
        <button type="button" className="flow-empty" onClick={() => setPicking(true)}>
          <span className="flow-empty__plus" aria-hidden="true"><Plus size={28} /></span>
          <b>Add your first automation</b>
          <small>Pick what starts it: a lead coming up, a call outcome, or a voicemail drop.</small>
        </button>
      )}
      {picking && (
        <aside className="flow-panel" role="dialog" aria-labelledby="flow-panel-title">
          <header>
            <h2 id="flow-panel-title">What starts this automation?</h2>
            <button type="button" className="close-button" onClick={() => setPicking(false)} aria-label="Close"><X size={18} /></button>
          </header>
          <div className="flow-options">
            {(Object.keys(triggerInfo) as AutomationTrigger[]).map((trigger) => {
              const Icon = triggerInfo[trigger].icon;
              return (
                <button type="button" className="flow-option" key={trigger} onClick={() => create(trigger)}>
                  <span className="flow-option__icon flow-option__icon--trigger" aria-hidden="true"><Icon size={18} /></span>
                  <span><b>{triggerInfo[trigger].title}</b><small>{triggerInfo[trigger].detail}</small></span>
                </button>
              );
            })}
          </div>
        </aside>
      )}
    </section>
  );
}

// One automation on the canvas: the trigger, its steps joined by wires, and a + to add the next step. Clicking a
// node opens its settings on the right. Changes save half a second after the last edit.
function AutomationEditor({ automation, leads: allLeads, settings: allSettings, vault, error, onBack, onSave, onDelete, onOpenVault }: { automation: Automation; leads: Lead[]; settings: Record<string, CampaignSettings>; vault: Recording[]; error: string | null; onBack: () => void; onSave: (next: Automation) => Promise<void>; onDelete: () => void; onOpenVault: () => void }) {
  const [draft, setDraft] = useState(automation);
  const [panel, setPanel] = useState<"trigger" | "add" | number | null>(automation.steps.length ? null : "add");
  const dirty = useRef(false);
  useEffect(() => {
    if (!dirty.current) return;
    const timer = window.setTimeout(() => { dirty.current = false; void onSave(draft); }, 500);
    return () => window.clearTimeout(timer);
  }, [draft]);
  const change = (next: Automation) => { dirty.current = true; setDraft(next); };
  const setStep = (index: number, step: AutomationStep) => change({ ...draft, steps: draft.steps.map((item, at) => (at === index ? step : item)) });
  const back = () => { if (dirty.current) { dirty.current = false; void onSave(draft); } onBack(); };
  const TriggerIcon = triggerInfo[draft.trigger].icon;
  const campaignNames = allCampaigns(allLeads, allSettings);
  // The leads this trigger hears from: the picked campaigns' leads, or everyone.
  const leads = draft.campaigns?.length ? allLeads.filter((lead) => lead.campaigns?.some((name) => draft.campaigns!.includes(name))) : allLeads;
  const scripts = (draft.campaigns?.length ? draft.campaigns : campaignNames).map((name) => allSettings[name]?.script || "").join("\n");
  const columns = [...new Set(leads.flatMap((lead) => Object.keys(lead.details || {})))].sort();
  const asked = draft.steps.flatMap((item) => (item.type === "ask" && item.field.trim() ? [[`detail:${item.field.trim()}`, `${item.field.trim()} (from Ask AI)`] as [string, string]] : []));
  const fields: [string, string][] = [...asked, ...scriptVariables(scripts).map((name) => [name, `{{${name}}}`] as [string, string]), ...variableFields.filter(([key]) => key !== "phone"), ...columns.map((column) => [`detail:${column}`, column] as [string, string])];
  const step = typeof panel === "number" ? draft.steps[panel] : undefined;
  return (
    <section className={`flow-page${panel !== null ? " has-panel" : ""}`}>
      <div className="flow-editor-head">
        <button type="button" className="quiet-button" onClick={back}><ChevronRight size={16} className="flip" aria-hidden="true" /> All automations</button>
        <input className="flow-editor-head__name" value={draft.name} onChange={(event) => change({ ...draft, name: event.target.value })} aria-label="Automation name" />
        <label className="automation-switch">
          <input type="checkbox" role="switch" checked={draft.on} onChange={() => change({ ...draft, on: !draft.on })} />
          <span>{draft.on ? "Active" : "Off"}</span>
        </label>
        <button type="button" className="text-link" onClick={() => { if (window.confirm(`Delete ${draft.name}?`)) { dirty.current = false; onDelete(); } }}><Trash2 size={16} aria-hidden="true" /> Delete</button>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="flow-canvas">
        <div className="flow-chain">
          <button type="button" className={`flow-node flow-node--trigger${panel === "trigger" ? " is-selected" : ""}`} onClick={() => setPanel("trigger")}>
            <span className="flow-node__icon" aria-hidden="true"><TriggerIcon size={18} /></span>
            <span className="flow-node__text"><b>{triggerInfo[draft.trigger].title}</b><small>{triggerSummary(draft)}</small></span>
          </button>
          {draft.steps.map((item, index) => {
            const Icon = stepInfo[item.type].icon;
            return (
              <Fragment key={index}>
                <span className="flow-wire" aria-hidden="true" />
                <button type="button" className={`flow-node flow-node--${item.type === "if" ? "switch" : "action"}${panel === index ? " is-selected" : ""}${stepReady(item) ? "" : " is-unfinished"}`} onClick={() => setPanel(index)}>
                  <span className="flow-node__icon" aria-hidden="true"><Icon size={18} /></span>
                  <span className="flow-node__text"><b>{stepInfo[item.type].title}</b><small>{stepSummary(item, vault)}</small></span>
                </button>
              </Fragment>
            );
          })}
          <span className="flow-wire" aria-hidden="true" />
          <button type="button" className={`flow-add${panel === "add" ? " is-selected" : ""}`} onClick={() => setPanel("add")} aria-label="Add a step"><Plus size={20} /></button>
        </div>
      </div>
      {panel !== null && (
        <aside className="flow-panel" role="dialog" aria-labelledby="flow-panel-title">
          <header>
            <h2 id="flow-panel-title">{panel === "trigger" ? triggerInfo[draft.trigger].title : panel === "add" ? "What happens next?" : step ? stepInfo[step.type].title : ""}</h2>
            <button type="button" className="close-button" onClick={() => setPanel(null)} aria-label="Close"><X size={18} /></button>
          </header>
          {panel === "trigger" && (
            <>
              <p className="campaign-settings__hint">{triggerInfo[draft.trigger].detail}.</p>
              <fieldset className="flow-outcomes">
                <legend>From which campaigns? None ticked means any.</legend>
                {campaignNames.map((name) => (
                  <label key={name}><input type="checkbox" checked={Boolean(draft.campaigns?.includes(name))} onChange={(event) => change({ ...draft, campaigns: event.target.checked ? [...(draft.campaigns || []), name] : (draft.campaigns || []).filter((item) => item !== name) })} /> {name}</label>
                ))}
              </fieldset>
              {draft.trigger === "transcribed" && <p className="campaign-settings__hint">Needs Live transcription switched on in Settings → Features & costs. Runs once the call's transcript is in and you've logged the outcome.</p>}
              {(draft.trigger === "outcome" || draft.trigger === "transcribed") && (
                <fieldset className="flow-outcomes">
                  <legend>Which outcomes? None ticked means any.</legend>
                  {callOutcomes.map((outcome) => (
                    <label key={outcome}><input type="checkbox" checked={Boolean(draft.outcomes?.includes(outcome))} onChange={(event) => change({ ...draft, outcomes: event.target.checked ? [...(draft.outcomes || []), outcome] : (draft.outcomes || []).filter((item) => item !== outcome) })} /> {outcome}</label>
                  ))}
                </fieldset>
              )}
            </>
          )}
          {panel === "add" && (
            <div className="flow-options">
              {stepsFor[draft.trigger].map((type) => {
                const Icon = stepInfo[type].icon;
                return (
                  <button type="button" className="flow-option" key={type} onClick={() => { change({ ...draft, steps: [...draft.steps, newStep(type)] }); setPanel(draft.steps.length); }}>
                    <span className={`flow-option__icon flow-option__icon--${type === "if" ? "switch" : "action"}`} aria-hidden="true"><Icon size={18} /></span>
                    <span><b>{stepInfo[type].title}</b><small>{stepInfo[type].detail}</small></span>
                  </button>
                );
              })}
            </div>
          )}
          {step && typeof panel === "number" && (
            <StepSettings step={step} fields={fields} leads={leads} settings={allSettings} vault={vault} onOpenVault={onOpenVault}
              onChange={(next) => setStep(panel, next)}
              onRemove={() => { change({ ...draft, steps: draft.steps.filter((_, at) => at !== panel) }); setPanel(null); }} />
          )}
        </aside>
      )}
    </section>
  );
}

// One step's settings in the side panel.
function StepSettings({ step, fields, leads, settings, vault, onOpenVault, onChange, onRemove }: { step: AutomationStep; fields: [string, string][]; leads: Lead[]; settings: Record<string, CampaignSettings>; vault: Recording[]; onOpenVault: () => void; onChange: (step: AutomationStep) => void; onRemove: () => void }) {
  const variablesOf = (lead: Lead) => settings[scriptCampaignOf(lead, settings) || ""]?.variables;
  const values = step.type === "if" && step.field ? [...new Set(leads.map((lead) => fieldValue(step.field, lead, variablesOf(lead))).filter(Boolean))].slice(0, 50) : [];
  const matching = step.type === "if" && step.field ? leads.filter((lead) => matches(step, lead, variablesOf(lead))).length : 0;
  return (
    <div className="flow-step-settings">
      <p className="campaign-settings__hint">{stepInfo[step.type].detail}.</p>
      {step.type === "if" && (
        <>
          <label>Field<select value={step.field} onChange={(event) => onChange({ ...step, field: event.target.value })}><option value="" disabled>Pick a field…</option>{fields.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label>Rule<select value={step.op} onChange={(event) => onChange({ ...step, op: event.target.value as ConditionOp })}>{conditionOps.map((op) => <option key={op}>{op}</option>)}</select></label>
          {!step.op.includes("empty") && (
            <label>Value<input value={step.value} list="flow-values" onChange={(event) => onChange({ ...step, value: event.target.value })} placeholder={values[0] || "no website"} /><datalist id="flow-values">{values.map((value) => <option key={value} value={value} />)}</datalist></label>
          )}
          {step.field && <small className="flow-step-settings__count">{matching} of {leads.length} lead{leads.length === 1 ? "" : "s"} match.</small>}
        </>
      )}
      {step.type === "ask" && (
        <>
          <label>Question<textarea rows={3} value={step.prompt} onChange={(event) => onChange({ ...step, prompt: event.target.value })} placeholder="Did they agree to a meeting? Answer yes or no." /><small>The AI reads the whole transcript ("You" and "Them") and answers this.</small></label>
          <label>Save the answer to<input value={step.field} onChange={(event) => onChange({ ...step, field: event.target.value })} list="flow-ask-fields" placeholder="Call summary" /><datalist id="flow-ask-fields">{fields.filter(([value]) => value.startsWith("detail:")).map(([value]) => <option key={value} value={value.slice(7)} />)}</datalist><small>A lead field. Add Only continue if after this step to act on the answer. Uses your AI key (Settings → AI).</small></label>
        </>
      )}
      {step.type === "wait" && (
        <div className="flow-wait">
          <label>For<input type="number" min={1} max={365} value={step.amount} onChange={(event) => onChange({ ...step, amount: Math.max(1, Math.min(365, Number(event.target.value) || 1)) })} /></label>
          <label>&nbsp;<select value={step.unit} onChange={(event) => onChange({ ...step, unit: event.target.value as "minutes" | "hours" | "days" })}><option value="minutes">minutes</option><option value="hours">hours</option><option value="days">days</option></select></label>
          <small>Then the steps after this one run. Turning the automation off cancels what's waiting.</small>
        </div>
      )}
      {step.type === "email" && (
        <>
          <label>Send to<select value={step.to} onChange={(event) => onChange({ ...step, to: event.target.value })}><option value="" disabled>The lead's email field…</option>{fields.filter(([value]) => value.startsWith("detail:")).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><small>Leads without an email there are skipped.</small></label>
          <label>Subject<input value={step.subject} onChange={(event) => onChange({ ...step, subject: event.target.value })} placeholder="Following up, {{first_name}}" /></label>
          <label>Email<textarea rows={6} value={step.body} onChange={(event) => onChange({ ...step, body: event.target.value })} placeholder={"Hi {{first_name}},\n\nThanks for taking my call today…"} /><small>Use {"{{variables}}"} like in the script. Sent from the sender in Settings → Email; free plan: {prices.resend.free.toLowerCase()}.</small></label>
        </>
      )}
      {step.type === "sms" && (
        <label>Text<textarea rows={4} value={step.text} onChange={(event) => onChange({ ...step, text: event.target.value })} placeholder="Hi {{first_name}}, this is Bayu from Datastreams. Sorry I missed you today." /><small>{step.text.length} characters{step.text.length > 160 ? ` (${Math.ceil(step.text.length / 153)} texts)` : ""}. Sent from your Twilio number, about {money(prices.twilioSms.amount)} a text. Texting US numbers needs your number registered for 10DLC in Twilio first. Leads on Do not call are skipped.</small></label>
      )}
      {step.type === "say" && <label>Line<textarea rows={4} value={step.text} onChange={(event) => onChange({ ...step, text: event.target.value })} placeholder="Hey {{first_name}}, I see you don't have a website yet." /><small>Use {"{{variables}}"} like in the script.</small></label>}
      {step.type === "play" && (vault.length ? (
        <>
          <label>Voicemail<select value={step.recordingId} onChange={(event) => onChange({ ...step, recordingId: event.target.value })}><option value="" disabled>Pick a voicemail…</option>{vault.map((item) => <option key={item.id} value={item.id}>{item.name}{item.seconds ? ` (${clockOf(item.seconds)})` : ""}</option>)}</select></label>
          {step.recordingId && vault.some((item) => item.id === step.recordingId) && <audio controls preload="none" src={`/api/voicemails/${step.recordingId}/audio`} />}
          <small>After it plays, the call ends and the lead is logged as Voicemail.</small>
        </>
      ) : <p className="campaign-settings__hint">No voicemails yet. <button type="button" className="text-link" onClick={onOpenVault}>Record one in Voicemails</button></p>)}
      {step.type === "stage" && <label>Stage<select value={step.stage} onChange={(event) => onChange({ ...step, stage: event.target.value })}>{leadStages.map((stage) => <option key={stage}>{stage}</option>)}</select></label>}
      {step.type === "followup" && <label>Business days out<input type="number" min={0} max={60} value={step.days} onChange={(event) => onChange({ ...step, days: Math.max(0, Math.min(60, Number(event.target.value) || 0)) })} /><small>At 10:00. A time you pick when logging the call wins.</small></label>}
      <button type="button" className="text-link flow-step-settings__remove" onClick={onRemove}><Trash2 size={16} aria-hidden="true" /> Remove this step</button>
    </div>
  );
}

// Open-Meteo weather codes in a word or two.
function weatherWords(code: number) {
  if (code === 0) return "Clear";
  if (code <= 2) return "Partly cloudy";
  if (code === 3) return "Cloudy";
  if (code <= 48) return "Fog";
  if (code <= 57) return "Drizzle";
  if (code <= 67) return "Rain";
  if (code <= 77) return "Snow";
  if (code <= 82) return "Showers";
  if (code <= 86) return "Snow showers";
  return "Thunderstorms";
}
// Where most of these leads are: their most common state, and its most common city when the leads have one.
function leadsPlace(leads: Lead[]) {
  const top = (values: string[]) => [...values.reduce((map, value) => map.set(value, (map.get(value) || 0) + 1), new Map<string, number>())].sort((left, right) => right[1] - left[1])[0]?.[0];
  const located = leads.filter((lead) => !lead.dnc).map((lead) => ({ state: leadState(lead), city: Object.entries(lead.details || {}).find(([key]) => /^(city|town|city\/town)$/i.test(key.trim()))?.[1]?.trim() || "" })).filter((place) => place.state);
  const code = top(located.map((place) => place.state![0]));
  if (!code) return null;
  const state = stateZones.find(([key]) => key === code)!;
  const city = top(located.filter((place) => place.state![0] === code && place.city).map((place) => place.city));
  return { label: city ? `${city}, ${code}` : state[1], search: city || state[1], state: state[1] };
}
const weatherCache = new Map<string, Promise<{ temperature: number; code: number } | null>>();
function fetchWeather(place: { search: string; state: string }) {
  const key = `${place.search}|${place.state}`;
  if (!weatherCache.has(key))
    weatherCache.set(key, (async () => {
      const found = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(place.search)}&count=10&countryCode=US`).then((response) => response.json());
      const results: { latitude: number; longitude: number; name: string; admin1?: string }[] = found.results || [];
      const spot = results.find((result) => result.admin1 === place.state || result.name === place.state) || results[0];
      if (!spot) return null;
      const weather = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${spot.latitude}&longitude=${spot.longitude}&current=temperature_2m,weather_code&temperature_unit=fahrenheit`).then((response) => response.json());
      const current = weather.current;
      return typeof current?.temperature_2m === "number" ? { temperature: Math.round(current.temperature_2m), code: current.weather_code } : null;
    })().catch(() => null));
  return weatherCache.get(key)!;
}
function WeatherCard({ leads }: { leads: Lead[] }) {
  const place = leadsPlace(leads);
  const [weather, setWeather] = useState<{ temperature: number; code: number } | null>(null);
  useEffect(() => {
    let live = true;
    setWeather(null);
    if (place) void fetchWeather(place).then((result) => { if (live) setWeather(result); });
    return () => { live = false; };
  }, [place?.search, place?.state]);
  // No place or no answer from the weather service: no card.
  if (!place || !weather) return null;
  return (
    <section className="analytics-card home-weather">
      <h2>Weather in {place.label}</h2>
      <p><b>{weather.temperature}°F</b> {weatherWords(weather.code)}</p>
      <p className="field-hint">Where most of these leads are, right now.</p>
    </section>
  );
}

// The Dashboard: how today and this month are going, at a glance.
function Home({ state, all, followUps, onOpenLead, onStart, onGo }: { state: State; all: State; followUps: Lead[]; onOpenLead: (id: string) => void; onStart: (campaign: string) => void; onGo: (screen: Screen) => void }) {
  const now = new Date();
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dayEnd = dayStart.getTime() + 86_400_000;
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const settings = all.campaignSettings || {};
  const totals = (since: Date) => {
    const calls = state.calls.filter((call) => new Date(call.at) >= since);
    const attempts = callAttempts(calls);
    const won = state.leads.filter((lead) => lead.status === "Won" && lead.wonAt && new Date(lead.wonAt) >= since);
    return {
      calls: attempts.length,
      conversations: attempts.filter((attempt) => attempt.conversation).length,
      meetings: new Set(calls.filter((call) => call.outcome === "Meeting booked").map((call) => call.leadId)).size,
      won: won.length,
      value: won.reduce((sum, lead) => sum + dealValue(lead, settings), 0),
    };
  };
  const today = totals(dayStart);
  const month = totals(monthStart);
  const wonUndated = state.leads.some((lead) => lead.status === "Won" && !lead.wonAt);
  const ids = new Set(state.leads.map((lead) => lead.id));
  const due = followUps
    .filter((lead) => ids.has(lead.id) && /^\d{4}-\d{2}-\d{2}/.test(lead.due) && new Date(lead.due).getTime() < dayEnd)
    .sort((left, right) => left.due.localeCompare(right.due));
  const followUpDue = (lead: Lead) => lead.status === "Follow-up" && !lead.dnc && (!/^\d{4}-\d{2}-\d{2}/.test(lead.due) || new Date(lead.due).getTime() < dayEnd);
  const money = (value: number) => (value ? ` · $${value.toLocaleString()}` : "");
  const campaigns = campaignsOf(state.leads);
  return (
    <section className="analytics-page">
      <div className="analytics-grid">
        <section className="analytics-card">
          <h2>Today and this month</h2>
          <table className="analytics-table">
            <thead><tr><th scope="col"><span className="sr-only">Measure</span></th><th scope="col">Today</th><th scope="col">This month</th></tr></thead>
            <tbody>
              <tr><td>Calls</td><td>{today.calls}</td><td>{month.calls}</td></tr>
              <tr><td>Conversations</td><td>{today.conversations}</td><td>{month.conversations}</td></tr>
              <tr><td>Meetings booked</td><td>{today.meetings}</td><td>{month.meetings}</td></tr>
              <tr><td>Deals won</td><td>{today.won}{money(today.value)}</td><td>{month.won}{money(month.value)}</td></tr>
            </tbody>
          </table>
          {wonUndated && <p className="field-hint">Deals marked won before 25 Nov 2026 have no date, so they only count on the Pipeline.</p>}
        </section>
        <section className="analytics-card">
          <h2>Due today</h2>
          {due.length ? (
            <ul className="home-due">
              {due.slice(0, 8).map((lead) => (
                <li key={lead.id}>
                  <button type="button" className="text-link" onClick={() => onOpenLead(lead.id)}>{leadLabel(lead)}</button>
                  <span>{lead.status === "Meeting booked" ? "Meeting" : "Callback"} · {dueLabel(lead.due).text}</span>
                </li>
              ))}
            </ul>
          ) : <p className="analytics-empty">No callbacks or meetings due today.</p>}
          <button type="button" className="text-link home-more" onClick={() => onGo("followups")}>{due.length > 8 ? `See all ${due.length} in Tasks` : "Open Tasks"}</button>
        </section>
        <WeatherCard leads={state.leads} />
      </div>
      {/* This month so far; in a month's first week, the last 7 days. */}
      <CallsChart calls={state.calls} range={Math.max(7, now.getDate())} onOpenCalls={() => onGo("calls")} />
      <section className="analytics-card">
        <h2>Campaigns</h2>
        {campaigns.length ? (
          <ul className="home-campaigns">
            {campaigns.map((name) => {
              const items = state.leads.filter((lead) => lead.campaigns?.includes(name));
              const left = items.filter(inQueue).length;
              const done = items.length - left;
              const followUpsDue = items.filter(followUpDue).length;
              return (
                <li key={name}>
                  <div><b>{name}</b>{left > 0 && <button type="button" className="text-link" onClick={() => onStart(name)}>Start calling</button>}</div>
                  <div className="dash-progress">
                    <span><i style={{ width: `${items.length ? Math.round((done / items.length) * 100) : 0}%` }} /></span>
                    <em>{left} left to call · {followUpsDue} follow-up{followUpsDue === 1 ? "" : "s"} due · {done} of {items.length} done</em>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : <p className="analytics-empty">No campaigns yet. Start one on the Campaigns page.</p>}
      </section>
    </section>
  );
}

type ImportTarget = "phone" | "name" | "company" | "role" | "state" | "note" | "stage";
const importTargets: { key: ImportTarget; label: string; hint: string; guesses: string[] }[] = [
  { key: "phone", label: "Phone", hint: "Required", guesses: ["phone", "phonenumber", "mainphone", "directphone", "telephone", "tel", "mobile", "cell", "number"] },
  { key: "name", label: "Contact name", hint: "Optional. Leave blank for front desks and gatekeepers", guesses: ["name", "fullname", "contact", "contactname", "person", "firstname", "superintendent", "principal", "leader", "owner"] },
  { key: "company", label: "Organization", hint: "Optional. A company, business, school district…", guesses: ["company", "companyname", "organization", "organisation", "account", "accountname", "business", "district", "school", "agency"] },
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

function ImportLeads({ campaigns, settings, fields = [], defaultCampaign, requireCampaign, onClose, onSaved }: { campaigns: string[]; settings: Record<string, CampaignSettings>; fields?: string[]; defaultCampaign: string; requireCampaign: boolean; onClose: () => void; onSaved: (message: string, campaign: string) => Promise<void> }) {
  const [campaign, setCampaign] = useState(defaultCampaign);
  const campaignSetup = settings[campaign.trim()] || {};
  const variableNames = scriptVariables(campaignSetup.script || "");
  // Variable → CSV column index, or a lead field key.
  const [variableColumns, setVariableColumns] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<Record<ImportTarget, number | null> | null>(null);
  // Custom field → CSV column index (matched by name when the file is read).
  const [fieldColumns, setFieldColumns] = useState<Record<string, number | null>>({});
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
    setFieldColumns(Object.fromEntries(fields.map((field) => { const index = names.findIndex((header) => simplify(header) === simplify(field)); return [field, index < 0 ? null : index]; })));
    setVariableColumns({});
  };
  // What a variable is filled from after import: its chosen column (kept as a detail) or lead field, else the campaign's earlier choice.
  const variableSource = (name: string) => {
    const choice = variableColumns[name];
    if (choice?.startsWith("detail:")) return choice;
    if (choice) return choice;
    return campaignSetup.variables?.[name] || "";
  };
  const mapped = new Set([...Object.values(mapping || {}), ...Object.values(fieldColumns)].filter((value): value is number => value !== null));
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
        // Columns picked for script variables are always kept, even with "keep the other columns" off.
        ...Object.fromEntries(Object.values(variableColumns).filter((source) => source.startsWith("detail:")).map((source) => source.slice(7)).map((header) => [header, row[headers.indexOf(header)] || ""]).filter(([, text]) => text)),
        // Custom fields are saved under the field's name, whatever the column was called.
        ...Object.fromEntries(Object.entries(fieldColumns).filter(([, index]) => index !== null).map(([field, index]) => [field, row[index as number] || ""]).filter(([, text]) => text)),
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
      // Remember the variable choices on the campaign, so every call fills them the same way.
      const chosen = Object.fromEntries(variableNames.map((name) => [name, variableSource(name)]).filter(([, source]) => source));
      if (campaign.trim() && Object.keys(chosen).length) await api("/api/campaigns/script", { method: "PUT", body: JSON.stringify({ campaign: campaign.trim(), variables: { ...(campaignSetup.variables || {}), ...chosen } }) });
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
              {fields.map((field) => (
                <label key={`field:${field}`}>
                  <span>{field} <small>Custom field</small></span>
                  <select value={fieldColumns[field] ?? ""} onChange={(event) => setFieldColumns({ ...fieldColumns, [field]: event.target.value === "" ? null : Number(event.target.value) })}>
                    <option value="">Not in this file</option>
                    {headers.map((header, index) => <option key={index} value={index}>{header}</option>)}
                  </select>
                  {fieldColumns[field] != null && (
                    <small className="import-example">e.g. {rows.find((row) => row[fieldColumns[field] as number])?.[fieldColumns[field] as number] || "empty column"}</small>
                  )}
                </label>
              ))}
            </div>
            <label className="import-keep">
              <input type="checkbox" checked={cleanPhones} onChange={(event) => setCleanPhones(event.target.checked)} />
              <span>Clean up phone numbers <small>(saved as +13365706060 and shown as (336) 570-6060; extensions like "ext. 10257" are saved separately and dialed after the call connects)</small></span>
            </label>
            {variableNames.length > 0 && (
              <section className="import-variables" aria-label="Script variables">
                <b>Script variables in {campaign.trim()}</b>
                <small>Pick the column that fills each one on a call.</small>
                <VariableMap
                  names={variableNames}
                  value={Object.fromEntries(variableNames.map((name) => [name, variableColumns[name] || campaignSetup.variables?.[name] || ""]))}
                  columns={headers}
                  onChange={(next) => setVariableColumns(Object.fromEntries(Object.entries(next).filter(([, source]) => source)))}
                  auto={(name) => guessVariable(name, headers)}
                />
              </section>
            )}
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

function CallOutcome({ lead, automations, settings, bookingUrl, onBook, onClose, onSaved }: { lead: Lead; automations?: Automation[]; settings: Record<string, CampaignSettings>; bookingUrl: string; onBook: () => void; onClose: () => void; onSaved: (outcome: string) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState("");
  const [followUpAt, setFollowUpAt] = useState("");
  // A follow-up from the campaign's "Call outcome logged" automations, or two business days out for a voicemail,
  // unless a time is already set.
  const pickOutcome = (value: string) => {
    setOutcome(value);
    if (followUpAt) return;
    const date = outcomeActions(lead, automations, settings, value).followUpAt || (value === "Voicemail" ? voicemailFollowUp() : "");
    if (date) setFollowUpAt(date);
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

type GuideTarget = "settings" | "leads" | "queue" | "campaigns";

// screen: the page the tour opens for this step. spot: what it highlights there, as data-tour names to try in
// order (the first one on screen wins); none means the card sits in the middle.
type SetupStep = { done: boolean; title: string; body: string; target: GuideTarget | null; action: string; optional?: boolean; screen?: Screen; spot?: string };

// The setup steps, used by the checklist and the guided tour. Owners set up calling for their company; callers only
// need their leads and a first call. Optional steps never hold back "set up", since plenty of people call alone.
function setupSteps(state: State): SetupStep[] {
  const realCalls = state.calls.filter((call) => call.outcome !== "In progress" || "sid" in call);
  const firstCall: SetupStep = { done: realCalls.length > 0, title: "Make your first call", body: "Pick a campaign and press Start calling. The lead's details and script sit under the phone number; hover any detail and click the pin to keep it at the top for the whole campaign. After the call, log the outcome and the next lead comes up on its own.", target: "queue", action: "Open Dialer", screen: "queue", spot: "start-calling" };
  if (state.me.role !== "owner")
    return [
      { done: Boolean(state.connection?.selectedNumber), title: "Calling is set up for you", body: "Your company's owner connects Twilio and the number leads see. If calls don't start, ask them to finish setup.", target: null, action: "" },
      { done: state.leads.length > 0, title: "Get your leads", body: "You see the leads your owner assigns to you, here on the Leads page. If it's empty, ask them to assign some.", target: "leads", action: "Open Leads", spot: "nav-leads" },
      { done: true, title: "Use a headset", body: "Calls play through this browser. Allow the microphone when your browser asks, and use a headset so the lead doesn't hear an echo. Your password lives in Settings → Account → Profile.", target: null, action: "" },
      firstCall,
    ];
  const scripts = Object.values(state.campaignSettings || {}).some((settings) => settings.script || settings.pdf);
  return [
    { done: Boolean(state.connection), title: "Connect your Twilio account", body: "Paste your Account SID and Auth Token here and press Validate. Both are on your Twilio Console home page; the link above the fields opens it. They're checked and stored encrypted.", target: "settings", action: "Open Settings", screen: "settings", spot: "twilio" },
    { done: Boolean(state.connection?.selectedNumber), title: "Pick the number leads will see", body: "Once Twilio is connected, your numbers are listed here. Choose the one leads see as caller ID and save it. Need a number? The link here opens your Twilio numbers.", target: "settings", action: "Open Settings", screen: "settings", spot: "number,twilio" },
    { done: Boolean(state.connection), title: "Choose how you take calls", body: "\"In this app\" plays calls through your browser: use a headset and allow the microphone. You can switch to Zoiper or your phone here instead.", target: "settings", action: "Open Settings", screen: "settings", spot: "answer-on,twilio" },
    { done: Boolean(state.callbackReachable), title: "Start Open Dialer the easy way", body: "On your computer, always start with Start Open Dialer.bat. It opens Docker Desktop and the local database, builds the app, and opens the tunnel Twilio needs to reach you. Keep its window open while you call. A hosted copy needs none of this.", target: null, action: "" },
    { done: state.leads.length > 0, title: "Add your leads", body: "New campaign: name it and write the script first, then import its CSV. Match the columns; only a phone number is required. Leads → Import CSV works too.", target: "campaigns", action: "Open Campaigns", screen: "campaigns", spot: "new-campaign" },
    { done: scripts, title: "Set up each campaign", body: "Settings on a campaign card, or Campaigns → Scripts in the sidebar for every campaign's script at a glance. General: what a won deal is worth. Script: type {{name}} or ((NAME)) where lead details go, or use the Variable button. Variables: what fills each one, with real examples from your leads, and Clean with AI to make messy values sound natural.", target: "campaigns", action: "Open Campaigns", optional: true, screen: "campaigns", spot: "campaign-settings,new-campaign" },
    { done: Boolean(state.settings?.fields?.length), title: "Add custom fields", body: "Extra details your team fills in on every lead, like Territory. They show on each lead's form, in the CSV import, and as script variables.", target: "settings", action: "Open Settings", optional: true, screen: "settings", spot: "settings-fields" },
    { done: Boolean(state.ai?.ready), title: "Connect AI", body: "Turns on Open Dialer's AI features, like cleaning script variables and Ask AI in automations. Pick Groq (fast and free), paste a key (the link opens Groq's keys page) and press Check and save.", target: "settings", action: "Open Settings", optional: true, screen: "settings", spot: "settings-ai" },
    { done: Boolean(state.settings?.bookingUrl), title: "Add your booking link", body: "Your Calendly or Cal.com link, so Book a call opens it during a call. The links there take you to your event types to copy it.", target: "settings", action: "Open Settings", optional: true, screen: "settings", spot: "settings-booking" },
    { done: state.team.length > 1, title: "Invite your callers", body: "Team → Send invite. Then select leads on the Leads page and use Assign to; callers only see what you assign them. Skip this if you call alone.", target: "settings", action: "Open Settings", optional: true, screen: "settings", spot: "settings-team" },
    { done: Boolean(state.emailReady), title: "Turn on email", body: "So invites and password resets arrive by email: add RESEND_API_KEY and RESEND_FROM_EMAIL (a sender on a domain verified in Resend) to .env, then restart. Until then, you get each sign-in link to send yourself.", target: null, action: "", optional: true },
    firstCall,
  ];
}

// The checklist: what's done, plus the guided tour, from the start or from any step.
function SetupGuide({ state, onClose, onTour }: { state: State; onClose: () => void; onTour: (step: number) => void }) {
  const steps = setupSteps(state);
  const required = steps.filter((step) => !step.optional);
  const done = required.filter((step) => step.done).length;
  return (
    <div className="modal-backdrop">
      <section className="lead-form setup-guide" role="dialog" aria-modal="true" aria-labelledby="setup-guide-title">
        <button type="button" className="close-button" onClick={onClose} aria-label="Close"><X /></button>
        <h2 id="setup-guide-title">Setup guide</h2>
        <p>{done === required.length ? "Everything you need is set up. Take the tour any time for a refresher." : `${done} of ${required.length} done. Each step ticks itself off once it's finished.`}</p>
        <div className="dash-progress setup-guide__progress"><span><i style={{ width: `${Math.round((done / required.length) * 100)}%` }} /></span></div>
        <button type="button" className="primary-button setup-guide__tour" onClick={() => onTour(Math.max(0, steps.findIndex((step) => !step.done)))}><Play size={16} aria-hidden="true" /> {done === required.length ? "Take the tour" : "Continue with the tour"}</button>
        <ol className="setup-steps">
          {steps.map((step, index) => (
            <li key={step.title} className={step.done ? "is-done" : undefined}>
              <span className="setup-steps__mark" aria-hidden="true">{step.done ? <Check size={14} /> : index + 1}</span>
              <div>
                <b>{step.title}{step.optional && <em className="setup-steps__optional">Optional</em>}<span className="sr-only">{step.done ? " (done)" : " (to do)"}</span></b>
                <small>{step.body}</small>
              </div>
              <button type="button" className="quiet-button" onClick={() => onTour(index)}>Show me</button>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

// The guided tour: one step at a time, it opens the right page and lights up the thing to use, with a card beside it.
// Nothing is blocked: you can click the highlighted part (or anything else) while the card stays up.
function SetupTour({ steps, start, onScreen, onClose }: { steps: SetupStep[]; start: number; onScreen: (screen: Screen) => void; onClose: () => void }) {
  const [index, setIndex] = useState(start);
  const step = steps[Math.min(index, steps.length - 1)];
  const [rect, setRect] = useState<{ top: number; left: number; width: number; height: number } | null>(null);
  const last = index >= steps.length - 1;
  useEffect(() => { if (step.screen) onScreen(step.screen); }, [index]);
  useEffect(() => {
    // The page may still be opening, and things move as you scroll, so keep looking for the spot.
    let scrolled = false;
    const find = () => {
      const element = (step.spot || "").split(",").map((name) => document.querySelector<HTMLElement>(`[data-tour="${name}"]`)).find((found) => found && found.offsetParent !== null);
      if (element && !scrolled) { element.scrollIntoView({ block: "center", behavior: "smooth" }); scrolled = true; }
      const box = element?.getBoundingClientRect();
      const next = box ? { top: Math.round(box.top), left: Math.round(box.left), width: Math.round(box.width), height: Math.round(box.height) } : null;
      setRect((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next));
    };
    find();
    const timer = window.setInterval(find, 200);
    return () => window.clearInterval(timer);
  }, [index]);
  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "ArrowRight" && !last) setIndex((current) => current + 1);
      if (event.key === "ArrowLeft" && index > 0) setIndex((current) => current - 1);
    };
    window.addEventListener("keydown", keys);
    return () => window.removeEventListener("keydown", keys);
  }, [index, last, onClose]);
  const pad = 8;
  const cardWidth = Math.min(360, window.innerWidth - 32);
  // Below the spot if it fits, else above, else beside it, else in the bottom corner (for spots taller than the window).
  const room = 260;
  const left = rect ? Math.min(Math.max(16, rect.left), window.innerWidth - cardWidth - 16) : 0;
  const cardStyle = !rect
    ? { left: "50%", top: "50%", transform: "translate(-50%, -50%)", width: cardWidth }
    : window.innerHeight - (rect.top + rect.height + pad) > room
      ? { left, top: rect.top + rect.height + pad + 12, width: cardWidth }
      : rect.top - pad > room
        ? { left, bottom: window.innerHeight - rect.top + pad + 12, width: cardWidth }
        : window.innerWidth - (rect.left + rect.width + pad) > cardWidth + 28
          ? { left: rect.left + rect.width + pad + 12, top: Math.min(Math.max(16, rect.top), window.innerHeight - room - 16), width: cardWidth }
          : rect.left - pad > cardWidth + 28
            ? { left: rect.left - pad - 12 - cardWidth, top: Math.min(Math.max(16, rect.top), window.innerHeight - room - 16), width: cardWidth }
            : { right: 16, bottom: 16, width: cardWidth };
  return (
    <div className="setup-tour" aria-live="polite">
      {rect
        ? <div className="setup-tour__spot" style={{ top: rect.top - pad, left: rect.left - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 }} />
        : <div className="setup-tour__dim" />}
      <section className="setup-tour__card" style={cardStyle} role="dialog" aria-labelledby="setup-tour-title">
        <header>
          <small>Step {index + 1} of {steps.length}{step.optional && " · Optional"}{step.done && " · Done"}</small>
          <button type="button" className="close-button" onClick={onClose} aria-label="Close the tour"><X size={16} /></button>
        </header>
        <h3 id="setup-tour-title">{step.done && <Check size={16} aria-hidden="true" />} {step.title}</h3>
        <p>{step.body}</p>
        <div className="setup-tour__dots" aria-hidden="true">{steps.map((item, dot) => <i key={item.title} className={dot === index ? "is-current" : item.done ? "is-done" : undefined} />)}</div>
        <footer>
          <button type="button" className="quiet-button" onClick={() => setIndex(index - 1)} disabled={index === 0}>Back</button>
          {last
            ? <button type="button" className="primary-button" onClick={onClose}>Finish</button>
            : <button type="button" className="primary-button" onClick={() => setIndex(index + 1)}>Next <ChevronRight size={16} aria-hidden="true" /></button>}
        </footer>
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
  ai,
  campaignSettings,
  leads,
  fields,
  fullState,
  onRefresh,
  onNotice,
}: {
  fullState: State;
  fields?: string[];
  campaignSettings: Record<string, CampaignSettings>;
  leads: Lead[];
  me: Member;
  workspace: { id: string; name: string };
  team: Member[];
  emailReady: boolean;
  companies: { id: string; name: string; people: Member[] }[];
  onSignOut: () => void;
  connection: Connection | null;
  bookingUrl: string;
  ai: State["ai"];
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
  const [area, setArea] = useState<SettingsArea>(owner ? "general" : "account");
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
  // Each tab's sidebar is a few titled groups of pages.
  const sections: Record<SettingsArea, { title: string; items: { id: SettingsPage; label: string; icon: typeof Phone }[] }[]> = {
    general: [
      { title: "Costs", items: [{ id: "costs", label: "Features & costs", icon: ChartColumn }] },
      { title: "Calling", items: [{ id: "numbers", label: "Phone numbers", icon: Phone }, { id: "booking", label: "Booking link", icon: CalendarPlus }] },
      { title: "Integrations", items: [{ id: "ai", label: "AI", icon: Sparkles }, { id: "email", label: "Email", icon: Mail }] },
      { title: "Workspace", items: [{ id: "team", label: "Team", icon: Users }, { id: "fields", label: "Custom fields", icon: SlidersHorizontal }, ...(me.admin ? [{ id: "companies" as const, label: "Companies", icon: Building2 }] : [])] },
    ],
    account: [
      { title: "Account", items: [{ id: "profile", label: "Profile", icon: UserRound }, { id: "privacy", label: "Privacy", icon: ShieldCheck }] },
    ],
  };
  return (
    <section className="settings-page">
      <div className="settings-tabs" role="tablist" aria-label="Settings sections">
        {((owner ? ["general", "account"] : ["account"]) as SettingsArea[]).map((item) => (
          <button key={item} type="button" role="tab" aria-selected={area === item} className={area === item ? "is-active" : ""} onClick={() => selectPage(item, sections[item][0].items[0].id)}>
            {item}
          </button>
        ))}
      </div>
      <div className="settings-layout">
        <aside className="settings-nav" aria-label={`${area} settings`}>
          {sections[area].map((group) => (
            <div key={group.title} className="settings-nav__group">
              <span>{group.title}</span>
              {group.items.map((item) => (
                <button key={item.id} type="button" data-tour={`settings-${item.id}`} className={page === item.id ? "is-active" : ""} onClick={() => setPage(item.id)}><item.icon size={16} aria-hidden="true" />{item.label}</button>
              ))}
            </div>
          ))}
        </aside>
        <div className="settings-content">
        {page === "numbers" ? (
          <section className="settings-grid">
      <article className="settings-card connection-card" data-tour="twilio">
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
            <form className="bridge-form" data-tour="answer-on" onSubmit={saveBridge}>
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
            <p className="settings-help">Both are on your Twilio Console home page, under Account Info. <a className="settings-link" href="https://console.twilio.com/" target="_blank" rel="noreferrer">Open Twilio Console <ExternalLink size={12} aria-hidden="true" /></a></p>
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
      <article className="settings-card" data-tour="number">
        <span className="panel-kicker">Outbound line</span>
        <h2>Select an existing number</h2>
        <p>
          Open Dialer v2 only lists numbers already owned by the connected Twilio
          account. It never purchases numbers.
        </p>
        <p className="settings-help">Need a number? Buy one in Twilio, then validate again. <a className="settings-link" href="https://console.twilio.com/us1/develop/phone-numbers/manage/incoming" target="_blank" rel="noreferrer">Your Twilio numbers <ExternalLink size={12} aria-hidden="true" /></a></p>
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
          <SettingsPanel page={page} fullState={fullState} onOpen={(next) => setPage(next)} me={me} workspace={workspace} team={team} emailReady={emailReady} companies={companies} onSignOut={onSignOut} connection={connection} onNotice={onNotice} bookingUrl={bookingUrl} ai={ai} campaignSettings={campaignSettings} leads={leads} savedFields={fields} onRefresh={onRefresh} />
        )}
        </div>
      </div>
    </section>
  );
}

// Every {{variable}} used in a campaign script: where it fills from and whether AI cleans it. Edited in each campaign's settings.
function ScriptVariablesList({ settings, leads }: { settings: Record<string, CampaignSettings>; leads: Lead[] }) {
  const label = (source: string) => variableFields.find(([key]) => key === source)?.[1] || (source ? `Column: ${source.replace(/^detail:/, "")}` : "Not set");
  const rows = Object.entries(settings).flatMap(([campaign, config]) => {
    const columns = [...new Set(leads.filter((lead) => lead.campaigns?.includes(campaign)).flatMap((lead) => Object.keys(lead.details || {})))];
    return scriptVariables(config.script || "").map((name) => ({ name, campaign, source: config.variables?.[name] || guessVariable(name, columns), picked: Boolean(config.variables?.[name]), ai: Boolean(config.clean?.[name]) }));
  });
  return (
    <div className="script-variables-list">
      <h3>Script variables</h3>
      <p>The {"{{variables}}"} in your campaign scripts. Change where one fills from, or how AI cleans it, in that campaign's Settings, Variables.</p>
      {rows.length ? (
        <table>
          <thead><tr><th>Variable</th><th>Campaign</th><th>Fills from</th><th>AI cleanup</th></tr></thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.campaign}:${row.name}`}>
                <td><span className="se-var">{`{{${row.name}}}`}</span></td>
                <td>{row.campaign}</td>
                <td>{label(row.source)}{row.source && !row.picked ? <small> (automatic)</small> : null}</td>
                <td>{row.ai ? "On" : "Off"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <span className="script-variables-list__empty">No variables yet. Add one to a script with the Variable button.</span>}
    </div>
  );
}

// The company's own AI key, used to clean script variables. Saving checks the key with one tiny request.
const aiModels: Record<string, string> = { groq: "openai/gpt-oss-20b", openrouter: "google/gemma-4-26b-a4b-it:free" };
// ---- Settings → Features & costs ----
type Features = { transcription: boolean; captions: boolean; saveTranscripts: boolean; ai: boolean; email: boolean; sms: boolean };
const featureDefaults: Features = { transcription: false, captions: true, saveTranscripts: true, ai: true, email: true, sms: true };
const featuresOf = (state: State) => ({ ...featureDefaults, ...(state.settings?.features || {}) });
// Twilio bills each call leg by the started minute.
const billedMinutes = (seconds = 0) => (seconds > 0 ? Math.ceil(seconds / 60) : 0);

function PriceTag({ text, free }: { text: string; free?: boolean }) {
  return <span className={`price-tag${free ? " is-free" : ""}`}>{text}</span>;
}
function FeatureSwitch({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled?: boolean; onChange: (next: boolean) => void }) {
  return (
    <label className="automation-switch">
      <input type="checkbox" role="switch" aria-label={label} checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <span>{checked ? "On" : "Off"}</span>
    </label>
  );
}

function CostsSettings({ state, onOpen, onRefresh, onNotice }: { state: State; onOpen: (page: SettingsPage) => void; onRefresh: () => Promise<unknown>; onNotice: (message: string) => void }) {
  const on = featuresOf(state);
  const [hours, setHours] = useState(3);
  const [days, setDays] = useState(22);
  const set = async (change: Partial<Features>) => {
    try {
      await api("/api/settings/features", { method: "PATCH", body: JSON.stringify(change) });
      await onRefresh();
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "Couldn't save that switch.");
    }
  };
  const browser = usesAppPhone(state.connection);
  const perMinute = prices.twilioCall.amount + (browser ? prices.twilioBrowser.amount : 0);
  // This month so far, from the app's own call log.
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();
  const thisMonth = state.calls.filter((call) => call.seconds && new Date(call.at).getTime() >= monthStart);
  const talkMinutes = thisMonth.reduce((sum, call) => sum + billedMinutes(call.seconds), 0);
  const heardMinutes = thisMonth.filter((call) => call.transcribing).reduce((sum, call) => sum + billedMinutes(call.seconds), 0);
  const soFar = (state.connection ? prices.twilioNumber.amount : 0) + talkMinutes * perMinute + heardMinutes * prices.twilioTranscription.amount;
  // What a month would cost with the switches as they are now.
  const planMinutes = hours * 60 * days;
  const plan = { calling: planMinutes * perMinute, transcription: on.transcription ? planMinutes * prices.twilioTranscription.amount : 0, number: prices.twilioNumber.amount };
  const oldest = Object.values(prices).map((item) => item.checked).sort()[0];
  const stale = Date.now() - new Date(oldest).getTime() > 90 * 86_400_000;
  const rows: { name: string; what: string; price: ReactNode; control: ReactNode; extra?: ReactNode }[] = [
    {
      name: "Calling",
      what: "Twilio phone number and call minutes. Your own Twilio account bills you directly.",
      price: <><PriceTag text={`${money(prices.twilioNumber.amount)} a month for the number`} /><PriceTag text={`${money(perMinute)} a minute${browser ? " (call + in-app audio)" : ""}`} /></>,
      control: <button type="button" className="text-link" onClick={() => onOpen("numbers")}>Phone numbers</button>,
    },
    {
      name: "Live transcription",
      what: "Twilio writes down both sides while you talk. No audio is recorded. Needed for Call transcribed automations. Works on calls made in this app.",
      price: <PriceTag text={`${money(prices.twilioTranscription.amount)} a minute, only on transcribed calls`} />,
      control: <FeatureSwitch label="Live transcription" checked={on.transcription} onChange={(next) => void set({ transcription: next })} />,
      extra: on.transcription && (
        <div className="feature-row__sub">
          <label><input type="checkbox" checked={on.captions} onChange={(event) => void set({ captions: event.target.checked })} /> Show live captions on the call screen</label>
          <label><input type="checkbox" checked={on.saveTranscripts} onChange={(event) => void set({ saveTranscripts: event.target.checked })} /> Save transcripts in call history <small>(off: used for automations, then deleted)</small></label>
          <small>A campaign can opt out in its Settings, General. You can also stop it during a call.</small>
        </div>
      ),
    },
    {
      name: "AI (Groq or OpenRouter)",
      what: "Powers every AI feature in Open Dialer, like cleaning script variables and Ask AI in automations, plus new ones as they arrive. Uses your own key.",
      price: <PriceTag text="Free to start" free />,
      control: <>{state.ai?.ready ? <button type="button" className="text-link" onClick={() => onOpen("ai")}>Key saved</button> : <button type="button" className="text-link" onClick={() => onOpen("ai")}>Add a key</button>}<FeatureSwitch label="AI" checked={on.ai} onChange={(next) => void set({ ai: next })} /></>,
    },
    {
      name: "Email (Resend)",
      what: "Sends team invites and password resets from your own domain. Off: you copy the invite link yourself.",
      price: <PriceTag text="Free to start" free />,
      control: <>{state.email?.saved || state.email?.envFallback ? <button type="button" className="text-link" onClick={() => onOpen("email")}>Sender set</button> : <button type="button" className="text-link" onClick={() => onOpen("email")}>Add a key</button>}<FeatureSwitch label="Email" checked={on.email} onChange={(next) => void set({ email: next })} /></>,
    },
    {
      name: "Text messages (SMS)",
      what: "Send text steps in automations, from your Twilio number. US texting needs 10DLC registration in Twilio first. Off: those steps are skipped.",
      price: <><PriceTag text={`about ${money(prices.twilioSms.amount)} a text`} /><PriceTag text={prices.twilioSms.setup} /></>,
      control: <FeatureSwitch label="Text messages" checked={on.sms} onChange={(next) => void set({ sms: next })} />,
    },
    { name: "Voicemail drop", what: "Plays one of your recordings to the lead's voicemail and hangs up. Only the call minutes you're already on.", price: <PriceTag text="Free" free />, control: null },
    { name: "Booking link", what: "Opens your own Calendly or Cal.com page during a call.", price: <PriceTag text="Free" free />, control: <button type="button" className="text-link" onClick={() => onOpen("booking")}>Booking link</button> },
    { name: "Automations", what: "Run inside this app. Steps that use AI, email, texts or transcription cost what those do.", price: <PriceTag text="Free" free />, control: null },
  ];
  return (
    <section className="settings-panel costs">
      <span className="panel-kicker">Workspace</span>
      <h2>Features & costs</h2>
      <p>What each part of Open Dialer costs, and a switch for everything that isn't free. Prices are the providers' list prices; you pay them directly, not through Open Dialer.</p>
      <div className="costs-summary">
        <article>
          <small>This month so far</small>
          <b>about {money(soFar)}</b>
          <span>{talkMinutes} call minute{talkMinutes === 1 ? "" : "s"}{heardMinutes ? `, ${heardMinutes} transcribed` : ""}{state.connection ? ", plus the number" : ""}. An estimate from this app's call log; your Twilio console has the real bill.</span>
        </article>
        <article>
          <small>A month like this</small>
          <b>about {money(plan.calling + plan.transcription + plan.number)}</b>
          <span className="costs-plan">
            <label><input type="number" min={0} max={12} step={0.5} value={hours} onChange={(event) => setHours(Math.max(0, Number(event.target.value) || 0))} /> hours of talk a day</label>
            <label><input type="number" min={0} max={31} value={days} onChange={(event) => setDays(Math.max(0, Number(event.target.value) || 0))} /> days</label>
          </span>
          <span>Calling {money(plan.calling)}{on.transcription ? ` · transcription ${money(plan.transcription)}` : ""} · number {money(plan.number)}</span>
        </article>
      </div>
      <div className="feature-rows">
        {rows.map((row) => (
          <article className="feature-row" key={row.name}>
            <div className="feature-row__text"><b>{row.name}</b><span>{row.what}</span><span className="feature-row__prices">{row.price}</span>{row.extra}</div>
            <div className="feature-row__control">{row.control}</div>
          </article>
        ))}
      </div>
      <p className={`costs-checked${stale ? " is-stale" : ""}`}>{stale ? <CircleAlert size={14} aria-hidden="true" /> : null} Prices last checked {new Date(oldest).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}{stale ? ". That's over 3 months ago: re-check them with PRICES.md in the project folder." : "."}</p>
    </section>
  );
}

// ---- Settings → Email ----
function EmailSettings({ email, onRefresh, onNotice }: { email: State["email"]; onRefresh: () => Promise<unknown>; onNotice: (message: string) => void }) {
  const [key, setKey] = useState("");
  const [from, setFrom] = useState(email?.from || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (task: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setError(null);
    try {
      await task();
      await onRefresh();
      onNotice(done);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That didn't work.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="settings-panel">
      <span className="panel-kicker">Integrations</span>
      <h2>Email</h2>
      <p>Invites and password resets go out through your own Resend account, from your own domain. <PriceTag text="Free to start" free /> {prices.resend.free}.</p>
      <p className="settings-help">Add and verify your domain in Resend, then create an API key. <a className="settings-link" href="https://resend.com/domains" target="_blank" rel="noreferrer">Resend domains <ExternalLink size={12} aria-hidden="true" /></a> <a className="settings-link" href="https://resend.com/api-keys" target="_blank" rel="noreferrer">Resend API keys <ExternalLink size={12} aria-hidden="true" /></a></p>
      <form className="settings-form" onSubmit={(event) => { event.preventDefault(); void run(() => api("/api/email/settings", { method: "PUT", body: JSON.stringify({ key, from }) }).then(() => setKey("")), "Email sender saved."); }}>
        {error && <p className="form-error" role="alert">{error}</p>}
        <label>Resend API key<input type="password" value={key} onChange={(event) => setKey(event.target.value)} placeholder={email?.hint ? `Saved: ${email.hint}. Paste a new one to replace it` : "re_…"} autoComplete="off" spellCheck={false} /></label>
        <label>Send from<input value={from} onChange={(event) => setFrom(event.target.value)} placeholder="Bayu <bayu@yourdomain.com>" autoComplete="off" spellCheck={false} required /><small>An address on the domain you verified in Resend.</small></label>
        <div className="settings-form-actions">
          <button className="primary-button" type="submit" disabled={busy}>Save</button>
          {(email?.saved || email?.envFallback) && <button type="button" className="quiet-button" disabled={busy} onClick={() => void run(async () => { const result = await api<{ sentTo: string }>("/api/email/test", { method: "POST" }); onNotice(`Test email sent to ${result.sentTo}.`); }, "Test email sent.")}>Send me a test email</button>}
          {email?.saved && <button type="button" className="quiet-button" disabled={busy} onClick={() => void run(() => api("/api/email/settings", { method: "DELETE" }), "Email key removed.")}>Remove key</button>}
        </div>
        {!email?.saved && email?.envFallback && <small>Using the sender from the server's .env file. A key saved here replaces it for this company.</small>}
      </form>
    </section>
  );
}

// Live captions while a transcribed call runs: both sides, newest at the bottom, and a way to stop it.
function LiveCaptions({ callId }: { callId: string }) {
  const [data, setData] = useState<{ on: boolean; stopped: boolean; lines: { who: string; text: string }[]; partial: Record<string, string> } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const next = await api<NonNullable<typeof data>>(`/api/calls/${callId}/transcript`);
        if (alive) setData(next);
      } catch { /* the call may not be saved yet */ }
    };
    void tick();
    const timer = window.setInterval(tick, 1500);
    return () => { alive = false; window.clearInterval(timer); };
  }, [callId]);
  useEffect(() => end.current?.scrollIntoView({ block: "end" }), [data?.lines.length, data?.partial.you, data?.partial.lead]);
  if (!data?.on) return null;
  const partial = Object.entries(data.partial).filter(([, text]) => text);
  return (
    <aside className="live-captions" aria-label="Live transcript" aria-live="polite">
      <header>
        <b>Live transcript</b>
        {data.stopped ? <small>Stopped</small> : <button type="button" className="text-link" onClick={() => void api("/api/calls/transcript/stop", { method: "POST", body: JSON.stringify({ callId }) }).catch((cause) => setError(cause instanceof Error ? cause.message : "Couldn't stop it."))}>Stop transcribing</button>}
      </header>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="live-captions__lines">
        {!data.lines.length && !partial.length && <p className="live-captions__empty">Listening…</p>}
        {data.lines.slice(-30).map((line, index) => <p key={index} className={`is-${line.who}`}><b>{line.who === "you" ? "You" : "Them"}</b> {line.text}</p>)}
        {partial.map(([who, text]) => <p key={who} className={`is-${who} is-partial`}><b>{who === "you" ? "You" : "Them"}</b> {text}</p>)}
        <div ref={end} />
      </div>
    </aside>
  );
}

function AiSettings({ ai, onRefresh, onNotice }: { ai: State["ai"]; onRefresh: () => Promise<unknown>; onNotice: (message: string) => void }) {
  const [provider, setProvider] = useState(ai?.provider || "groq");
  const [model, setModel] = useState(ai?.model || aiModels[ai?.provider || "groq"]);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/api/ai/settings", { method: "PUT", body: JSON.stringify({ provider, model, key }) });
      setKey("");
      await onRefresh();
      onNotice("AI key checked and saved.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't save the key.");
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    await api("/api/ai/settings", { method: "DELETE" }).catch(() => {});
    await onRefresh();
    onNotice("AI key removed.");
  };
  return (
    <section className="settings-panel">
      <span className="panel-kicker">Workspace</span>
      <h2>AI</h2>
      <p>Powers every AI feature in Open Dialer: cleaning script variables, Ask AI in automations, and the ones still to come. Each feature sends only what it needs, like a variable's text or a call's transcript, never phone numbers.</p>
      <form className="settings-form" onSubmit={save}>
        {error && <p className="form-error" role="alert">{error}</p>}
        <label>
          Provider
          <select value={provider} onChange={(event) => { setProvider(event.target.value); setModel(aiModels[event.target.value]); }}>
            <option value="groq">Groq (fast, free plan)</option>
            <option value="openrouter">OpenRouter</option>
          </select>
        </label>
        <label>
          API key
          <input type="password" value={key} onChange={(event) => setKey(event.target.value)} placeholder={ai?.hint && ai.provider === provider ? `Saved: ${ai.hint}. Paste a new one to replace it` : provider === "groq" ? "gsk_…" : "sk-or-…"} autoComplete="off" spellCheck={false} />
          <small>{provider === "groq" ? <>Create a free one in Groq's console. <a className="settings-link" href="https://console.groq.com/keys" target="_blank" rel="noreferrer">Get a Groq key <ExternalLink size={12} aria-hidden="true" /></a></> : <>Create one in your OpenRouter account. <a className="settings-link" href="https://openrouter.ai/settings/keys" target="_blank" rel="noreferrer">Get an OpenRouter key <ExternalLink size={12} aria-hidden="true" /></a></>}</small>
        </label>
        <label>
          Model
          <input value={model} onChange={(event) => setModel(event.target.value)} autoComplete="off" spellCheck={false} />
        </label>
        <div className="settings-form-actions">
          <button className="primary-button" type="submit" disabled={busy}>{busy ? "Checking…" : "Check and save"}</button>
          {ai?.hint && <button type="button" className="quiet-button" onClick={() => void remove()}>Remove key</button>}
        </div>
        {!ai?.hint && ai?.ready && <small>Using the key from the server's .env file. A key saved here replaces it for this company.</small>}
      </form>
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
  fullState,
  onOpen,
  me,
  workspace,
  team,
  emailReady,
  companies,
  onSignOut,
  connection,
  onNotice,
  bookingUrl,
  ai,
  campaignSettings,
  leads,
  savedFields,
  onRefresh,
}: {
  fullState: State;
  onOpen: (page: SettingsPage) => void;
  savedFields?: string[];
  ai: State["ai"];
  campaignSettings: Record<string, CampaignSettings>;
  leads: Lead[];
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
  const fields = savedFields || [];
  const saveFields = async (next: string[]) => {
    try {
      await api("/api/settings/fields", { method: "PUT", body: JSON.stringify({ fields: next }) });
      await onRefresh();
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "Couldn't save the custom fields.");
    }
  };
  // Fields made before they were saved for the company lived only in this browser: move them over once.
  useEffect(() => {
    try {
      const local: string[] = JSON.parse(localStorage.getItem("open-dialer-lead-fields") || "[]");
      if (local.length && !fields.length && me.role === "owner") void saveFields(local).then(() => localStorage.removeItem("open-dialer-lead-fields"));
    } catch {}
  }, []);

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
        <p className="settings-help">Copy the link of the event you book calls with: <a className="settings-link" href="https://calendly.com/event_types/user/me" target="_blank" rel="noreferrer">Calendly event types <ExternalLink size={12} aria-hidden="true" /></a> <a className="settings-link" href="https://app.cal.com/event-types" target="_blank" rel="noreferrer">Cal.com event types <ExternalLink size={12} aria-hidden="true" /></a></p>
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
  if (page === "ai") return <AiSettings ai={ai} onRefresh={onRefresh} onNotice={onNotice} />;
  if (page === "costs") return <CostsSettings state={fullState} onOpen={onOpen} onRefresh={onRefresh} onNotice={onNotice} />;
  if (page === "email") return <EmailSettings email={fullState.email} onRefresh={onRefresh} onNotice={onNotice} />;
  if (page === "team") return <TeamSettings me={me} workspace={workspace} team={team} emailReady={emailReady} onRefresh={onRefresh} onNotice={onNotice} />;
  if (page === "companies") return <CompaniesSettings companies={companies} emailReady={emailReady} onRefresh={onRefresh} onNotice={onNotice} />;
  if (page === "fields") {
    return (
      <section className="settings-panel">
        <span className="panel-kicker">Workspace</span>
        <h2>Custom fields</h2>
        <p>Extra details your team fills in on every lead, like Territory. They show on each lead's form for everyone in this company, and you can use them as script variables.</p>
        <form className="inline-form" onSubmit={(event) => { event.preventDefault(); const value = fieldName.trim(); if (!value || fields.includes(value)) return; setFieldName(""); void saveFields([...fields, value]); }}>
          <input value={fieldName} onChange={(event) => setFieldName(event.target.value)} placeholder="e.g. Territory" maxLength={60} />
          <button className="primary-button" type="submit">Add field</button>
        </form>
        <div className="field-pills">{fields.length ? fields.map((field) => <button key={field} type="button" aria-label={`Remove ${field}`} onClick={() => void saveFields(fields.filter((item) => item !== field))}>{field} <X size={13} /></button>) : <span>No custom fields yet.</span>}</div>
        <ScriptVariablesList settings={campaignSettings} leads={leads} />
      </section>
    );
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
  fields = [],
}: {
  fields?: string[];
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
          // Custom fields arrive as "field:Territory" inputs and are saved in the lead's details.
          const details: Record<string, unknown> = {};
          for (const key of Object.keys(body)) if (key.startsWith("field:")) { details[key.slice(6)] = body[key]; delete body[key]; }
          if (Object.keys(details).length) body.details = details;
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
          Organization
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
        {fields.map((field) => (
          <label key={field}>
            {field}
            <input name={`field:${field}`} defaultValue={lead?.details?.[field] || ""} autoComplete="off" />
          </label>
        ))}
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
