// Schedules — driver daily schedules with SMS preview.

function PageSchedules() {
  const [day] = useState("Wed, May 20, 2026");

  return (
    <div className="anim-in">
      <PageHeader
        title="Driver Schedules"
        sub={day + " · 3 drivers scheduled · Roy, Zak, Chad, Lee, Charles, John, Armando, BROKER off"}
        right={
          <>
            <div className="tabs">
              <button>Yesterday</button>
              <button className="active">Today</button>
              <button>Tomorrow</button>
            </div>
            <button className="btn icon"><Icons.chevL size={14}/></button>
            <button className="btn icon"><Icons.chevR size={14}/></button>
            <button className="btn"><Icons.copy size={14}/> Copy All</button>
            <button className="btn primary"><Icons.msg size={14}/> Send All SMS</button>
          </>
        }
      />

      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {SCHEDULES.map((s, idx) => {
          const drv = DRIVERS.find(d => d.id === s.id) || { color: "#1ea8f3", name: s.driver };
          return (
            <Card key={idx} pad={false}>
              <div style={{ padding: "16px 22px", borderBottom: "1px solid var(--line)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <Avatar id={s.id} color={drv.color} size="lg"/>
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontSize: 15, fontWeight: 600 }}>{s.driver}</span>
                      <Pill tone={s.type === "BROKER" ? "violet" : "blue"}>{s.type}</Pill>
                    </div>
                    <div style={{ fontSize: 12, color: "var(--t3)", marginTop: 2 }}>
                      <span className="mono">{s.count}</span> {s.count === 1 ? "load" : "loads"} · {s.driver === "BROKER COVERED" ? "Brokerage" : "On road"}
                    </div>
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button className="btn sm"><Icons.phone size={12}/> Call</button>
                  <button className="btn sm"><Icons.msg size={12}/> Text</button>
                  <button className="btn sm"><Icons.copy size={12}/> Copy</button>
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 0 }}>
                {/* Stops list */}
                <div style={{ padding: 22, borderRight: "1px solid var(--line)" }}>
                  <div className="eyebrow" style={{ marginBottom: 12 }}>Today's Stops</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 0, position: "relative" }}>
                    {/* timeline line */}
                    <div style={{ position: "absolute", left: 13, top: 14, bottom: 14, width: 2, background: "var(--line)" }}/>
                    {s.loads.map((l, i) => (
                      <div key={i} style={{ display: "flex", gap: 14, padding: "8px 0", position: "relative", zIndex: 1 }}>
                        <div style={{
                          width: 28, height: 28, borderRadius: "50%",
                          background: "var(--bg-2)", border: "1.5px solid " + drv.color,
                          display: "flex", alignItems: "center", justifyContent: "center",
                          fontSize: 11.5, fontWeight: 600, color: drv.color, flexShrink: 0
                        }}>
                          {l.n}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                            <Pill tone="ok" style={{ fontSize: 10, padding: "2px 6px" }}><Icons.arrowU size={9}/> Pickup</Pill>
                            <span className="mono" style={{ fontSize: 11.5, color: "var(--t1)" }}>{l.pu}</span>
                          </div>
                          <div style={{ fontSize: 13, fontWeight: 500, color: "var(--t1)" }}>{l.origin}</div>
                          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, marginBottom: 4 }}>
                            <Pill tone="warn" style={{ fontSize: 10, padding: "2px 6px" }}><Icons.arrowD size={9}/> Deliver</Pill>
                            <span className="mono" style={{ fontSize: 11.5, color: l.de === "TBD" ? "var(--warn)" : "var(--t1)" }}>{l.de}</span>
                          </div>
                          <div style={{ fontSize: 13, fontWeight: 500, color: "var(--t1)" }}>{l.dest}</div>
                          <div style={{ display: "flex", gap: 14, fontSize: 11, color: "var(--t3)", marginTop: 6 }} className="mono">
                            <span>Load {l.proPu}</span>
                            <span>PU# {l.pkg}</span>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* SMS preview */}
                <div style={{ padding: 22, background: "var(--bg-0)" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                    <div className="eyebrow">SMS Preview</div>
                    <button className="btn ghost sm"><Icons.copy size={11}/> Copy</button>
                  </div>
                  <div style={{
                    background: "linear-gradient(180deg, #f0f9ff, #e6f4fd)",
                    border: "1px solid rgba(30,168,243,0.25)",
                    borderRadius: 12, padding: 16,
                    fontSize: 12.5, color: "var(--t2)", lineHeight: 1.6,
                  }}>
                    Hi {s.driver.split(" ")[0].toUpperCase() === "BROKER" ? "BROKER" : s.driver.split(" ")[0]}!
                    Here's your schedule for Wednesday, May 20, 2026. You have {s.count} {s.count === 1 ? "load" : "loads"} today.
                    {" "}{s.loads.map((l, i) => `${i === 0 ? "First" : i === 1 ? "Second" : i === 2 ? "Third" : "Fourth"}, pick up at ${l.origin} at ${l.pu} and deliver to ${l.dest} by ${l.de} (Load: ${l.proPu}, PU#: ${l.pkg}).`).join(" ")}
                    {" "}- BCAT Dispatch
                  </div>
                </div>
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

window.PageSchedules = PageSchedules;
