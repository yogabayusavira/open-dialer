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
  Database,
  FileUp,
  Filter,
  LoaderCircle,
  LockKeyhole,
  MoreHorizontal,
  Phone,
  PhoneIncoming,
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
};
type State = {
  leads: Lead[];
  activity: { id: string; at: string; action: string; detail: string }[];
  connection: Connection | null;
};
type NumberOption = { sid: string; number: string; label: string };
type Session = { requiresAuth: boolean; authenticated: boolean };
type Screen = "queue" | "calls" | "leads" | "followups" | "activity" | "settings";
type SettingsArea = "calling" | "workspace" | "integrations" | "account";
type SettingsPage =
  | "numbers"
  | "outcomes"
  | "voicemail"
  | "team"
  | "fields"
  | "research"
  | "crm"
  | "profile"
  | "billing"
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
  { id: "pipeline", key: "activity", label: "Pipeline", icon: SlidersHorizontal },
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
          <span>callboard</span>
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
  const [tourStep, setTourStep] = useState<number | null>(null);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const next = await api<State>("/api/state");
      if (!Array.isArray(next.leads) || !Array.isArray(next.activity)) {
        throw new Error("The Callboard API is unavailable. Check that the service is running with node server.mjs.");
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
      await api("/api/calls/prepare", {
        method: "POST",
        body: JSON.stringify({ leadId: lead.id }),
      });
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
        <LoaderCircle className="spin" size={28} /> Loading Callboard…
      </main>
    );
  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">C</span>
          <span>callboard</span>
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
          <button className="nav-item" type="button" onClick={() => setNotice("Additional workspace tools are coming in a later release.")}>
            <MoreHorizontal size={18} />
            <span>More</span>
          </button>
        </nav>
        <div className="sidebar-footer">
          <button className="nav-item sidebar-utility" type="button" onClick={() => setNotice("The dark workspace theme is active.")}>
            <ShieldCheck size={18} />
            <span>Light mode</span>
          </button>
          <button className="nav-item sidebar-utility" type="button" onClick={() => setScreen("settings")}>
            <SlidersHorizontal size={18} />
            <span>Settings</span>
          </button>
          <button className="account-summary" type="button" onClick={() => setScreen("settings")}>
            <span className="account-summary__avatar">C</span>
            <span>
              <b>Callboard workspace</b>
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
            onDnc={setDnc}
            onSettings={() => setScreen("settings")}
          />
        )}
        {screen === "calls" && (
          <CallHistory
            onStartDialing={() => setScreen("leads")}
            onOpenDialer={() =>
              setNotice("Manual dialing needs a configured Voice bridge before it can be used.")
            }
            onOpenPhoneNumbers={() => setScreen("settings")}
            onUpgrade={() => setNotice("Billing and plan management has not been implemented yet.")}
          />
        )}
        {screen === "leads" && (
          <LeadList
            leads={state.leads}
            selectedId={selected?.id || null}
            onSelect={setSelectedId}
            onDnc={setDnc}
            onOpen={(id) => {
              setSelectedId(id);
              setScreen("queue");
            }}
            onNotice={setNotice}
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
  onStartDialing,
  onOpenDialer,
  onOpenPhoneNumbers,
  onUpgrade,
}: {
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
  const subtitle =
    view === "conversations"
      ? "0 calls where someone actually talked"
      : view === "attempts"
        ? "0 dial attempts"
        : "Leads who called back the number you dialed them from";

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
          <button className="calls-export-button" disabled>
            Export
          </button>
        </div>
      </header>

      <div className="calls-limit" aria-label="Monthly calling limit">
        <strong>0 / 500 calls this month</strong>
        <span>500 left on the free plan — resets on the 1st.</span>
        <button type="button" onClick={onUpgrade}>
          Upgrade for unlimited →
        </button>
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

      <div className="calls-empty">
        {isCallbacks ? (
          <>
            <p>Callbacks are off. Turn them on and every lead who calls back the number you dialed them from shows up here.</p>
            <button type="button" onClick={onOpenPhoneNumbers}>Turn on callbacks in Phone numbers →</button>
          </>
        ) : (
          <>
            <p>{view === "conversations" ? "No conversations in this range." : "No calls in this range."}</p>
            <span>
              {view === "conversations"
                ? "Calls appear here once someone picks up. "
                : "The CSV export includes timestamps, outcomes, notes, and transcripts. "}
              <button type="button" onClick={onStartDialing}>Start dialing →</button>
            </span>
          </>
        )}
      </div>
    </section>
  );
}

