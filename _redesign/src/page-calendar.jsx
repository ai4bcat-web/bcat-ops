// Calendar page — multiple views: Planner (Kanban by day), Week (table), 2 Weeks (compact).

function PageCalendar() {
  const [view, setView] = useState("Planner");
  const [filter, setFilter] = useState("All");

  const filters = ["All", "Ready to Invoice", "Split Assignment", "Unassigned", "Needs Appt"];

  return (
    <div className="anim-in">
      <PageHeader
        title="Calendar"
        sub="May 18 – May 24, 2026 · BCAT freight movements"
        right={
          <>
            <div className="tabs">
              {["Planner", "Week", "2 Weeks", "Scheduler"].map(v => (
                <button key={v} className={view === v ? "active" : ""} onClick={() => setView(v)}>{v}</button>
              ))}
            </div>
            <button className="btn icon"><Icons.chevL size={14}/></button>
            <button className="btn icon"><Icons.chevR size={14}/></button>
            <div style={{ position: "relative" }}>
              <Icons.search size={14} style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", color: "var(--t3)" }}/>
              <input className="input" placeholder="Search Pro #, TMS, or PU#" style={{ paddingLeft: 34, width: 240 }}/>
            </div>
            <button className="btn primary"><Icons.plus size={14}/> New Load</button>
          </>
        }
      />

      <div style={{ display: "flex", gap: 8, marginBottom: 16, alignItems: "center" }}>
        <span style={{ fontSize: 12, color: "var(--t3)", marginRight: 4 }}>Filters:</span>
        <div className="chips">
          {filters.map(f => (
            <button key={f} className={"chip" + (filter === f ? " active" : "")} onClick={() => setFilter(f)}>{f}</button>
          ))}
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 14, alignItems: "center", fontSize: 11.5, color: "var(--t3)" }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><span style={{ width: 8, height: 8, background: "var(--ok)", borderRadius: 2 }}/> Ready</span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><span style={{ width: 8, height: 8, background: "var(--blue)", borderRadius: 2 }}/> In Progress</span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><span style={{ width: 8, height: 8, background: "var(--warn)", borderRadius: 2 }}/> Needs Action</span>
        </div>
      </div>

      {view === "Planner" && <PlannerView/>}
      {view === "Week" && <WeekTableView/>}
      {view === "2 Weeks" && <TwoWeekView/>}
      {view === "Scheduler" && <SchedulerView/>}
    </div>
  );
}

