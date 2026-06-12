// App shell — sidebar nav, topbar, page router.

const NAV = [
  { id: "dashboard",   label: "Dashboard",   icon: Icons.dashboard,   page: PageDashboard },
  { id: "calendar",    label: "Calendar",    icon: Icons.calendar,    page: PageCalendar },
  { id: "loads",       label: "Loads",       icon: Icons.loads,       page: PageLoads,        badge: 46 },
  { id: "intake",      label: "Intake",      icon: Icons.intake,      page: PageIntake,       badge: 4, badgeTone: "blue" },
  { id: "tasks",       label: "Tasks",       icon: Icons.tasks,       page: PageTasks,        badge: 4, badgeTone: "warn" },
  { id: "divider1" },
  { id: "drivers",     label: "Drivers",     icon: Icons.drivers,     page: PageDrivers },
  { id: "fleet",       label: "Fleet",       icon: Icons.fleet,       page: PageFleet },
  { id: "maintenance", label: "Maintenance", icon: Icons.maintenance, page: PageMaintenance,  badge: 20, badgeTone: "bad" },
  { id: "expenses",    label: "Expenses",    icon: Icons.expenses,    page: PageExpenses },
  { id: "schedules",   label: "Schedules",   icon: Icons.schedules,   page: PageSchedules },
  { id: "divider2" },
  { id: "audit",       label: "Audit Log",   icon: Icons.audit,       page: PageAudit },
  { id: "users",       label: "Users",       icon: Icons.users,       page: PageUsers },
];