function Queue({
  state,
  selected,
  onSelect,
  onPrepare,
  onDnc,
  onSettings,
}: {
  state: State;
  selected: Lead;
  onSelect: (id: string) => void;
  onPrepare: (lead: Lead) => void;
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
              <Phone size={19} /> Prepare call
            </button>
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
            Calls remain disabled until the production Voice bridge is
            configured.
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
            No recording or automated dialing in this release.
          </div>
        </aside>
      </section>
    </div>
  );
}

function LeadList({
  leads,
  selectedId,
  onSelect,
  onDnc,
  onOpen,
  onNotice,
}: {
  leads: Lead[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onDnc: (lead: Lead, value: boolean) => void;
  onOpen: (id: string) => void;
  onNotice: (message: string) => void;
}) {
  const [query, setQuery] = useState("");
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
  const visibleLeads = (segment === "all" ? leads : groups[segment]).filter((lead) =>
    [lead.name, lead.company, lead.phone, lead.status].join(" ").toLowerCase().includes(query.trim().toLowerCase()),
  );

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
          <button className="toolbar-button" type="button" onClick={() => onNotice("Saved filters are the next implementation slice.")}>
            <Filter size={16} /> Filters
          </button>
          <button className="toolbar-button toolbar-button--select" type="button" onClick={() => onNotice("Sorting controls are coming in a later release.")}>
            Newest first <ChevronRight size={15} />
          </button>
          <button className="toolbar-button" type="button" onClick={() => onNotice("CSV import mapping is the next implementation slice. Add a lead manually for this build.")}>
            <FileUp size={16} /> Import CSV
          </button>
          <button className="toolbar-button" type="button" onClick={() => onNotice("DNC list upload is not configured in this release.")}>
            DNC list
          </button>
        </div>
      </div>

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
                    onClick={() => onNotice("Opportunity conversion will be added with the Pipeline workspace.")}
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
  const selectPage = (nextArea: SettingsArea, nextPage: SettingsPage) => {
    setArea(nextArea);
    setPage(nextPage);
  };
  const sections: Record<SettingsArea, { id: SettingsPage; label: string }[]> = {
    calling: [
      { id: "numbers", label: "Phone numbers" },
      { id: "outcomes", label: "Call outcomes" },
      { id: "voicemail", label: "Voicemail drop" },
    ],
    workspace: [
      { id: "team", label: "Team" },
      { id: "fields", label: "Custom fields" },
      { id: "research", label: "AI research" },
    ],
    integrations: [{ id: "crm", label: "CRM integrations" }],
    account: [
      { id: "profile", label: "Profile" },
      { id: "billing", label: "Billing & plan" },
      { id: "privacy", label: "Privacy" },
    ],
  };
  return (
    <section className="settings-page">
      <div className="settings-tabs" role="tablist" aria-label="Settings sections">
        {(["calling", "workspace", "integrations", "account"] as SettingsArea[]).map((item) => (
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
            Credentials travel directly to the Callboard server for validation.
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
            </dl>
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
          Callboard only lists numbers already owned by the connected Twilio
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
            <Check /> Mount persistent storage for <code>/app/data</code>
          </span>
          <span>
            <Check /> Configure Twilio Voice webhooks before enabling outbound
            calls
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
  const [outcomes, setOutcomes] = useState([
    "Interested", "Meeting booked", "Callback", "Maybe later", "No answer", "Busy", "Voicemail", "Not interested", "Wrong number", "Do not call",
  ]);
  const [teamName, setTeamName] = useState(() => localStorage.getItem("callboard-team-name") || "");
  const [fieldName, setFieldName] = useState("");
  const [fields, setFields] = useState<string[]>(() => JSON.parse(localStorage.getItem("callboard-lead-fields") || "[]"));
  const [researchEnabled, setResearchEnabled] = useState(localStorage.getItem("callboard-research") === "true");
  const [profile, setProfile] = useState(() => ({
    firstName: localStorage.getItem("callboard-first-name") || "",
    company: localStorage.getItem("callboard-company") || "",
    phone: localStorage.getItem("callboard-phone") || "",
  }));
  if (page === "outcomes") {
    return <section className="settings-panel"><span className="panel-kicker">Calling</span><h2>Call outcomes</h2><p>Choose which outcomes appear after a call. These preferences only shape the workspace; they do not place or automate calls.</p><div className="outcome-list">{outcomes.map((outcome) => <label key={outcome}><input type="checkbox" checked onChange={() => setOutcomes((current) => current.filter((item) => item !== outcome))} />{outcome}</label>)}</div><button className="quiet-button" onClick={() => setOutcomes(["Interested", "Meeting booked", "Callback", "Maybe later", "No answer", "Busy", "Voicemail", "Not interested", "Wrong number", "Do not call"])}>Restore defaults</button></section>;
  }
  if (page === "voicemail") {
    return <section className="settings-panel"><span className="panel-kicker">Calling</span><h2>Voicemail drop</h2><p>There is no recording configured. Add a compliant audio upload flow and Twilio Voice webhook before enabling voicemail drop.</p><div className="settings-callout"><PhoneIncoming size={20} /><span>This area is intentionally disabled until the calling bridge is production-ready.</span></div></section>;
  }
  if (page === "team") {
    return <section className="settings-panel"><span className="panel-kicker">Workspace</span><h2>Team</h2><p>Name your workspace now. Member invitations and role management stay off until multi-user authentication is enabled.</p><form className="settings-form" onSubmit={(event) => { event.preventDefault(); localStorage.setItem("callboard-team-name", teamName); onNotice("Workspace name saved in this browser."); }}><label>Workspace name<input value={teamName} onChange={(event) => setTeamName(event.target.value)} placeholder="Your company or team" /></label><button className="primary-button" type="submit">Save workspace</button></form></section>;
  }
  if (page === "fields") {
    return <section className="settings-panel"><span className="panel-kicker">Workspace</span><h2>Custom fields</h2><p>Capture the fields your team actually needs on every lead.</p><form className="inline-form" onSubmit={(event) => { event.preventDefault(); const value = fieldName.trim(); if (!value || fields.includes(value)) return; const next = [...fields, value]; setFields(next); localStorage.setItem("callboard-lead-fields", JSON.stringify(next)); setFieldName(""); }}><input value={fieldName} onChange={(event) => setFieldName(event.target.value)} placeholder="e.g. Territory" /><button className="primary-button" type="submit">Add field</button></form><div className="field-pills">{fields.length ? fields.map((field) => <button key={field} type="button" onClick={() => { const next = fields.filter((item) => item !== field); setFields(next); localStorage.setItem("callboard-lead-fields", JSON.stringify(next)); }}>{field} <X size={13} /></button>) : <span>No custom fields yet.</span>}</div></section>;
  }
  if (page === "research") {
    return <section className="settings-panel"><span className="panel-kicker">Workspace</span><h2>AI research</h2><p>Keep enrichment off until you connect a provider and decide which lead data may leave Callboard.</p><label className="toggle-row"><span><b>Research workspace</b><small>Store this preference locally; no enrichment runs from this setting.</small></span><input type="checkbox" checked={researchEnabled} onChange={(event) => { setResearchEnabled(event.target.checked); localStorage.setItem("callboard-research", String(event.target.checked)); }} /></label></section>;
  }
  if (page === "crm") {
    return <section className="settings-panel"><span className="panel-kicker">Integrations</span><h2>CRM integrations</h2><p>Keep your CRM current after calls without copying notes by hand.</p><div className="integration-card"><Database size={22} /><div><b>CRM sync</b><small>Not connected. The first integration should use an explicit OAuth connection and a one-way activity sync.</small></div><Status tone="quiet">Not connected</Status></div></section>;
  }
  if (page === "profile") {
    return <section className="settings-panel"><span className="panel-kicker">Account</span><h2>Profile</h2><p>Your personal and company details for this Callboard workspace.</p><form className="settings-form" onSubmit={(event) => { event.preventDefault(); localStorage.setItem("callboard-first-name", profile.firstName); localStorage.setItem("callboard-company", profile.company); localStorage.setItem("callboard-phone", profile.phone); onNotice("Profile saved in this browser."); }}><label>First name<input value={profile.firstName} onChange={(event) => setProfile({ ...profile, firstName: event.target.value })} /></label><label>Business phone<input value={profile.phone} onChange={(event) => setProfile({ ...profile, phone: event.target.value })} /></label><label>Company<input value={profile.company} onChange={(event) => setProfile({ ...profile, company: event.target.value })} /></label><button className="primary-button" type="submit">Save profile</button></form></section>;
  }
  if (page === "billing") {
    return <section className="settings-panel"><span className="panel-kicker">Account</span><h2>Billing &amp; plan</h2><p>Callboard does not process payments. Your carrier usage is billed by Twilio; deployment and database costs are managed in Dokploy.</p><div className="settings-callout"><ShieldCheck size={20} /><span>{connection ? "A Twilio line is connected. Review carrier usage in your Twilio account." : "No Twilio line is connected yet."}</span></div></section>;
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
