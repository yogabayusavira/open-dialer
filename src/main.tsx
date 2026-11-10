import { FormEvent, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  BadgeCheck,
  CalendarClock,
  Check,
  ChevronRight,
  CircleAlert,
  CircleDot,
  ClipboardList,
  FileUp,
  Filter,
  LoaderCircle,
  LockKeyhole,
  MoreHorizontal,
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
} from "lucide-react";
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
};
type Connection = {
  accountSid: string;
  selectedNumber: string;
  selectedNumberLabel: string;
  connectedAt: string;
  bridgeNumber?: string;
};
type Opportunity = {
  id: string;
  leadId: string;
  name: string;
  company: string;
  contact: string;
  value: number;
  stage: "Qualification" | "Proposal" | "Negotiation" | "Closed Won" | "Closed Lost";
  createdAt: string;
};
type CallRecord = {
  id: string;
  leadId: string;
  outcome: string;
  note: string;
  at: string;
};
type State = {
  leads: Lead[];
  activity: { id: string; at: string; action: string; detail: string }[];
  connection: Connection | null;
  opportunities: Opportunity[];
  calls: CallRecord[];
  dncNumbers: string[];
};
type NumberOption = { sid: string; number: string; label: string };
type Session = { requiresAuth: boolean; authenticated: boolean };
type Screen = "queue" | "calls" | "leads" | "followups" | "activity" | "pipeline" | "settings";
type SettingsArea = "calling" | "workspace" | "account";
type SettingsPage =
  | "numbers"
  | "team"
  | "fields"
  | "profile"
  | "privacy";

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
  { id: "leads", key: "leads", label: "Leads", icon: Users },
  { id: "calls", key: "calls", label: "Calls", icon: Phone },
  { id: "tasks", key: "followups", label: "Tasks", icon: CalendarClock },
  { id: "sequences", key: "activity", label: "Sequences", icon: ClipboardList },
  { id: "pipeline", key: "pipeline", label: "Pipeline", icon: SlidersHorizontal },
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
    throw new ApiError(body.error || "Something went wrong.", response.status);
  }
  return body;
}

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

function Login({ onSignedIn }: { onSignedIn: () => void }) {
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/api/session", {
        method: "POST",
        body: JSON.stringify({ password, remember }),
      });
      setPassword("");
      onSignedIn();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not sign in.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="login-page">
      <form className="login-card" onSubmit={submit}>
        <div className="brand">
          <span className="brand-mark">C</span>
          <span>Open Dialer v2</span>
        </div>
        <h1>Operator sign-in</h1>
        <p>
          Enter the application password configured in Dokploy to access this
          workspace.
        </p>
        <label>
          Application password
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        <label className="login-remember">
          <input
            type="checkbox"
            checked={remember}
            onChange={(event) => setRemember(event.target.checked)}
          />
          <span>Remember me for 30 days</span>
        </label>
        {error && <p className="form-error">{error}</p>}
        <button className="primary-button" type="submit" disabled={busy}>
          {busy ? (
            <LoaderCircle className="spin" size={17} />
          ) : (
            <LockKeyhole size={17} />
          )}{" "}
          Sign in
        </button>
      </form>
    </main>
  );
}