function App() {
  const [signedIn, setSignedIn] = useState(() => window.location.hash !== "#login");
  const [current, setCurrent] = useState(() => {
    const hash = window.location.hash.slice(1);
    return NAV.find(n => n.id === hash) ? hash : "dashboard";
  });

  useEffect(() => {
    const onHash = () => {
      const h = window.location.hash.slice(1);
      if (h === "login") { setSignedIn(false); return; }
      if (NAV.find(n => n.id === h)) { setCurrent(h); setSignedIn(true); }
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const go = (id) => {
    setCurrent(id);
    window.location.hash = id;
  };

  if (!signedIn) {
    return <PageLogin onLogin={() => { setSignedIn(true); window.location.hash = "dashboard"; }}/>;
  }

  const Page = NAV.find(n => n.id === current)?.page || PageDashboard;

  return (
    <div className="app">
      <Sidebar current={current} onNav={go} onSignOut={() => { setSignedIn(false); window.location.hash = "login"; }}/>
      <div className="main">
        <Topbar current={current} onNav={go}/>
        <div className="page" key={current} data-screen-label={current}>
          <Page/>
        </div>
      </div>
    </div>
  );
}

function Sidebar({ current, onNav, onSignOut }) {
  return (
    <aside className="sidebar">
      {/* Logo */}
      <div style={{ padding: "20px 20px 18px", display: "flex", alignItems: "center", gap: 11, borderBottom: "1px solid var(--line)" }}>
        <div style={{
          width: 32, height: 32, borderRadius: 9, background: "linear-gradient(135deg, #1ea8f3 0%, #0b8fd9 100%)",
          display: "flex", alignItems: "center", justifyContent: "center",
          boxShadow: "0 0 0 1px rgba(30,168,243,0.3), 0 8px 24px -8px rgba(30,168,243,0.6)",
          position: "relative", overflow: "hidden",
        }}>
          {/* Stylized BCAT mark — bold B with road sweep */}
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
            <path d="M5 4h7a4 4 0 0 1 0 8H5z M5 12h8a4 4 0 0 1 0 8H5z" fill="white"/>
            <path d="M16 4 Q21 8 21 14 T17 22" stroke="rgba(255,255,255,0.6)" strokeWidth="1.5" fill="none" strokeDasharray="2 2"/>
          </svg>
        </div>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, letterSpacing: "-0.01em" }}>
            BCAT <span style={{ color: "var(--blue)" }}>OPS</span>
          </div>
          <div style={{ fontSize: 10, color: "var(--t3)", letterSpacing: "0.06em", textTransform: "uppercase", marginTop: 1 }}>Command Center</div>
        </div>
      </div>

      {/* Quick add */}
      <div style={{ padding: "14px 14px 10px" }}>
        <button className="btn primary" style={{ width: "100%", justifyContent: "center" }} onClick={() => onNav("loads")}>
          <Icons.plus size={14}/> Quick Add
        </button>
      </div>

      {/* Nav */}
      <nav style={{ flex: 1, overflowY: "auto", padding: "6px 10px 16px" }}>
        {NAV.map((n, i) => {
          if (n.id.startsWith("divider")) {
            return <div key={i} style={{ height: 1, background: "var(--line)", margin: "10px 6px" }}/>;
          }
          const active = current === n.id;
          const Icon = n.icon;
          return (
            <button key={n.id} onClick={() => onNav(n.id)} style={{
              display: "flex", alignItems: "center", gap: 11, width: "100%",
              padding: "8px 12px", borderRadius: 8, marginBottom: 2,
              background: active ? "var(--blue-bg)" : "transparent",
              color: active ? "var(--blue-dark)" : "var(--t2)",
              border: "none", fontFamily: "inherit", fontSize: 13, fontWeight: active ? 600 : 500,
              cursor: "pointer", textAlign: "left", transition: "all 0.15s",
              position: "relative",
            }}
            onMouseEnter={e => { if (!active) e.currentTarget.style.background = "var(--bg-2)"; }}
            onMouseLeave={e => { if (!active) e.currentTarget.style.background = "transparent"; }}>
              {active && <span style={{ position: "absolute", left: -10, top: "50%", transform: "translateY(-50%)", width: 3, height: 22, background: "var(--blue)", borderRadius: "0 2px 2px 0" }}/>}
              <Icon size={16}/>
              <span style={{ flex: 1 }}>{n.label}</span>
              {n.badge && (
                <span className="mono" style={{
                  fontSize: 10, padding: "2px 6px", borderRadius: 5,
                  background: n.badgeTone === "blue" ? "var(--blue-soft)" :
                              n.badgeTone === "warn" ? "var(--warn-soft)" :
                              n.badgeTone === "bad" ? "var(--bad-soft)" : "rgba(15,23,42,0.06)",
                  color: n.badgeTone === "blue" ? "#0369a1" :
                         n.badgeTone === "warn" ? "#b45309" :
                         n.badgeTone === "bad" ? "#dc2626" : "var(--t3)",
                }}>{n.badge}</span>
              )}
            </button>
          );
        })}
      </nav>

      {/* User footer */}
      <div style={{ padding: "14px 16px", borderTop: "1px solid var(--line)", display: "flex", alignItems: "center", gap: 10 }}>
        <Avatar id="RB" color="#1ea8f3" pulse/>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12.5, fontWeight: 500 }}>Ryne Bandolik</div>
          <div style={{ fontSize: 11, color: "var(--t3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>ryne@bcatcorp.com</div>
        </div>
        <button className="btn ghost icon" data-tip="Sign out" onClick={onSignOut}><Icons.ext size={14}/></button>
      </div>
    </aside>
  );
}

function Topbar({ current, onNav }) {
  const [search, setSearch] = useState("");
  const navItem = NAV.find(n => n.id === current);

  return (
    <header className="topbar">
      {/* Breadcrumb */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--t3)" }}>
        <span>BCAT Ops</span>
        <Icons.chevR size={13}/>
        <span style={{ color: "var(--t1)", fontWeight: 500 }}>{navItem?.label}</span>
      </div>

      {/* Global search */}
      <div style={{ flex: 1, maxWidth: 480, marginLeft: 32, position: "relative" }}>
        <Icons.search size={14} style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", color: "var(--t3)" }}/>
        <input
          className="input"
          style={{ paddingLeft: 34, paddingRight: 60 }}
          placeholder="Search loads, drivers, equipment…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <span className="mono" style={{
          position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)",
          fontSize: 10, color: "var(--t3)", padding: "2px 6px",
          background: "var(--bg-1)", border: "1px solid var(--line)", borderRadius: 4,
        }}>⌘K</span>
      </div>

      {/* Right actions */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginLeft: "auto" }}>
        {/* Live indicator */}
        <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "5px 10px", borderRadius: 7, background: "var(--bg-2)", border: "1px solid var(--line)" }}>
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#22c55e", boxShadow: "0 0 8px #22c55e", animation: "pulse 2s infinite" }}/>
          <span style={{ fontSize: 11.5, color: "var(--t2)" }}>Live</span>
          <span className="mono" style={{ fontSize: 11, color: "var(--t3)" }}>· 12s</span>
        </div>
        <button className="btn ghost icon" data-tip="Notifications" style={{ position: "relative" }}>
          <Icons.bell size={15}/>
          <span style={{ position: "absolute", top: 5, right: 5, width: 7, height: 7, background: "var(--blue)", borderRadius: "50%", boxShadow: "0 0 0 2px var(--bg-0)" }}/>
        </button>
        <button className="btn ghost icon" data-tip="Settings"><Icons.settings size={15}/></button>
      </div>
    </header>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App/>);
