// Intake page — incoming load tenders + history.

function PageIntake() {
  const [source, setSource] = useState("Ivan Cartage");

  const statusTone = {
    new: "blue",
    built: "ok",
    done: "neutral",
    archived: "neutral",
  };

  return (
    <div className="anim-in">
      <PageHeader
        title="Load Intake"
        sub="Incoming loads from Ivan Cartage and BCAT Logistics"
        right={
          <>
            <button className="btn"><Icons.refresh size={14}/> Refresh</button>
            <button className="btn primary"><Icons.plus size={14}/> Manual Intake</button>
          </>
        }
      />

      {/* KPI row */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 18 }}>
        {[
          { label: "Active Queue",   value: 4,  color: "#0369a1", icon: <Icons.mail size={14}/> },
          { label: "Built Today",    value: 8,  color: "#16a34a", icon: <Icons.check size={14}/> },
          { label: "Avg Build Time", value: "4m 12s", color: "#a78bfa", icon: <Icons.zap size={14}/> },
          { label: "Auto-Matched",   value: "94%", color: "#b45309", icon: <Icons.spark size={14}/> },
        ].map((k, i) => (
          <div key={i} className="card card-pad" style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div style={{ width: 38, height: 38, borderRadius: 9, background: "var(--bg-2)", color: k.color, display: "flex", alignItems: "center", justifyContent: "center" }}>{k.icon}</div>
            <div>
              <div className="eyebrow">{k.label}</div>
              <div style={{ fontSize: 22, fontWeight: 600, color: "var(--t1)", letterSpacing: "-0.02em", marginTop: 2 }} className="tnum">{k.value}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Source selector */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 14 }}>
        <span style={{ fontSize: 12, color: "var(--t3)" }}>Active source:</span>
        {["Ivan Cartage", "BCAT Logistics"].map(s => (
          <button key={s} className={"chip" + (source === s ? " active" : "")} onClick={() => setSource(s)}>
            <span style={{ display: "inline-block", width: 6, height: 6, borderRadius: "50%", background: source === s ? "#0369a1" : "var(--t4)" }}/>
            {s}
          </button>
        ))}
        <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--t3)" }}>Auto-poll every 30s · Last sync 12s ago</span>
      </div>

      {/* Active Queue */}
      <Card title="Active Queue" sub="4 tenders awaiting build">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14 }}>
          {INTAKE_ACTIVE.map((t, i) => (
            <div key={i} style={{
              background: "var(--bg-2)",
              border: "1px solid var(--line)",
              borderRadius: 11,
              padding: 16,
              display: "flex",
              flexDirection: "column",
              gap: 12,
              position: "relative",
            }}>
              {t.isNew && (
                <span style={{ position: "absolute", top: 12, right: 12 }}>
                  <Pill tone="blue" dot pulse>NEW</Pill>
                </span>
              )}
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--t1)", lineHeight: 1.3, paddingRight: 50 }}>
                {t.subject}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 11, color: "var(--t3)" }}>
                <span>{t.age}</span>
                <span style={{ width: 3, height: 3, background: "var(--t4)", borderRadius: "50%" }}/>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                  <Avatar id="D" color="#a78bfa" size="sm"/>
                  {t.assignee}
                </span>
                <span style={{ width: 3, height: 3, background: "var(--t4)", borderRadius: "50%" }}/>
                <Icons.msg size={11}/> Slack
              </div>
              <div style={{ fontSize: 11.5, color: "var(--t3)", lineHeight: 1.5, maxHeight: 50, overflow: "hidden",
                            display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical" }}>
                {t.body}
              </div>
              <div style={{ display: "flex", gap: 6, marginTop: "auto" }}>
                <button className="btn primary sm" style={{ flex: 1 }}><Icons.plus size={12}/> Build Load</button>
                <button className="btn sm"><Icons.pulse size={12}/> In Progress</button>
                <button className="btn sm icon"><Icons.trash size={12}/></button>
              </div>
            </div>
          ))}
        </div>
      </Card>

      {/* History */}
      <div style={{ marginTop: 16 }}>
        <Card
          title="All Intake History"
          sub={INTAKE_HISTORY.length + " items"}
          right={
            <div style={{ display: "flex", gap: 8 }}>
              <select className="input" style={{ width: 130, fontSize: 12 }}><option>All Sources</option></select>
              <select className="input" style={{ width: 130, fontSize: 12 }}><option>All Statuses</option></select>
            </div>
          }
          pad={false}
        >
          <table className="tbl zebra">
            <thead>
              <tr>
                <th>Received</th>
                <th>Source</th>
                <th>Subject</th>
                <th>Assignee</th>
                <th>Status</th>
                <th>PRO# / Load</th>
                <th style={{ width: 80 }}>Link</th>
              </tr>
            </thead>
            <tbody>
              {INTAKE_HISTORY.map((h, i) => (
                <tr key={i}>
                  <td className="mono" style={{ fontSize: 12, color: "var(--t2)" }}>{h.when}</td>
                  <td><Pill tone={h.source === "BCAT Logistics" ? "blue" : "violet"}>{h.source}</Pill></td>
                  <td>
                    <div style={{ fontSize: 13, color: "var(--t1)" }}>{h.subject}</div>
                    <div className="mono" style={{ fontSize: 11, color: "var(--t4)", marginTop: 2 }}>{h.thread}</div>
                  </td>
                  <td>
                    {h.assignee && (
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <Avatar id={h.assignee[0]} color={h.assignee === "Arcie" ? "#22c55e" : "#a78bfa"} size="sm"/>
                        <span style={{ fontSize: 12.5 }}>{h.assignee}</span>
                      </div>
                    )}
                  </td>
                  <td>{h.status && <Pill tone={statusTone[h.status] || "neutral"}>{h.status.toUpperCase()}</Pill>}</td>
                  <td className="mono" style={{ color: typeof h.link === "string" ? "#0369a1" : "var(--t4)" }}>{typeof h.link === "string" ? h.link : "—"}</td>
                  <td>{h.link && <button className="btn ghost icon"><Icons.ext size={13}/></button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>
    </div>
  );
}

window.PageIntake = PageIntake;
