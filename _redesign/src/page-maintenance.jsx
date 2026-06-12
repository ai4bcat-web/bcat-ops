// Maintenance — tasks and invoice history.

function PageMaintenance() {
  const [tab, setTab] = useState("Tasks");
  const [eq, setEq] = useState("All Equipment");
  const [time, setTime] = useState("Upcoming");
  const [priority, setPriority] = useState("All Priorities");

  const isOverdue = (d) => new Date(d) < new Date("2026-05-20");

  const priorityTone = { High: "bad", Med: "warn", Low: "neutral" };

  return (
    <div className="anim-in">
      <PageHeader
        title="Maintenance"
        sub="Tasks, compliance & repair history"
        right={
          <>
            <button className="btn"><Icons.download size={14}/> Export</button>
            <button className="btn primary"><Icons.plus size={14}/> New Task</button>
          </>
        }
      />

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 18 }}>
        {[
          { label: "Open Tasks", value: 41, color: "#1ea8f3" },
          { label: "Overdue", value: 20, color: "#ef4444", pulse: true },
          { label: "Completed", value: 28, color: "#22c55e" },
          { label: "Invoice Total", value: "$33,969.53", color: "#a78bfa" },
        ].map((k, i) => (
          <div key={i} className="card card-pad" style={{ position: "relative", overflow: "hidden" }}>
            <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 3, background: k.color }}/>
            <div className="eyebrow" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              {k.label}
              {k.pulse && <span className="dot pulse" style={{ display: "inline-block", width: 6, height: 6, borderRadius: "50%", background: k.color }}/>}
            </div>
            <div style={{ fontSize: 28, fontWeight: 600, marginTop: 4, color: k.color, letterSpacing: "-0.02em" }} className="tnum">{k.value}</div>
          </div>
        ))}
      </div>

      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 14, flexWrap: "wrap" }}>
        <div className="tabs">
          {["Tasks", "Invoice History"].map(t => (
            <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
              {t === "Tasks" && <Icons.maintenance size={12}/>}
              {t === "Invoice History" && <Icons.invoice size={12}/>}
              {t}
            </button>
          ))}
        </div>
        <div style={{ position: "relative", flex: 1, maxWidth: 320 }}>
          <Icons.search size={14} style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", color: "var(--t3)" }}/>
          <input className="input" placeholder="Search tasks…" style={{ paddingLeft: 34 }}/>
        </div>
        <select className="input" style={{ width: "auto" }} value={eq} onChange={e => setEq(e.target.value)}>
          <option>All Equipment</option>
          {FLEET.map(f => <option key={f.unit}>{f.unit}</option>)}
        </select>
        <select className="input" style={{ width: "auto" }} value={time} onChange={e => setTime(e.target.value)}>
          <option>Upcoming</option>
          <option>Overdue</option>
          <option>All</option>
        </select>
        <select className="input" style={{ width: "auto" }} value={priority} onChange={e => setPriority(e.target.value)}>
          <option>All Priorities</option>
          <option>High</option>
          <option>Med</option>
          <option>Low</option>
        </select>
      </div>

      <Card pad={false}>
        <table className="tbl zebra">
          <thead>
            <tr>
              <th style={{ width: 32 }}></th>
              <th>Task</th>
              <th>Equipment</th>
              <th>Due</th>
              <th>Priority</th>
              <th>Assignee</th>
              <th>Status</th>
              <th style={{ width: 90 }}></th>
            </tr>
          </thead>
          <tbody>
            {MAINTENANCE.map((m, i) => {
              const over = isOverdue(m.due);
              return (
                <tr key={i}>
                  <td><span style={{ display: "inline-block", width: 14, height: 14, borderRadius: 4, border: "1.5px solid var(--line-strong)" }}/></td>
                  <td>
                    <div style={{ fontSize: 13, fontWeight: 500, color: "var(--t1)" }}>{m.task}</div>
                    <div style={{ fontSize: 11.5, color: "var(--t3)", marginTop: 2 }}>{m.desc}</div>
                  </td>
                  <td className="mono" style={{ fontWeight: 500 }}>{m.eq}</td>
                  <td className="mono" style={{ color: over ? "#dc2626" : "var(--t2)", fontSize: 12.5 }}>
                    {over && <Icons.alert size={11} style={{ marginRight: 4, verticalAlign: "middle" }}/>}
                    {m.due}
                  </td>
                  <td><Pill tone={priorityTone[m.priority]}>{m.priority}</Pill></td>
                  <td>
                    {m.assignee ? (
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <Avatar id={m.assignee[0]} color="#f59e0b" size="sm"/>
                        <span style={{ fontSize: 12.5 }}>{m.assignee}</span>
                      </div>
                    ) : <span style={{ color: "var(--t4)" }}>—</span>}
                  </td>
                  <td><Pill tone={over ? "bad" : "blue"}>{over ? "Overdue" : "Upcoming"}</Pill></td>
                  <td style={{ textAlign: "right" }}>
                    <button className="btn ghost icon"><Icons.edit size={13}/></button>
                    <button className="btn ghost icon"><Icons.trash size={13}/></button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

window.PageMaintenance = PageMaintenance;