function App() {
  const [screen, setScreen] = useState<Screen>("leads");
  const [state, setState] = useState<State | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showLeadForm, setShowLeadForm] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [dncOpen, setDncOpen] = useState(false);
  const [convertLead, setConvertLead] = useState<Lead | null>(null);
  const [outcomeLead, setOutcomeLead] = useState<Lead | null>(null);
  const [tourStep, setTourStep] = useState<number | null>(null);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [lightMode, setLightMode] = useState(() => localStorage.getItem("open-dialer-theme") === "light");

  const refresh = async () => {
    try {
      const next = await api<State>("/api/state");
      if (!Array.isArray(next.leads) || !Array.isArray(next.activity)) {
        throw new Error("The Open Dialer API is unavailable. Check that the service is running with node server.mjs.");
      }
      setState(next);
      setLoadError(null);
      setSelectedId((current) => current || next.leads[0]?.id || null);
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
        if (session.requiresAuth && !session.authenticated) {
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
  const selected = useMemo(
    () =>
      state?.leads.find((lead) => lead.id === selectedId) || state?.leads[0],
    [state, selectedId],
  );
  const followUps =
    state?.leads.filter((lead) => lead.status === "Follow-up") || [];
  const todayLabel = new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric",
  }).format(new Date());

  const prepareCall = async (lead: Lead) => {
    try {
      await api("/api/calls/start", {
        method: "POST",
        body: JSON.stringify({ leadId: lead.id }),
      });
      await refresh();
      setNotice(`Calling your bridge number now. Answer it to connect with ${lead.name}.`);
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
          ? `${lead.name} is now suppressed from calling.`
          : `${lead.name} is active again.`,
      );
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : "Could not update the lead.",
      );
    }
  };
  const updateOpportunity = async (id: string, body: Partial<Pick<Opportunity, "stage" | "value">>) => {
    try {
      await api(`/api/opportunities/${id}`, { method: "PATCH", body: JSON.stringify(body) });
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not update the opportunity.");
    }
  };

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
    return (
      <main className="loading">
        <LoaderCircle className="spin" size={28} /> Loading Open Dialer v2…
      </main>
    );
  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">C</span>
          <span>Open Dialer v2</span>
        </div>
        <div className="workspace-label">Workspace</div>
        <nav aria-label="Workspace navigation">
          {nav.map(({ id, key, label, icon: Icon }) => (
            <button
              key={id}
              className={
                (screen === key && (key !== "queue" || id === "dashboard")) ||
                (screen === "activity" && id === "sequences")
                  ? "nav-item nav-item--active"
                  : "nav-item"
              }
              onClick={() => setScreen(key)}
            >
              <Icon size={18} />
              <span>{label}</span>
              {id === "tasks" && <b>{followUps.length}</b>}
            </button>
          ))}
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
            <span className="account-summary__avatar">C</span>
            <span>
              <b>Open Dialer v2 workspace</b>
              <small>Account &amp; billing</small>
            </span>
            <ChevronRight size={15} />
          </button>
        </div>
      </aside>
      <section className="workbench">
        {screen !== "calls" && <header className="topbar">
          <div>
            <p className="date-line">Workspace</p>
            <h1>
              {screen === "queue"
                ? "Today’s route"
                : screen === "settings"
                  ? "Settings"
                  : nav.find((item) => item.key === screen)?.label}
            </h1>
            {screen === "leads" && (
              <p className="page-subtitle">
                Everyone you’re calling, with the next action easy to spot.
              </p>
            )}
          </div>
          <div className="top-actions">
            <button
              className="quick-tour-button"
              onClick={() => setTourStep(0)}
            >
              <BadgeCheck size={17} /> Quick tour
            </button>
            <button
              className="primary-button"
              onClick={() => setShowLeadForm(true)}
            >
              <Plus size={18} /> Add lead
            </button>
          </div>
        </header>}
        {notice && (
          <div className="notice" role="status">
            <CircleAlert size={18} />
            <span>{notice}</span>
            <button aria-label="Dismiss notice" onClick={() => setNotice(null)}>
              <X size={18} />
            </button>
          </div>
        )}
        {screen === "queue" && selected && (
          <Queue
            state={state}
            selected={selected}
            onSelect={setSelectedId}
            onPrepare={prepareCall}
            onRecord={(lead) => setOutcomeLead(lead)}
            onDnc={setDnc}
            onSettings={() => setScreen("settings")}
          />
        )}
        {screen === "calls" && (
          <CallHistory
            calls={state.calls}
            leads={state.leads}
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
            leads={state.leads}
            selectedId={selected?.id || null}
            onOpen={(id) => {
              setSelectedId(id);
              setScreen("queue");
            }}
            onConvert={(lead) => setConvertLead(lead)}
            onImport={() => setImportOpen(true)}
            onDncList={() => setDncOpen(true)}
          />
        )}
        {screen === "followups" && (
          <FollowUps
            leads={followUps}
            onSelect={(id) => {
              setSelectedId(id);
              setScreen("queue");
            }}
          />
        )}
        {screen === "activity" && <ActivityLog activity={state.activity} />}
        {screen === "pipeline" && (
          <Pipeline opportunities={state.opportunities} onUpdate={updateOpportunity} />
        )}
        {screen === "settings" && (
          <Settings
            connection={state.connection}
            onRefresh={refresh}
            onNotice={setNotice}
          />
        )}
      </section>
      {showLeadForm && (
        <LeadForm
          onClose={() => setShowLeadForm(false)}
          onSaved={async () => {
            setShowLeadForm(false);
            await refresh();
            setNotice("Lead added to the route.");
          }}
        />
      )}
      {importOpen && <ImportLeads onClose={() => setImportOpen(false)} onSaved={async (message) => { setImportOpen(false); await refresh(); setNotice(message); }} />}
      {dncOpen && <DncList onClose={() => setDncOpen(false)} onSaved={async (message) => { setDncOpen(false); await refresh(); setNotice(message); }} />}
      {convertLead && <ConvertLead lead={convertLead} onClose={() => setConvertLead(null)} onSaved={async () => { setConvertLead(null); await refresh(); setScreen("pipeline"); setNotice(`${convertLead.name} is now an opportunity.`); }} />}
      {outcomeLead && <CallOutcome lead={outcomeLead} onClose={() => setOutcomeLead(null)} onSaved={async () => { setOutcomeLead(null); await refresh(); }} />}
      {tourStep !== null && (
        <QuickTour
          step={tourStep}
          onClose={() => setTourStep(null)}
          onBack={() => setTourStep((current) => Math.max(0, (current || 0) - 1))}
          onNext={() => {
            if (tourStep === 0) setScreen("leads");
            if (tourStep === 2) {
              setScreen("queue");
              setTourStep(null);
              return;
            }
            setTourStep((current) => Math.min(2, (current || 0) + 1));
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
}: {
  calls: CallRecord[];
  leads: Lead[];
  onStartDialing: () => void;
  onOpenDialer: () => void;
  onOpenPhoneNumbers: () => void;
  onUpgrade: () => void;
}) {
  const [view, setView] = useState<"conversations" | "attempts" | "callbacks">("conversations");
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
    .filter((call) => [call.lead?.name, call.lead?.company, call.outcome, call.note].join(" ").toLowerCase().includes(query.toLowerCase()));
  const exportCalls = () => {
    const lines = [["Date", "Lead", "Company", "Phone", "Outcome", "Note"], ...entries.map((call) => [new Date(call.at).toLocaleString(), call.lead?.name || "", call.lead?.company || "", call.lead?.phone || "", call.outcome, call.note])];
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
    <section className="calls-page" aria-labelledby="calls-heading">
      <header className="calls-page__header">
        <div className="calls-page__title">
          <span className="calls-page__icon"><PhoneCall size={21} /></span>
          <div>
            <h1 id="calls-heading">Calls</h1>
            <p>{subtitle}</p>
          </div>
        </div>
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
              placeholder="Search anything..."
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
            </select>
          </label>
        </div>
      )}

      {!entries.length ? <div className="calls-empty"><p>{isCallbacks ? "No callbacks are recorded yet." : "No calls match this view."}</p><span><button type="button" onClick={onStartDialing}>Open leads →</button> or <button type="button" onClick={onOpenPhoneNumbers}>review phone settings →</button></span></div> : <div className="call-history-list">{entries.map((call) => <article key={call.id}><div><b>{call.lead?.name}</b><small>{call.lead?.company} · {call.lead?.phone}</small></div><Status tone={call.outcome === "Do not call" ? "alert" : "good"}>{call.outcome}</Status><div><small>{new Date(call.at).toLocaleString()}</small>{call.note && <p>{call.note}</p>}</div></article>)}</div>}
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
  onSettings,
}: {
  state: State;
  selected: Lead;
  onSelect: (id: string) => void;
  onPrepare: (lead: Lead) => void;
  onRecord: (lead: Lead) => void;
  onDnc: (lead: Lead, value: boolean) => void;
  onSettings: () => void;
}) {
  const upcoming = state.leads.filter((lead) => !lead.dnc);
  return (
    <div className="queue-page">
      <section className="route-header">
        <div>
          <span className="route-label">
            Calling queue / {upcoming.length} ready
          </span>
          <h2>The next responsible call is already in context.</h2>
        </div>
        <div className="route-stops">
          <span>
            <i /> Queue open
          </span>
          <span>
            <i className="route-stops__muted" />{" "}
            {state.connection ? "Line selected" : "Line not connected"}
          </span>
        </div>
      </section>
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
              <span className="lead-time">{lead.due}</span>
              <span>
                <b>{lead.name}</b>
                <small>{lead.company}</small>
              </span>
              <ChevronRight size={17} />
            </button>
          ))}
        </aside>
        <article className="call-panel">
          <div className="call-panel__bar">
            <span>Current stop</span>
            <Status tone={selected.dnc ? "alert" : "quiet"}>
              {selected.dnc ? "Suppressed" : "Window pending"}
            </Status>
          </div>
          <div className="lead-heading">
            <div>
              <h2>{selected.name}</h2>
              <p>
                {selected.role} · {selected.company}
              </p>
            </div>
            <button
              className="quiet-button"
              onClick={() => onDnc(selected, !selected.dnc)}
            >
              {selected.dnc ? "Restore calling" : "Do not call"}
            </button>
          </div>
          <dl className="facts">
            <div>
              <dt>Phone</dt>
              <dd>{selected.phone}</dd>
            </div>
            <div>
              <dt>Local time zone</dt>
              <dd>
                {selected.timezone.replace("America/", "").replace("_", " ")}
              </dd>
            </div>
            <div>
              <dt>Stage</dt>
              <dd>{selected.status}</dd>
            </div>
          </dl>
          <div className="call-objective">
            <span>Call objective</span>
            <p>{selected.note}</p>
          </div>
          <div className="call-actions">
            <button
              className="call-button"
              onClick={() => onPrepare(selected)}
              disabled={selected.dnc}
            >
              <Phone size={19} /> Call lead
            </button>
            <button className="quiet-button" onClick={() => onRecord(selected)}>Log outcome</button>
          </div>
          <p className="compliance-note">
            <LockKeyhole size={15} />{" "}
            {state.connection ? (
              `Outbound line: ${state.connection.selectedNumber}`
            ) : (
              <>
                <button onClick={onSettings}>Connect your Twilio line</button>{" "}
                before calls can be prepared.
              </>
            )}{" "}
            Calls ring your saved operator number first, then connect the lead.
          </p>
        </article>
        <aside className="guardrail-panel">
          <div>
            <span className="panel-kicker">Guardrails</span>
            <h3>Controls applied before calls</h3>
          </div>
          <ul>
            <li>
              <BadgeCheck size={18} />
              <span>
                <b>Do-not-call status</b>
                <small>{selected.dnc ? "Blocked" : "Clear"}</small>
              </span>
            </li>
            <li>
              <CircleAlert size={18} />
              <span>
                <b>Local calling window</b>
                <small>
                  {selected.dnc ? "Blocked" : "Verified when Voice is enabled"}
                </small>
              </span>
            </li>
            <li>
              <BadgeCheck size={18} />
              <span>
                <b>Selected number</b>
                <small>
                  {state.connection?.selectedNumber || "Not configured"}
                </small>
              </span>
            </li>
          </ul>
          <div className="guardrail-footer">
            DNC, the selected number, and the calling bridge are checked before every call.
          </div>
        </aside>
      </section>
    </div>
  );
}

