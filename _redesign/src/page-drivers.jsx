// Drivers page — drivers & brokers list with edit drawer.

function PageDrivers() {
  const [tab, setTab] = useState("All");
  const [editing, setEditing] = useState(null);
  const [search, setSearch] = useState("");

  const filtered = DRIVERS.filter(d => {
    if (tab === "Company" && d.broker) return false;
    if (tab === "Brokers" && !d.broker) return false;
    if (search && !d.name.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const kpis = [
    { label: "Total", value: 11, color: "#1ea8f3" },
    { label: "Active Drivers", value: 9, color: "#22c55e" },
    { label: "Brokers / 3PL", value: 2, color: "#a78bfa" },
    { label: "Inactive", value: 0, color: "#f59e0b" },
  ];

  return (
    <div className="anim-in">
      <PageHeader
        title="Drivers & Brokers"
        sub="Roster · compliance · contact"
        right={
          <>
            <button className="btn"><Icons.download size={14}/> Export</button>
            <button className="btn primary" onClick={() => setEditing({ id: "new", name: "", color: "#1ea8f3" })}><Icons.plus size={14}/> Add Driver</button>
          </>
        }
      />

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 18 }}>
        {kpis.map((k, i) => (
          <div key={i} className="card card-pad">
            <div className="eyebrow">{k.label}</div>
            <div style={{ fontSize: 28, fontWeight: 600, marginTop: 4, color: k.color, letterSpacing: "-0.02em" }} className="tnum">{k.value}</div>
          </div>
        ))}
      </div>

      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 14 }}>
        <div className="tabs">
          {["All", "Company", "Brokers"].map(t => (
            <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>{t}</button>
          ))}
        </div>
        <div style={{ position: "relative", flex: 1, maxWidth: 360 }}>
          <Icons.search size={14} style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", color: "var(--t3)" }}/>
          <input className="input" placeholder="Search name, phone, notes…" style={{ paddingLeft: 34 }} value={search} onChange={e => setSearch(e.target.value)}/>
        </div>
      </div>

      <Card pad={false}>
        <table className="tbl zebra">
          <thead>
            <tr>
              <th>Name</th>
              <th>Phone</th>
              <th>Type</th>
              <th>Truck</th>
              <th>Status</th>
              <th>CDL Exp</th>
              <th>Med Card Exp</th>
              <th>Drug Test</th>
              <th>Hire Date</th>
              <th>Notes</th>
              <th style={{ width: 80 }}></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((d, i) => (
              <tr key={i}>
                <td>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <Avatar id={d.id} color={d.color} size="sm" pulse={d.loads > 0}/>
                    <span style={{ fontWeight: 500 }}>{d.name}</span>
                  </div>
                </td>
                <td className="mono" style={{ color: "var(--t2)" }}>{d.phone}</td>
                <td>
                  <Pill tone={d.broker ? "violet" : "blue"}>{d.broker ? <><Icons.box size={11}/> {d.type}</> : <><Icons.truck size={11}/> {d.type}</>}</Pill>
                </td>
                <td style={{ color: "var(--t3)", fontSize: 12.5 }}>Unassigned</td>
                <td><Pill tone="ok" dot>Active</Pill></td>
                <td className="mono" style={{ color: "var(--t4)" }}>—</td>
                <td className="mono" style={{ color: "var(--t4)" }}>—</td>
                <td className="mono" style={{ color: "var(--t4)" }}>—</td>
                <td className="mono" style={{ color: "var(--t4)" }}>—</td>
                <td style={{ fontSize: 12, color: "var(--t3)" }}>{d.notes || "—"}</td>
                <td style={{ textAlign: "right" }}>
                  <button className="btn ghost icon" onClick={() => setEditing(d)}><Icons.edit size={13}/></button>
                  <button className="btn ghost icon"><Icons.eye size={13}/></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Drawer open={!!editing} onClose={() => setEditing(null)} title={editing?.id === "new" ? "New Driver" : "Edit Driver"}>
        {editing && <DriverForm driver={editing} onClose={() => setEditing(null)}/>}
      </Drawer>
    </div>
  );
}

function DriverForm({ driver, onClose }) {
  const colors = ["#1ea8f3", "#ef4444", "#f59e0b", "#a78bfa", "#ec4899", "#14b8a6", "#3b82f6", "#22c55e", "#facc15", "#06b6d4"];
  const [color, setColor] = useState(driver.color || "#1ea8f3");
  const [type, setType] = useState(driver.broker ? "broker" : "company");

  return (
    <div style={{ padding: 22, display: "flex", flexDirection: "column", gap: 18 }}>
      <FieldGroup label="Photo">
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <Avatar id={driver.id || "??"} color={color} size="lg"/>
          <button className="btn sm"><Icons.upload size={12}/> Upload Photo</button>
        </div>
      </FieldGroup>
      <Field label="Name *" placeholder="Armando Aranda" value={driver.name}/>
      <FieldGroup label="Phone *">
        <input className="input" placeholder="(262) 818-6030" defaultValue={driver.phone}/>
        <div style={{ fontSize: 11, color: "var(--t3)", marginTop: 6 }}>10-digit US number, any format accepted</div>
      </FieldGroup>

      <FieldGroup label="Type">
        <div className="tabs" style={{ width: "100%", display: "grid", gridTemplateColumns: "1fr 1fr" }}>
          <button className={type === "company" ? "active" : ""} onClick={() => setType("company")}>
            <Icons.truck size={12}/> Own Driver
          </button>
          <button className={type === "broker" ? "active" : ""} onClick={() => setType("broker")}>
            <Icons.box size={12}/> Broker / 3PL
          </button>
        </div>
      </FieldGroup>

      <FieldGroup label="Calendar Color">
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
          {colors.map(c => (
            <button key={c} onClick={() => setColor(c)} style={{
              width: 28, height: 28, borderRadius: "50%", background: c,
              border: color === c ? "2px solid var(--t1)" : "2px solid transparent",
              boxShadow: color === c ? "0 0 0 2px var(--bg-0)" : "none",
              cursor: "pointer", padding: 0,
            }}/>
          ))}
        </div>
      </FieldGroup>

      <FieldGroup label="Notes">
        <textarea className="input" rows={3} placeholder="CDL class, preferred lanes, equipment…" defaultValue={driver.notes}/>
      </FieldGroup>

      <div className="divider"/>
      <div className="eyebrow">Compliance & Profile</div>

      <Field label="Email" placeholder="driver@example.com"/>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        <Field label="CDL Number" placeholder="CDL-A IL-8823901"/>
        <FieldGroup label="Driver Type">
          <select className="input"><option>Select…</option><option>Class A</option><option>Class B</option></select>
        </FieldGroup>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        <Field label="CDL Expiration" placeholder="mm/dd/yyyy"/>
        <Field label="Med Card Expiration" placeholder="mm/dd/yyyy"/>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        <Field label="Last Drug Test" placeholder="mm/dd/yyyy"/>
        <Field label="Hire Date" placeholder="mm/dd/yyyy"/>
      </div>

      <label style={{ display: "flex", alignItems: "center", gap: 10, padding: 12, background: "var(--bg-2)", borderRadius: 9, border: "1px solid var(--line)" }}>
        <input type="checkbox" defaultChecked style={{ accentColor: "var(--blue)" }}/>
        <div>
          <div style={{ fontSize: 13, fontWeight: 500 }}>Active driver</div>
          <div style={{ fontSize: 11.5, color: "var(--t3)" }}>Inactive drivers won't appear on the calendar</div>
        </div>
      </label>

      <div style={{ marginTop: "auto", paddingTop: 20, borderTop: "1px solid var(--line)", display: "flex", justifyContent: "space-between", gap: 10 }}>
        <button className="btn" style={{ color: "#dc2626", borderColor: "rgba(239,68,68,0.3)" }}><Icons.trash size={13}/> Delete</button>
        <div style={{ display: "flex", gap: 10 }}>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary">Save Changes</button>
        </div>
      </div>
    </div>
  );
}

window.PageDrivers = PageDrivers;
