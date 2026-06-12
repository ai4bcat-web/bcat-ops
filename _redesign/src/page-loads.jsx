// Loads page — big sortable filterable table.

function PageLoads() {
  const [tab, setTab] = useState("All");
  const [search, setSearch] = useState("");
  const [openDrawer, setOpenDrawer] = useState(false);

  const tabs = [
    { id: "All", label: "All", count: 46 },
    { id: "Ready", label: "Ready to Invoice", count: 15, tone: "ok" },
    { id: "Unassigned", label: "Unassigned", count: 23, tone: "warn" },
    { id: "Split", label: "Split Loads", count: 2, tone: "violet" },
  ];

  const kpis = [
    { label: "Total Loads",       value: "46", color: "#1ea8f3" },
    { label: "Ready to Invoice",  value: "15", color: "#22c55e" },
    { label: "Unassigned",        value: "23", color: "#f59e0b" },
    { label: "Split Loads",       value: "2",  color: "#a78bfa" },
  ];

  const filtered = RAW_LOADS.filter(l => {
    if (tab === "Ready" && l.status !== "ready") return false;
    if (tab === "Unassigned" && l.status !== "unassigned") return false;
    if (search && !(String(l.pro).includes(search) || (l.tms || "").toLowerCase().includes(search.toLowerCase()))) return false;
    return true;
  });

  return (
    <div className="anim-in">
      <PageHeader
        title="Loads"
        sub="All freight movements · live status"
        right={
          <>
            <button className="btn"><Icons.download size={14}/> Export</button>
            <button className="btn primary" onClick={() => setOpenDrawer(true)}><Icons.plus size={14}/> Add Load</button>
          </>
        }
      />

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 18 }}>
        {kpis.map((k, i) => (
          <div key={i} className="card card-pad" style={{ position: "relative", overflow: "hidden" }}>
            <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 3, background: k.color }}/>
            <div className="eyebrow">{k.label}</div>
            <div style={{ fontSize: 28, fontWeight: 600, marginTop: 4, color: k.color, letterSpacing: "-0.02em" }} className="tnum">{k.value}</div>
          </div>
        ))}
      </div>

      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 14, flexWrap: "wrap" }}>
        <div className="tabs">
          {tabs.map(t => (
            <button key={t.id} className={tab === t.id ? "active" : ""} onClick={() => setTab(t.id)}>
              {t.label}
              <span className="mono" style={{ marginLeft: 6, fontSize: 11, color: "var(--t3)" }}>{t.count}</span>
            </button>
          ))}
        </div>
        <div style={{ position: "relative", flex: 1, maxWidth: 360 }}>
          <Icons.search size={14} style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", color: "var(--t3)" }}/>
          <input className="input" placeholder="Search all fields…" style={{ paddingLeft: 34 }} value={search} onChange={e => setSearch(e.target.value)}/>
        </div>
        <button className="btn"><Icons.filter size={13}/> Columns</button>
        <button className="btn"><Icons.calendar size={13}/> Group by day</button>
        <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--t3)" }} className="mono">{filtered.length} loads</span>
      </div>

      <Card pad={false}>
        <div style={{ maxHeight: "calc(100vh - 380px)", overflowY: "auto" }}>
          <table className="tbl zebra">
            <thead>
              <tr>
                <th style={{ width: 32 }}><input type="checkbox" style={{ accentColor: "var(--blue)" }}/></th>
                <th>Pro #</th>
                <th>TMS / PO</th>
                <th>PU #</th>
                <th>Origin → Destination</th>
                <th>PU Appt</th>
                <th>DE Appt</th>
                <th>Driver</th>
                <th style={{ textAlign: "right" }}>Rate</th>
                <th>Status</th>
                <th>RTI</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((l, i) => {
                const drv = driverById(l.driver);
                return (
                  <tr key={i}>
                    <td><input type="checkbox" style={{ accentColor: "var(--blue)" }}/></td>
                    <td className="mono" style={{ color: "var(--t1)", fontWeight: 500 }}>{l.pro}</td>
                    <td className="mono" style={{ color: "var(--t3)", fontSize: 12, maxWidth: 130, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.tms}</td>
                    <td className="mono" style={{ color: "var(--t3)", fontSize: 12, maxWidth: 110, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.pu}</td>
                    <td>
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <span style={{ fontSize: 12.5 }}>{l.origin}</span>
                        <Icons.arrowR size={11} stroke="var(--t3)"/>
                        <span style={{ fontSize: 12.5 }}>{l.dest}</span>
                      </div>
                    </td>
                    <td className="mono" style={{ fontSize: 12, color: "var(--t2)" }}>{l.puAppt}</td>
                    <td className="mono" style={{ fontSize: 12, color: l.deAppt === "TBD" ? "var(--warn)" : "var(--t2)" }}>{l.deAppt}</td>
                    <td>
                      {drv ? (
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <Avatar id={drv.id} color={drv.color} size="sm"/>
                          <span style={{ fontSize: 12.5, color: drv.broker ? "var(--t2)" : "var(--t1)" }}>{drv.name}</span>
                        </div>
                      ) : (
                        <Pill tone="warn">Unassigned</Pill>
                      )}
                    </td>
                    <td className="mono" style={{ textAlign: "right", fontWeight: 500 }}>{l.rate ? "$" + l.rate : "—"}</td>
                    <td><LoadStatusPill status={l.status}/></td>
                    <td>
                      {l.rti ? (
                        <Icons.check size={14} stroke="#16a34a" sw={2.5}/>
                      ) : (
                        <span style={{ display: "inline-block", width: 14, height: 14, borderRadius: "50%", border: "1.5px solid var(--line-strong)" }}/>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <Drawer open={openDrawer} onClose={() => setOpenDrawer(false)} title="New Load">
        <NewLoadForm onClose={() => setOpenDrawer(false)}/>
      </Drawer>
    </div>
  );
}

function NewLoadForm({ onClose }) {
  return (
    <div style={{ padding: 22, display: "flex", flexDirection: "column", gap: 18 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        <Field label="PRO #" placeholder="A-2847391"/>
        <Field label="TMS ID / PO" placeholder="TMS-44201"/>
      </div>
      <Field label="Pickup Number" placeholder="PU-8812"/>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        <Field label="Origin Name" placeholder="Shipper / Facility"/>
        <Field label="Origin City" placeholder="Chicago, IL"/>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        <Field label="Destination Name" placeholder="Consignee / Facility"/>
        <Field label="Destination City" placeholder="Indianapolis, IN"/>
      </div>

      <FieldGroup label="Pickup">
        <div className="tabs" style={{ marginBottom: 8 }}>
          <button className="active">Exact</button>
          <button>Range</button>
          <button>FCFS</button>
        </div>
        <input className="input" type="datetime-local"/>
      </FieldGroup>

      <FieldGroup label="Delivery">
        <div className="tabs" style={{ marginBottom: 8 }}>
          <button className="active">Exact</button>
          <button>Range</button>
          <button>FCFS</button>
        </div>
        <input className="input" type="datetime-local"/>
      </FieldGroup>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        <FieldGroup label="PU Driver">
          <select className="input">
            <option>Unassigned</option>
            {DRIVERS.map(d => <option key={d.id}>{d.name}</option>)}
          </select>
        </FieldGroup>
        <FieldGroup label="DE Driver">
          <select className="input">
            <option>Unassigned</option>
            {DRIVERS.map(d => <option key={d.id}>{d.name}</option>)}
          </select>
        </FieldGroup>
      </div>

      <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
        <input type="checkbox" style={{ accentColor: "var(--blue)" }}/>
        <span>Mark as Ready to Invoice</span>
      </label>

      <div style={{ marginTop: "auto", paddingTop: 20, borderTop: "1px solid var(--line)", display: "flex", justifyContent: "flex-end", gap: 10 }}>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary"><Icons.plus size={14}/> Create Load</button>
      </div>
    </div>
  );
}

function Field({ label, placeholder, value }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: "var(--t3)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6 }}>{label}</div>
      <input className="input" placeholder={placeholder} defaultValue={value}/>
    </div>
  );
}

function FieldGroup({ label, children }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: "var(--t3)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6 }}>{label}</div>
      {children}
    </div>
  );
}

window.PageLoads = PageLoads;
window.Field = Field;
window.FieldGroup = FieldGroup;