// --------- Kanban-style planner: columns = days ---------
function PlannerView() {
  const dayCols = [
    { key: "MON", label: "MON", date: "May 18" },
    { key: "TUE", label: "TUE", date: "May 19" },
    { key: "WED", label: "WED", date: "May 20", isToday: true },
    { key: "THU", label: "THU", date: "May 21" },
    { key: "FRI", label: "FRI", date: "May 22" },
  ];

  const byDay = {};
  RAW_LOADS.forEach(l => {
    (byDay[l.dayKey] = byDay[l.dayKey] || []).push(l);
  });

  const statusBorder = {
    ready: "var(--ok)", open: "var(--blue)", needs: "var(--warn)", unassigned: "var(--warn)"
  };
  const statusBg = {
    ready: "var(--ok-bg)", open: "var(--blue-bg)", needs: "var(--warn-bg)", unassigned: "var(--warn-bg)"
  };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: 14 }}>
      {dayCols.map(d => {
        const loads = byDay[d.key] || [];
        return (
          <div key={d.key} className="card" style={{
            background: d.isToday ? "linear-gradient(180deg, rgba(30,168,243,0.06), var(--bg-1))" : "var(--bg-1)",
            border: d.isToday ? "1px solid rgba(30,168,243,0.25)" : "1px solid var(--line)",
          }}>
            <div style={{ padding: "14px 14px 10px", borderBottom: "1px solid var(--line)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div>
                <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.1em", color: d.isToday ? "var(--blue-dark)" : "var(--t3)" }}>{d.label}</div>
                <div style={{ fontSize: 13, fontWeight: 600, color: "var(--t1)", marginTop: 1 }}>{d.date}</div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span className="mono" style={{ fontSize: 11, color: "var(--t3)" }}>{loads.length}</span>
                <button className="btn ghost icon" style={{ padding: 4 }}><Icons.plus size={12}/></button>
              </div>
            </div>
            <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 8, minHeight: 200 }}>
              {loads.length === 0 && (
                <div style={{ padding: "20px 8px", textAlign: "center", color: "var(--t4)", fontSize: 11.5 }}>
                  No loads
                </div>
              )}
              {loads.map((l, i) => {
                const drv = driverById(l.driver);
                return (
                  <div key={i} style={{
                    background: statusBg[l.status],
                    border: "1px solid " + (l.status === "ready" ? "rgba(22,163,74,0.2)" : l.status === "needs" || l.status === "unassigned" ? "rgba(217,119,6,0.2)" : "rgba(30,168,243,0.2)"),
                    borderLeft: "3px solid " + statusBorder[l.status],
                    borderRadius: 9,
                    padding: 10,
                    fontSize: 12,
                    cursor: "pointer",
                    transition: "transform 0.1s, box-shadow 0.1s",
                  }}
                  onMouseEnter={e => { e.currentTarget.style.transform = "translateY(-1px)"; e.currentTarget.style.boxShadow = "var(--sh-md)"; }}
                  onMouseLeave={e => { e.currentTarget.style.transform = ""; e.currentTarget.style.boxShadow = ""; }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                      <span className="mono" style={{ fontWeight: 600, color: "var(--t1)", fontSize: 12 }}>#{l.pro}</span>
                      {l.rti && (
                        <span style={{ display: "inline-flex", width: 14, height: 14, borderRadius: "50%", background: "var(--ok)", color: "white", alignItems: "center", justifyContent: "center" }}>
                          <Icons.check size={9} sw={3}/>
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--t2)", fontWeight: 500, marginBottom: 2 }}>{l.shipper}</div>
                    <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 6, fontSize: 11, color: "var(--t3)" }}>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 70 }}>{l.origin}</span>
                      <Icons.arrowR size={10}/>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 70 }}>{l.dest}</span>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 4, paddingTop: 6, borderTop: "1px dashed rgba(15,23,42,0.08)" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 5, minWidth: 0 }}>
                        {drv ? (
                          <>
                            <Avatar id={drv.id} color={drv.color} size="sm"/>
                            <span style={{ fontSize: 11, color: "var(--t2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{drv.name.split(" ")[0]}</span>
                          </>
                        ) : (
                          <span style={{ fontSize: 11, color: "var(--warn)", fontWeight: 500 }}>Unassigned</span>
                        )}
                      </div>
                      {l.rate && <span className="mono" style={{ fontSize: 11, fontWeight: 600 }}>${l.rate}</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// --------- Week table view (status-fill rows) ---------
function WeekTableView() {
  const byDay = {};
  RAW_LOADS.forEach(l => { (byDay[l.dayKey] = byDay[l.dayKey] || []).push(l); });

  const dayMeta = {
    MON: { label: "MON", date: "May 18, 2026" },
    TUE: { label: "TUE", date: "May 19, 2026" },
    WED: { label: "WED", date: "May 20, 2026", isToday: true },
    THU: { label: "THU", date: "May 21, 2026" },
    FRI: { label: "FRI", date: "May 22, 2026" },
  };

  const statusFill = { ready: "fill-ok", open: "fill-blue", needs: "fill-warn", unassigned: "fill-warn" };
  const statusDot = { ready: "var(--ok)", open: "var(--blue)", needs: "var(--warn)", unassigned: "var(--warn)" };

  return (
    <Card pad={false}>
      <table className="tbl">
        <thead>
          <tr>
            <th style={{ width: 18 }}></th>
            <th>Pro #</th>
            <th>TMS</th>
            <th>PU #</th>
            <th>Shipper</th>
            <th>Route</th>
            <th>PU Appt</th>
            <th>DE Appt</th>
            <th>Driver</th>
            <th style={{ textAlign: "right" }}>Rate</th>
            <th>RTI</th>
          </tr>
        </thead>
        <tbody>
          {Object.keys(byDay).map(dayKey => {
            const m = dayMeta[dayKey];
            const loads = byDay[dayKey];
            return (
              <React.Fragment key={dayKey}>
                <tr style={{ background: m.isToday ? "var(--blue-bg)" : "var(--bg-2)" }}>
                  <td colSpan={11} style={{ padding: "10px 18px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                      <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", color: m.isToday ? "var(--blue-dark)" : "var(--t3)" }}>{m.label}</span>
                      <span style={{ fontSize: 12.5, fontWeight: 500 }}>{m.date}</span>
                      {m.isToday && <Pill tone="blue">Today</Pill>}
                      <span style={{ fontSize: 12, color: "var(--t3)" }}>· {loads.length} loads</span>
                      {dayKey === "THU" && <Pill tone="warn">1 NEED appt</Pill>}
                      <button className="btn ghost sm" style={{ marginLeft: "auto" }}><Icons.plus size={12}/> Add Load</button>
                    </div>
                  </td>
                </tr>
                {loads.map((l, i) => {
                  const drv = driverById(l.driver);
                  return (
                    <tr key={i} className={statusFill[l.status] || ""}>
                      <td><span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: statusDot[l.status] }}/></td>
                      <td className="mono" style={{ fontWeight: 600 }}>{l.pro}</td>
                      <td className="mono" style={{ color: "var(--t3)", fontSize: 12, maxWidth: 130, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.tms}</td>
                      <td className="mono" style={{ color: "var(--t3)", fontSize: 12, maxWidth: 130, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.pu}</td>
                      <td style={{ fontSize: 12.5 }}>{l.shipper}</td>
                      <td><RouteLine from={l.origin} to={l.dest}/></td>
                      <td className="mono" style={{ fontSize: 12, color: "var(--t2)" }}>{l.puAppt}</td>
                      <td className="mono" style={{ fontSize: 12, color: l.deAppt === "TBD" ? "var(--warn)" : "var(--t2)" }}>{l.deAppt}</td>
                      <td>
                        {drv ? (
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <Avatar id={drv.id} color={drv.color} size="sm"/>
                            <span style={{ fontSize: 12.5 }}>{drv.name}</span>
                          </div>
                        ) : <Pill tone="warn">Unassigned</Pill>}
                      </td>
                      <td className="mono" style={{ textAlign: "right", fontWeight: 500 }}>{l.rate ? "$" + l.rate : <span style={{ color: "var(--blue-dark)" }}>Add Rate</span>}</td>
                      <td>
                        {l.rti
                          ? <span style={{ display: "inline-flex", width: 18, height: 18, borderRadius: "50%", background: "var(--ok)", color: "white", alignItems: "center", justifyContent: "center" }}><Icons.check size={11} sw={2.8}/></span>
                          : <span style={{ display: "inline-block", width: 18, height: 18, borderRadius: "50%", border: "1.5px solid var(--line-strong)" }}/>}
                      </td>
                    </tr>
                  );
                })}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}

// --------- Compact 2-Week view: heat-grid by driver × day ---------
function TwoWeekView() {
  const drivers = DRIVERS.filter(d => !d.broker).slice(0, 8);
  const dates = Array.from({ length: 14 }, (_, i) => {
    const d = new Date(2026, 4, 18 + i);
    return {
      iso: d.toISOString().slice(0, 10),
      day: d.getDate(),
      dow: ["S", "M", "T", "W", "T", "F", "S"][d.getDay()],
      isWeekend: d.getDay() === 0 || d.getDay() === 6,
      isToday: i === 2,
    };
  });

  // mock loads-per-driver-per-day
  const seed = (i, j) => {
    const h = (i * 7 + j * 13) % 11;
    if (h < 4) return 0;
    if (h < 7) return 1;
    if (h < 9) return 2;
    return 3;
  };
  const intensity = (n) => n === 0 ? "var(--bg-2)" : n === 1 ? "rgba(30,168,243,0.15)" : n === 2 ? "rgba(30,168,243,0.4)" : "var(--blue)";

  return (
    <Card pad={false}>
      <div style={{ overflowX: "auto", padding: 16 }}>
        <table style={{ borderCollapse: "separate", borderSpacing: 4, width: "100%" }}>
          <thead>
            <tr>
              <th style={{ width: 160, textAlign: "left", padding: "0 8px 8px", fontSize: 11, color: "var(--t3)", fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.06em" }}>Driver</th>
              {dates.map((d, i) => (
                <th key={i} style={{ padding: "0 0 8px", fontSize: 10.5, color: d.isToday ? "var(--blue-dark)" : "var(--t3)", fontWeight: d.isToday ? 600 : 500, minWidth: 36 }}>
                  <div>{d.dow}</div>
                  <div className="mono" style={{ marginTop: 2, fontSize: 12, color: d.isToday ? "var(--blue-dark)" : "var(--t2)" }}>{d.day}</div>
                </th>
              ))}
              <th style={{ padding: "0 0 8px", fontSize: 11, color: "var(--t3)", fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.06em", textAlign: "right" }}>Total</th>
            </tr>
          </thead>
          <tbody>
            {drivers.map((dr, i) => {
              let total = 0;
              return (
                <tr key={i}>
                  <td style={{ padding: "4px 8px", fontSize: 12.5 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <Avatar id={dr.id} color={dr.color} size="sm"/>
                      <span style={{ fontWeight: 500 }}>{dr.name}</span>
                    </div>
                  </td>
                  {dates.map((d, j) => {
                    const n = d.isWeekend ? 0 : seed(i, j);
                    total += n;
                    return (
                      <td key={j} style={{ padding: 0, textAlign: "center" }}>
                        <div style={{
                          width: 32, height: 32,
                          background: d.isWeekend ? "transparent" : intensity(n),
                          color: n >= 2 ? "white" : "var(--t1)",
                          border: d.isToday ? "1.5px solid var(--blue)" : "1px solid var(--line)",
                          borderRadius: 6,
                          display: "flex", alignItems: "center", justifyContent: "center",
                          fontSize: 11.5, fontWeight: n > 0 ? 600 : 400,
                          margin: "0 auto",
                          cursor: n > 0 ? "pointer" : "default",
                        }} className="mono">
                          {n > 0 ? n : ""}
                        </div>
                      </td>
                    );
                  })}
                  <td className="mono" style={{ padding: "4px 8px", textAlign: "right", fontWeight: 600 }}>{total}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div style={{ padding: "12px 22px", borderTop: "1px solid var(--line)", display: "flex", justifyContent: "space-between", fontSize: 11.5, color: "var(--t3)" }}>
        <div>Load assignments — May 18 – May 31, 2026</div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span>Less</span>
          {[0, 1, 2, 3].map(n => <span key={n} style={{ width: 14, height: 14, background: intensity(n), borderRadius: 3, border: "1px solid var(--line)" }}/>)}
          <span>More</span>
        </div>
      </div>
    </Card>
  );
}

// --------- Scheduler (resource-timeline) — placeholder visual ---------
function SchedulerView() {
  const drivers = DRIVERS.filter(d => !d.broker || d.loads > 0).slice(0, 8);
  const HOURS = Array.from({ length: 15 }, (_, i) => 5 + i);
  // mock blocks: { driverId, startHour, endHour, label, status }
  const blocks = [
    { d: "JK", s: 6,  e: 11, l: "13355 · CHI→WAU", st: "ready" },
    { d: "JK", s: 12, e: 16, l: "13478 · CHI→Yard", st: "open" },
    { d: "CB", s: 7,  e: 10, l: "13476 · CHI→WAU", st: "ready" },
    { d: "CB", s: 11, e: 15, l: "13505 · ZION→Yard", st: "ready" },
    { d: "JS", s: 8,  e: 12, l: "13469 · Yard→WAU", st: "ready" },
    { d: "JS", s: 13, e: 18, l: "13453 · CHI→WIN", st: "open" },
    { d: "ZP", s: 11, e: 14, l: "13513 · ADD→SHEB", st: "ready" },
    { d: "BC", s: 6,  e: 13, l: "13482 · CHI→LIV", st: "open" },
    { d: "BC", s: 9,  e: 14, l: "13448 · WIL→MIL", st: "needs" },
  ];

  const colW = 56;
  const totalW = HOURS.length * colW;
  const statusBg = {
    ready: "linear-gradient(90deg, var(--ok-bg), #c8eed1)",
    open: "linear-gradient(90deg, var(--blue-bg), #c5e7fa)",
    needs: "linear-gradient(90deg, var(--warn-bg), #fce0b8)",
  };
  const statusBd = {
    ready: "var(--ok)", open: "var(--blue)", needs: "var(--warn)"
  };

  return (
    <Card pad={false}>
      <div style={{ padding: "14px 22px", borderBottom: "1px solid var(--line)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600 }}>Wed, May 20, 2026</div>
          <div style={{ fontSize: 12, color: "var(--t3)", marginTop: 2 }}>Resource timeline · driver × hour</div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn sm"><Icons.calendar size={12}/> Today</button>
          <div className="tabs">
            <button className="active">Day</button>
            <button>3 Days</button>
            <button>Week</button>
          </div>
        </div>
      </div>
      <div style={{ overflowX: "auto" }}>
        <div style={{ display: "grid", gridTemplateColumns: `200px ${totalW}px`, minWidth: 200 + totalW }}>
          {/* header */}
          <div style={{ background: "var(--bg-2)", borderBottom: "1px solid var(--line)", padding: "10px 14px", fontSize: 11, color: "var(--t3)", fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.06em" }}>Driver</div>
          <div style={{ background: "var(--bg-2)", borderBottom: "1px solid var(--line)", display: "grid", gridTemplateColumns: `repeat(${HOURS.length}, ${colW}px)` }}>
            {HOURS.map(h => (
              <div key={h} className="mono" style={{ padding: "10px 0", fontSize: 11, color: "var(--t3)", textAlign: "center", borderLeft: "1px dashed var(--line)" }}>
                {h % 12 || 12}{h < 12 ? "a" : "p"}
              </div>
            ))}
          </div>
          {/* rows */}
          {drivers.map(d => (
            <React.Fragment key={d.id}>
              <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--line)", display: "flex", alignItems: "center", gap: 10 }}>
                <Avatar id={d.id} color={d.color} size="sm"/>
                <span style={{ fontSize: 12.5, fontWeight: 500 }}>{d.name}</span>
              </div>
              <div style={{ position: "relative", height: 48, borderBottom: "1px solid var(--line)", display: "grid", gridTemplateColumns: `repeat(${HOURS.length}, ${colW}px)`, background: "linear-gradient(90deg, transparent calc(100% - 1px), var(--line) calc(100% - 1px))", backgroundSize: `${colW}px 100%` }}>
                {blocks.filter(b => b.d === d.id).map((b, i) => {
                  const left = (b.s - HOURS[0]) * colW;
                  const width = (b.e - b.s) * colW;
                  return (
                    <div key={i} style={{
                      position: "absolute",
                      left: left + 2,
                      top: 6,
                      width: width - 4,
                      height: 36,
                      background: statusBg[b.st],
                      borderLeft: "3px solid " + statusBd[b.st],
                      borderRadius: 7,
                      padding: "5px 9px",
                      fontSize: 11.5,
                      fontWeight: 500,
                      color: "var(--t1)",
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      transition: "transform 0.1s",
                    }}
                    onMouseEnter={e => e.currentTarget.style.transform = "scale(1.02)"}
                    onMouseLeave={e => e.currentTarget.style.transform = ""}>
                      {b.l}
                    </div>
                  );
                })}
              </div>
            </React.Fragment>
          ))}
        </div>
      </div>
    </Card>
  );
}

window.PageCalendar = PageCalendar;
