// Fleet page — equipment with compliance dates.

function PageFleet() {
  const [tab, setTab] = useState("All");

  const filtered = FLEET.filter(f => {
    if (tab === "Trucks" && f.type !== "Truck") return false;
    if (tab === "Trailers" && f.type !== "Trailer") return false;
    return true;
  });

  const isOverdue = (dateStr) => {
    if (!dateStr || dateStr === "—") return false;
    return new Date(dateStr) < new Date("2026-05-20");
  };

  return (
    <div className="anim-in">
      <PageHeader
        title="Fleet"
        sub="Equipment, compliance & maintenance"
        right={
          <>
            <button className="btn"><Icons.download size={14}/> Export</button>
            <button className="btn primary"><Icons.plus size={14}/> Add Equipment</button>
          </>
        }
      />

      <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12, marginBottom: 18 }}>
        {[
          { label: "Total Units", value: 16, color: "#1ea8f3", icon: <Icons.truck size={14}/> },
          { label: "Trucks", value: 6, color: "#0369a1", icon: <Icons.truck size={14}/> },
          { label: "Trailers", value: 10, color: "#a78bfa", icon: <Icons.trailer size={14}/> },
          { label: "Compliance Alerts", value: 2, color: "#ef4444", icon: <Icons.alert size={14}/> },
          { label: "Open Tasks", value: 41, color: "#f59e0b", icon: <Icons.maintenance size={14}/> },
        ].map((k, i) => (
          <div key={i} className="card card-pad" style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div style={{ width: 38, height: 38, borderRadius: 9, background: "var(--bg-2)", color: k.color, display: "flex", alignItems: "center", justifyContent: "center" }}>{k.icon}</div>
            <div>
              <div className="eyebrow">{k.label}</div>
              <div style={{ fontSize: 22, fontWeight: 600, color: k.color, letterSpacing: "-0.02em", marginTop: 2 }} className="tnum">{k.value}</div>
            </div>
          </div>
        ))}
      </div>

      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 14 }}>
        <div className="tabs">
          {["All", "Trucks", "Trailers"].map(t => (
            <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>{t}</button>
          ))}
        </div>
        <div style={{ position: "relative", flex: 1, maxWidth: 360 }}>
          <Icons.search size={14} style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", color: "var(--t3)" }}/>
          <input className="input" placeholder="Search equipment…" style={{ paddingLeft: 34 }}/>
        </div>
      </div>

      <Card pad={false}>
        <div style={{ overflowX: "auto" }}>
          <table className="tbl zebra">
            <thead>
              <tr>
                <th>Type</th>
                <th>Unit #</th>
                <th>Year</th>
                <th>Make / Model</th>
                <th>Plate</th>
                <th>DOT Insp</th>
                <th>IFTA Exp</th>
                <th>IRP Exp</th>
                <th>Insurance</th>
                <th>Driver</th>
                <th>Fleet Mgr</th>
                <th>Open Tasks</th>
                <th style={{ textAlign: "right" }}>Repair Spend</th>
                <th style={{ width: 80 }}></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((f, i) => (
                <tr key={i}>
                  <td>
                    <Pill tone={f.type === "Truck" ? "blue" : "violet"}>
                      {f.type === "Truck" ? <Icons.truck size={11}/> : <Icons.trailer size={11}/>} {f.type}
                    </Pill>
                  </td>
                  <td className="mono" style={{ fontWeight: 600, color: "var(--t1)" }}>{f.unit}</td>
                  <td className="mono" style={{ color: "var(--t2)" }}>{f.year}</td>
                  <td style={{ fontSize: 12.5 }}>{f.makeModel}</td>
                  <td className="mono" style={{ color: "var(--t2)" }}>{f.plate}</td>
                  <td className="mono" style={{ color: isOverdue(f.dotInsp) ? "#dc2626" : "var(--t2)", fontSize: 12 }}>
                    {isOverdue(f.dotInsp) && <Icons.alert size={11} style={{ marginRight: 4, verticalAlign: "middle" }}/>}
                    {f.dotInsp}
                  </td>
                  <td className="mono" style={{ color: "var(--t2)", fontSize: 12 }}>{f.iftaExp || "—"}</td>
                  <td className="mono" style={{ color: "var(--t2)", fontSize: 12 }}>{f.irpExp || "—"}</td>
                  <td className="mono" style={{ color: "var(--t2)", fontSize: 12 }}>{f.insurance}</td>
                  <td style={{ color: "var(--t3)", fontSize: 12.5 }}>{f.driver}</td>
                  <td style={{ fontSize: 12.5 }}>{f.fleetMgr}</td>
                  <td>
                    {f.tasks === "None" ? <span style={{ color: "var(--t4)", fontSize: 12 }}>None</span> :
                     f.tasks.includes("high") ? <Pill tone="warn"><Icons.alert size={10}/> {f.tasks}</Pill> :
                     <Pill tone="blue">{f.tasks}</Pill>}
                  </td>
                  <td className="mono" style={{ textAlign: "right", color: f.repair ? "var(--t1)" : "var(--t4)" }}>{f.repair ? "$" + f.repair.toLocaleString() : "—"}</td>
                  <td style={{ textAlign: "right" }}>
                    <button className="btn ghost icon"><Icons.edit size={13}/></button>
                    <button className="btn ghost icon"><Icons.trash size={13}/></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

window.PageFleet = PageFleet;
