import { FormEvent, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  BadgeCheck,
  CalendarClock,
  Check,
  ChevronRight,
  CircleAlert,
  ClipboardList,
  FileUp,
  Filter,
  LoaderCircle,
  LockKeyhole,
  Phone,
  PhoneCall,
  Plus,
  Search,
  ShieldCheck,
  SlidersHorizontal,
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
type Screen = "queue" | "leads" | "followups" | "activity" | "settings";

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
  { id: "calls", key: "queue", label: "Calls", icon: Phone },
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

function Login({ onSignedIn }: { onSignedIn: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/api/session", {
        method: "POST",
        body: JSON.stringify({ password }),
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
            <ChevronRight size={18} />
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
        <header className="topbar">
          <div>
            <p className="date-line">Workspace</p>
            <h1>
              {screen === "queue"
                ? "Today’s route"
                : screen === "settings"
                  ? "Settings"
                  : nav.find((item) => item.key === screen)?.label}
            </h1>
          </div>
          <div className="top-actions">
            <button
              className="icon-button"
              aria-label="Import leads"
              onClick={() =>
                setNotice(
                  "CSV import mapping is the next implementation slice. Add a lead manually for this build.",
                )
              }
            >
              <FileUp size={18} />
            </button>
            <button
              className="primary-button"
              onClick={() => setShowLeadForm(true)}
            >
              <Plus size={18} /> Add lead
            </button>
          </div>
        </header>
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
    </main>
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
      <header className="lead-workspace__intro">
        <div>
          <p>Everyone you’re calling, with the next action easy to spot.</p>
        </div>
        <span className="lead-workspace__count">{leads.length} active records</span>
      </header>

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
          <button className="toolbar-button" type="button" onClick={() => onNotice("CSV import mapping is the next implementation slice. Add a lead manually for this build.")}>
            <FileUp size={16} /> Import CSV
          </button>
        </div>
      </div>

      <div className="lead-table-wrap">
        <table className="lead-list-table">
          <thead>
            <tr>
              <th scope="col"><span className="sr-only">Select</span></th>
              <th scope="col">Prospect</th>
              <th scope="col">Contact</th>
              <th scope="col">Status</th>
              <th scope="col">Next step</th>
              <th scope="col"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {visibleLeads.map((lead) => (
              <tr className={lead.id === selectedId ? "is-current" : undefined} key={lead.id}>
                <td><input type="checkbox" aria-label={`Select ${lead.name}`} /></td>
                <td>
                  <button className="prospect-button" type="button" onClick={() => onOpen(lead.id)}>
                    <b>{lead.name}</b>
                    <small>{lead.company}</small>
                  </button>
                </td>
                <td>
                  <span className="contact-phone">{lead.phone}</span>
                  <small>{lead.timezone.replace("America/", "")}</small>
                </td>
                <td><Status tone={lead.dnc ? "alert" : lead.status === "Follow-up" ? "good" : "quiet"}>{lead.dnc ? "DNC" : lead.status}</Status></td>
                <td><span className="next-step">{lead.dnc ? "Suppressed" : lead.due}</span></td>
                <td className="lead-row-actions">
                  <button type="button" onClick={() => onOpen(lead.id)}>Open</button>
                  <button
                    type="button"
                    className={lead.dnc ? "is-alert" : undefined}
                    onClick={() => onDnc(lead, !lead.dnc)}
                  >
                    {lead.dnc ? "Allow" : "DNC"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!visibleLeads.length && (
          <div className="lead-list-empty">
            <Search size={19} /> No leads match this view.
          </div>
        )}
        </div>
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
  return (
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
  );
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