function LeadList({
  leads,
  selectedId,
  onOpen,
  onConvert,
  onImport,
  onDncList,
}: {
  leads: Lead[];
  selectedId: string | null;
  onOpen: (id: string) => void;
  onConvert: (lead: Lead) => void;
  onImport: () => void;
  onDncList: () => void;
}) {
  const [query, setQuery] = useState("");
  const [filterOpen, setFilterOpen] = useState(false);
  const [sort, setSort] = useState<"newest" | "name">("newest");
  const [segment, setSegment] = useState<
    "all" | "to-call" | "try-again" | "follow-up" | "closed"
  >("all");
  const groups = {
    "to-call": leads.filter((lead) => !lead.dnc && lead.status === "Ready"),
    "try-again": leads.filter((lead) => /again|answer|busy|failed/i.test(lead.status)),
    "follow-up": leads.filter((lead) => lead.status === "Follow-up"),
    closed: leads.filter((lead) => lead.dnc || /closed|not interested|wrong/i.test(lead.status)),
  };
  const tabs = [
    { key: "all" as const, label: "All leads", detail: "Every active prospect", count: leads.length },
    { key: "to-call" as const, label: "To call", detail: "Ready for a first attempt", count: groups["to-call"].length },
    { key: "try-again" as const, label: "Try again", detail: "No answer, busy, or failed", count: groups["try-again"].length },
    { key: "follow-up" as const, label: "Follow up", detail: "A scheduled next step", count: groups["follow-up"].length },
    { key: "closed" as const, label: "Closed", detail: "DNC or no longer active", count: groups.closed.length },
  ];
  const visibleLeads = (segment === "all" ? leads : groups[segment])
    .filter((lead) => [lead.name, lead.company, lead.phone, lead.status].join(" ").toLowerCase().includes(query.trim().toLowerCase()))
    .sort((left, right) => sort === "name" ? left.name.localeCompare(right.name) : 0);

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
            <span>{tab.label}</span>
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
          <button className="toolbar-button" type="button" onClick={onDncList}>
            DNC list
          </button>
        </div>
      </div>
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
            <col className="lead-col--sequence" />
            <col className="lead-col--actions" />
          </colgroup>
          <thead>
            <tr>
              <th scope="col"><span className="sr-only">Select</span></th>
              <th scope="col">Prospect</th>
              <th scope="col">Contact</th>
              <th scope="col">Status</th>
              <th scope="col">Last call</th>
              <th scope="col">Email activity</th>
              <th scope="col">Sequence</th>
              <th scope="col"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {visibleLeads.map((lead) => {
              const initials = lead.name
                .split(" ")
                .map((part) => part[0])
                .join("")
                .slice(0, 2)
                .toUpperCase();
              const tag = lead.dnc
                ? "do not call"
                : lead.status === "Follow-up"
                  ? "needs follow up"
                  : "no status";
              const statusLabel = lead.dnc
                ? "DNC"
                : lead.status === "Follow-up"
                  ? "FOLLOW UP"
                  : "NEW";
              return (
                <tr className={lead.id === selectedId ? "is-current" : undefined} key={lead.id}>
                <td><input type="checkbox" aria-label={`Select ${lead.name}`} /></td>
                <td>
                  <button className="prospect-button" type="button" onClick={() => onOpen(lead.id)}>
                    <span className="prospect-identity">
                      <i aria-hidden="true">{initials}</i>
                      <span>
                        <b>{lead.name}</b>
                        <small>{lead.company}</small>
                        <em>{tag}</em>
                      </span>
                    </span>
                  </button>
                </td>
                <td>
                  <span className="contact-phone">{lead.phone}</span>
                  <small>{localTime(lead.timezone)} local</small>
                </td>
                <td>
                  <span className={lead.dnc ? "lead-status is-dnc" : "lead-status"}>
                    {!lead.dnc && <Plus size={13} aria-hidden="true" />}
                    {statusLabel}
                  </span>
                </td>
                <td><span className="next-step">{lead.dnc ? "—" : "Not yet"}</span></td>
                <td><span className="empty-cell">—</span></td>
                <td><span className="empty-cell">—</span></td>
                <td className="lead-row-actions">
                  <button
                    type="button"
                    className="convert-button"
                    onClick={() => onConvert(lead)}
                  >
                    <CircleDot size={16} aria-hidden="true" /> Convert
                  </button>
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

function FollowUps({
  leads,
  onSelect,
}: {
  leads: Lead[];
  onSelect: (id: string) => void;
}) {
  return (
    <section className="followups">
      {leads.map((lead) => (
        <button key={lead.id} onClick={() => onSelect(lead.id)}>
          <span className="followup-time">{lead.due}</span>
          <span>
            <b>{lead.name}</b>
            <small>
              {lead.company} · {lead.note}
            </small>
          </span>
          <ChevronRight size={18} />
        </button>
      ))}
    </section>
  );
}

function Pipeline({ opportunities, onUpdate }: { opportunities: Opportunity[]; onUpdate: (id: string, body: Partial<Pick<Opportunity, "stage" | "value">>) => void }) {
  const stages = ["Qualification", "Proposal", "Negotiation", "Closed Won", "Closed Lost"] as const;
  const total = opportunities.reduce((sum, item) => sum + item.value, 0);
  return <section className="pipeline-page">
    <header className="pipeline-header"><div><h2>Sales Pipeline</h2><p>Track converted leads through the next commercial decision.</p></div><div><strong>${total.toLocaleString()}</strong><small>{opportunities.length} opportunities</small></div></header>
    <div className="pipeline-board">{stages.map((stage) => { const items = opportunities.filter((item) => item.stage === stage); return <section className="pipeline-column" key={stage}><header><b>{stage}</b><span>{items.length} deals · ${items.reduce((sum, item) => sum + item.value, 0).toLocaleString()}</span></header>{items.length ? items.map((item) => <article className="opportunity-card" key={item.id}><b>{item.name}</b><small>{item.company} · {item.contact}</small><label>Value<input type="number" min="0" value={item.value} onChange={(event) => onUpdate(item.id, { value: Number(event.target.value) || 0 })} /></label><label>Stage<select value={item.stage} onChange={(event) => onUpdate(item.id, { stage: event.target.value as Opportunity["stage"] })}>{stages.map((option) => <option key={option}>{option}</option>)}</select></label></article>) : <p className="pipeline-empty">No opportunities</p>}</section>; })}</div>
  </section>;
}

function ImportLeads({ onClose, onSaved }: { onClose: () => void; onSaved: (message: string) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const file = new FormData(event.currentTarget).get("file");
    if (!(file instanceof File)) return setError("Choose a CSV file first.");
    setBusy(true); setError(null);
    try { const result = await api<{ imported: number; skipped: number }>("/api/leads/import", { method: "POST", body: JSON.stringify({ csv: await file.text() }) }); await onSaved(`${result.imported} leads imported${result.skipped ? `; ${result.skipped} duplicates skipped` : ""}.`); } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not import this CSV."); } finally { setBusy(false); }
  };
  return <div className="modal-backdrop"><form className="lead-form" onSubmit={submit} role="dialog" aria-modal="true" aria-labelledby="import-leads-title"><button type="button" className="close-button" onClick={onClose} aria-label="Close"><X /></button><h2 id="import-leads-title">Import leads</h2><p>Upload a CSV with <b>Name</b> and <b>Phone</b> columns. Company, Role, and Time zone are optional.</p>{error && <p className="form-error" role="alert">{error}</p>}<label>CSV file<input name="file" type="file" accept=".csv,text/csv" required /></label><button className="primary-button" disabled={busy}>{busy ? "Importing…" : <><FileUp size={17} /> Import leads</>}</button></form></div>;
}

function DncList({ onClose, onSaved }: { onClose: () => void; onSaved: (message: string) => Promise<void> }) {
  const [numbers, setNumbers] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => { event.preventDefault(); setBusy(true); setError(null); try { const result = await api<{ suppressed: number; matched: number }>("/api/dnc", { method: "POST", body: JSON.stringify({ numbers: numbers.split(/[\n,;]+/).map((item) => item.trim()).filter(Boolean) }) }); await onSaved(`${result.suppressed} numbers added to DNC; ${result.matched} existing leads suppressed.`); } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not update the DNC list."); } finally { setBusy(false); } };
  return <div className="modal-backdrop"><form className="lead-form" onSubmit={submit} role="dialog" aria-modal="true" aria-labelledby="dnc-list-title"><button type="button" className="close-button" onClick={onClose} aria-label="Close"><X /></button><h2 id="dnc-list-title">Do-not-call list</h2><p>Paste one phone number per line. Matching leads are immediately suppressed.</p>{error && <p className="form-error" role="alert">{error}</p>}<label>Phone numbers<textarea value={numbers} onChange={(event) => setNumbers(event.target.value)} placeholder={"+15551234567\n+15557654321"} required /></label><button className="primary-button" disabled={busy}>{busy ? "Saving…" : "Suppress numbers"}</button></form></div>;
}

function ConvertLead({ lead, onClose, onSaved }: { lead: Lead; onClose: () => void; onSaved: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); setBusy(true); setError(null); const form = new FormData(event.currentTarget); try { await api("/api/opportunities", { method: "POST", body: JSON.stringify({ leadId: lead.id, name: form.get("name"), value: form.get("value") }) }); await onSaved(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not convert this lead."); } finally { setBusy(false); } };
  return <div className="modal-backdrop"><form className="lead-form" onSubmit={submit} role="dialog" aria-modal="true" aria-labelledby="convert-title"><button type="button" className="close-button" onClick={onClose} aria-label="Close"><X /></button><h2 id="convert-title">Convert to opportunity</h2><p>{lead.name} at {lead.company} will move to Pipeline in Qualification.</p>{error && <p className="form-error" role="alert">{error}</p>}<label>Opportunity name<input name="name" defaultValue={`${lead.company} opportunity`} required /></label><label>Potential value<input name="value" type="number" min="0" defaultValue="0" required /></label><button className="primary-button" disabled={busy}>{busy ? "Converting…" : "Create opportunity"}</button></form></div>;
}

function CallOutcome({ lead, onClose, onSaved }: { lead: Lead; onClose: () => void; onSaved: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); setBusy(true); setError(null); const form = new FormData(event.currentTarget); try { await api("/api/calls/record", { method: "POST", body: JSON.stringify({ leadId: lead.id, outcome: form.get("outcome"), note: form.get("note"), followUpAt: form.get("followUpAt") }) }); await onSaved(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save this call outcome."); } finally { setBusy(false); } };
  return <div className="modal-backdrop"><form className="lead-form" onSubmit={submit} role="dialog" aria-modal="true" aria-labelledby="outcome-title"><button type="button" className="close-button" onClick={onClose} aria-label="Close"><X /></button><h2 id="outcome-title">Log call outcome</h2><p>Record the result for {lead.name}. This updates the lead and call history immediately.</p>{error && <p className="form-error" role="alert">{error}</p>}<label>Outcome<select name="outcome" defaultValue="Interested"><option>Interested</option><option>Meeting booked</option><option>Callback</option><option>Maybe later</option><option>No answer</option><option>Busy</option><option>Voicemail</option><option>Not interested</option><option>Wrong number</option><option>Do not call</option></select></label><label>Follow-up date and time <input name="followUpAt" type="datetime-local" /></label><label>Notes<textarea name="note" placeholder="What happened on this call?" /></label><button className="primary-button" disabled={busy}>{busy ? "Saving…" : "Save outcome"}</button></form></div>;
}

function ActivityLog({ activity }: { activity: State["activity"] }) {
  return (
    <section className="activity-log">
      {activity.map((event) => (
        <article key={event.id}>
          <span className="activity-mark">
            <ClipboardList size={18} />
          </span>
          <div>
            <h2>{event.action}</h2>
            <p>{event.detail}</p>
          </div>
          <time>{event.at}</time>
        </article>
      ))}
    </section>
  );
}

function QuickTour({
  step,
  onClose,
  onBack,
  onNext,
}: {
  step: number;
  onClose: () => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const steps = [
    {
      eyebrow: "YOUR WORKSPACE · 1 OF 3",
      title: "Your calling space is ready.",
      body: "Keep your leads, calling queue, and next actions in one calm workspace.",
      action: "Show my leads",
    },
    {
      eyebrow: "YOUR WORKSPACE · 2 OF 3",
      title: "Start with a clean list.",
      body: "Add leads one at a time today, then bring in a CSV when your import flow is ready.",
      action: "Next stop",
    },
    {
      eyebrow: "YOUR WORKSPACE · 3 OF 3",
      title: "Choose a lead, then call responsibly.",
      body: "Open a lead before calling. Connect a selected Twilio line in Settings before any outbound call can be prepared.",
      action: "Open calling queue",
    },
  ];
  const current = steps[step];
  return (
    <div className="tour-backdrop" role="presentation">
      <section className="tour-card" role="dialog" aria-modal="true" aria-labelledby="tour-title">
        <div className="tour-card__head">
          <span>{current.eyebrow}</span>
          <button type="button" onClick={onClose}>Skip tour</button>
        </div>
        <Sparkles size={22} aria-hidden="true" />
        <h2 id="tour-title">{current.title}</h2>
        <p>{current.body}</p>
        <div className="tour-card__actions">
          {step > 0 ? <button type="button" className="quiet-button" onClick={onBack}>Back</button> : <span />}
          <button type="button" className="primary-button" onClick={onNext}>{current.action} <ChevronRight size={16} /></button>
        </div>
        <button type="button" className="tour-explore" onClick={onClose}>I’ll explore on my own</button>
      </section>
    </div>
  );
}

function Settings({
  connection,
  onRefresh,
  onNotice,
}: {
  connection: Connection | null;
  onRefresh: () => Promise<void>;
  onNotice: (message: string) => void;
}) {
  const [accountSid, setAccountSid] = useState("");
  const [authToken, setAuthToken] = useState("");
  const [numbers, setNumbers] = useState<NumberOption[]>([]);
  const [selected, setSelected] = useState<NumberOption | null>(null);
  const [busy, setBusy] = useState(false);
  const [bridgeNumber, setBridgeNumber] = useState(connection?.bridgeNumber || "");
  const [area, setArea] = useState<SettingsArea>("calling");
  const [page, setPage] = useState<SettingsPage>("numbers");
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
      await api("/api/twilio/connection", { method: "PATCH", body: JSON.stringify({ bridgeNumber }) });
      await onRefresh();
      onNotice("Calling bridge saved. Calls will ring this number before connecting the lead.");
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
  const sections: Record<SettingsArea, { id: SettingsPage; label: string }[]> = {
    calling: [
      { id: "numbers", label: "Phone numbers" },
    ],
    workspace: [
      { id: "team", label: "Team" },
      { id: "fields", label: "Custom fields" },
    ],
    account: [
      { id: "profile", label: "Profile" },
      { id: "privacy", label: "Privacy" },
    ],
  };
  return (
    <section className="settings-page">
      <div className="settings-tabs" role="tablist" aria-label="Settings sections">
        {(["calling", "workspace", "account"] as SettingsArea[]).map((item) => (
          <button key={item} type="button" role="tab" aria-selected={area === item} className={area === item ? "is-active" : ""} onClick={() => selectPage(item, sections[item][0].id)}>
            {item}
          </button>
        ))}
      </div>
      <div className="settings-layout">
        <aside className="settings-nav" aria-label={`${area} settings`}>
          <span>{area} settings</span>
          {sections[area].map((item) => (
            <button key={item.id} type="button" className={page === item.id ? "is-active" : ""} onClick={() => setPage(item.id)}>{item.label}</button>
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
            Credentials travel directly to the Open Dialer server for validation.
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
                <dt>Operator bridge</dt>
                <dd>{connection.bridgeNumber || "Not configured"}</dd>
              </div>
            </dl>
            <form className="bridge-form" onSubmit={saveBridge}>
              <label>
                Phone to ring before each call
                <input value={bridgeNumber} onChange={(event) => setBridgeNumber(event.target.value)} placeholder="+15551234567" inputMode="tel" required />
              </label>
              <button className="primary-button" type="submit" disabled={busy}>Save calling bridge</button>
            </form>
            <button className="quiet-button" onClick={remove}>
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
          Open Dialer only lists numbers already owned by the connected Twilio
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
            <Check /> Set <code>CALLBOARD_ENCRYPTION_KEY</code> in Dokploy
          </span>
          <span>
            <Check /> Save the phone number that should ring before each outbound call
          </span>
          <span>
            <Check /> Add application authentication before inviting other
            operators
          </span>
        </div>
      </article>
          </section>
        ) : (
          <SettingsPanel page={page} connection={connection} onNotice={onNotice} />
        )}
        </div>
      </div>
    </section>
  );
}

function SettingsPanel({
  page,
  connection,
  onNotice,
}: {
  page: Exclude<SettingsPage, "numbers">;
  connection: Connection | null;
  onNotice: (message: string) => void;
}) {
  const [teamName, setTeamName] = useState(() => localStorage.getItem("callboard-team-name") || "");
  const [fieldName, setFieldName] = useState("");
  const [fields, setFields] = useState<string[]>(() => JSON.parse(localStorage.getItem("callboard-lead-fields") || "[]"));
  const [profile, setProfile] = useState(() => ({
    firstName: localStorage.getItem("callboard-first-name") || "",
    company: localStorage.getItem("callboard-company") || "",
    phone: localStorage.getItem("callboard-phone") || "",
  }));
  if (page === "team") {
    return <section className="settings-panel"><span className="panel-kicker">Workspace</span><h2>Team</h2><p>Name your workspace now. Member invitations and role management stay off until multi-user authentication is enabled.</p><form className="settings-form" onSubmit={(event) => { event.preventDefault(); localStorage.setItem("callboard-team-name", teamName); onNotice("Workspace name saved in this browser."); }}><label>Workspace name<input value={teamName} onChange={(event) => setTeamName(event.target.value)} placeholder="Your company or team" /></label><button className="primary-button" type="submit">Save workspace</button></form></section>;
  }
  if (page === "fields") {
    return <section className="settings-panel"><span className="panel-kicker">Workspace</span><h2>Custom fields</h2><p>Capture the fields your team actually needs on every lead.</p><form className="inline-form" onSubmit={(event) => { event.preventDefault(); const value = fieldName.trim(); if (!value || fields.includes(value)) return; const next = [...fields, value]; setFields(next); localStorage.setItem("callboard-lead-fields", JSON.stringify(next)); setFieldName(""); }}><input value={fieldName} onChange={(event) => setFieldName(event.target.value)} placeholder="e.g. Territory" /><button className="primary-button" type="submit">Add field</button></form><div className="field-pills">{fields.length ? fields.map((field) => <button key={field} type="button" onClick={() => { const next = fields.filter((item) => item !== field); setFields(next); localStorage.setItem("callboard-lead-fields", JSON.stringify(next)); }}>{field} <X size={13} /></button>) : <span>No custom fields yet.</span>}</div></section>;
  }
  if (page === "profile") {
    return <section className="settings-panel"><span className="panel-kicker">Account</span><h2>Profile</h2><p>Your personal and company details for this Open Dialer v2 workspace.</p><form className="settings-form" onSubmit={(event) => { event.preventDefault(); localStorage.setItem("callboard-first-name", profile.firstName); localStorage.setItem("callboard-company", profile.company); localStorage.setItem("callboard-phone", profile.phone); onNotice("Profile saved in this browser."); }}><label>First name<input value={profile.firstName} onChange={(event) => setProfile({ ...profile, firstName: event.target.value })} /></label><label>Business phone<input value={profile.phone} onChange={(event) => setProfile({ ...profile, phone: event.target.value })} /></label><label>Company<input value={profile.company} onChange={(event) => setProfile({ ...profile, company: event.target.value })} /></label><button className="primary-button" type="submit">Save profile</button></form></section>;
  }
  return <section className="settings-panel"><span className="panel-kicker">Account</span><h2>Privacy</h2><p>Telephony credentials are encrypted server-side. This browser stores only non-sensitive workspace preferences such as your profile and custom field names.</p><div className="settings-callout"><ShieldCheck size={20} /><span>Never enter Twilio credentials into a third-party integration field.</span></div></section>;
}

function LeadForm({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    try {
      await api("/api/leads", {
        method: "POST",
        body: JSON.stringify(Object.fromEntries(form)),
      });
      await onSaved();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not add this lead.",
      );
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="modal-backdrop">
      <form
        className="lead-form"
        onSubmit={submit}
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-lead-title"
      >
        <button
          type="button"
          className="close-button"
          onClick={onClose}
          aria-label="Close"
        >
          <X />
        </button>
        <h2 id="add-lead-title">Add a lead</h2>
        <p>This creates one contact in the local workspace.</p>
        <label>
          Name
          <input name="name" required />
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <label>
          Company
          <input name="company" />
        </label>
        <label>
          Role
          <input name="role" />
        </label>
        <label>
          Phone
          <input name="phone" type="tel" required placeholder="+1 555 0100" />
        </label>
        <label>
          Time zone
          <input name="timezone" placeholder="America/Los_Angeles" />
        </label>
        <button className="primary-button" disabled={saving}>
          {saving ? (
            "Saving…"
          ) : (
            <>
              <UserPlus size={17} /> Add to route
            </>
          )}
        </button>
      </form>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
