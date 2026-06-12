// Dashboard — the command center landing page.

function PageDashboard() {
  const [range, setRange] = useState("This Month");

  // Build KPI sparklines from data trends
  const loadsSpark = LOADS_BY_DAY.slice(-12).map(d => d.v + 0.5);
  const revenueSpark = [12, 14, 13, 16, 18, 17, 19, 22, 20, 24, 26, 28];
  const fuelSpark = [3.8, 4.1, 3.9, 4.6, 5.2, 5.0, 5.7, 5.9, 6.1, 5.8, 6.0, 5.9];
  const apptSpark = [3, 4, 5, 4, 6, 5, 7, 6, 8, 7, 6, 6];

  const totalLoads = 44;
  const needsInvoice = 0;
  const apptsToBook = 6;
  const revenue = 17539;

  // Loads per driver — top 6
  const driverLoadData = [
    { label: "BROKER COVERED", v: 8, color: "#22c55e" },
    { label: "Joshua Kly",     v: 6, color: "#a78bfa" },
    { label: "Charles Best",   v: 5, color: "#1ea8f3" },
    { label: "Jason Smith",    v: 4, color: "#f59e0b" },
    { label: "Zak Pace",       v: 1, color: "#14b8a6" },
    { label: "Brokerage 3PL",  v: 1, color: "#ec4899" },
  ];

  const driverPerf = DRIVERS.filter(d => d.loads > 0 || ["JK","CB","JS","ZP","RW","CS","LL","JB","AA"].includes(d.id))
    .filter(d => !d.broker)
    .sort((a, b) => b.loads - a.loads).slice(0, 9);

  const openTasks = INTAKE_ACTIVE.slice(0, 4);

  return (
    <div className="anim-in">
      <PageHeader
        title="Operations Dashboard"
        sub="Live snapshot · Wed, May 20, 2026 · 12:42 PM CT"
        right={
          <>
            <div className="chips">
              {["Today", "This Week", "This Month", "Quarter", "Custom"].map(r => (
                <button key={r} className={"chip" + (range === r ? " active" : "")} onClick={() => setRange(r)}>{r}</button>
              ))}
            </div>
            <button className="btn"><Icons.refresh size={14}/> Refresh</button>
            <button className="btn primary"><Icons.plus size={14}/> New Load</button>
          </>
        }
      />

      {/* KPI row */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 16, marginBottom: 16 }}>
        <KPI
          label="Total Loads"
          value="44"
          sublabel="vs. previous this month"
          delta="+44"
          deltaDir="up"
          spark={loadsSpark}
          sparkColor="#1ea8f3"
          accent="#1ea8f3"
          icon={<Icons.box size={15}/>}
        />
        <KPI
          label="Needs Invoice"
          value="0"
          sublabel="All caught up"
          delta="−3"
          deltaDir="down"
          spark={[5,4,3,4,3,2,2,1,1,2,0,0]}
          sparkColor="#22c55e"
          accent="#22c55e"
          icon={<Icons.invoice size={15}/>}
        />
        <KPI
          label="Appts to Book"
          value="6"
          sublabel="Loads with NEED status"
          delta="+2"
          deltaDir="up"
          spark={apptSpark}
          sparkColor="#f59e0b"
          accent="#f59e0b"
          icon={<Icons.calendar size={15}/>}
        />
        <KPI
          label="Revenue This Month"
          value="$17,539"
          sublabel="from 44 loads"
          delta="+12.3%"
          deltaDir="up"
          spark={revenueSpark}
          sparkColor="#1ea8f3"
          accent="#1ea8f3"
          icon={<Icons.dollar size={15}/>}
        />
      </div>

      {/* Charts row */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1.4fr", gap: 16, marginBottom: 16 }}>
        <Card
          title="Loads per Driver"
          sub="This month · by assigned driver"
          right={<button className="btn ghost sm"><Icons.more size={14}/></button>}
        >
          <div style={{ paddingTop: 6 }}>
            <HBarChart data={driverLoadData} valueFmt={v => v}/>
          </div>
          <div style={{ marginTop: 16, paddingTop: 14, borderTop: "1px solid var(--line)", display: "flex", justifyContent: "space-between", fontSize: 12, color: "var(--t3)" }}>
            <div>Avg <span style={{ color: "var(--t1)" }} className="mono">4.2</span> loads/driver</div>
            <div>Top performer <span style={{ color: "#22c55e" }} className="mono">BROKER COVERED</span></div>
          </div>
        </Card>

        <Card
          title="Loads by Day"
          sub="Daily volume · May 1 – May 31, 2026"
          right={
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--t2)" }}>
                <span style={{ width: 8, height: 8, background: "#1ea8f3", borderRadius: 2 }}/> Loads
              </span>
              <button className="btn ghost sm"><Icons.more size={14}/></button>
            </div>
          }
        >
          <BarChart data={LOADS_BY_DAY} height={220} color="#1ea8f3"/>
        </Card>
      </div>

      {/* Mid row: secondary KPI / chart */}
      <div style={{ display: "grid", gridTemplateColumns: "1.6fr 1fr 1fr", gap: 16, marginBottom: 16 }}>
        {/* Driver Performance Table */}
        <Card
          title="Driver Performance"
          sub="This Month · 2026-05-01 → 2026-05-31"
          right={<a className="btn ghost sm" href="#drivers">View all <Icons.chevR size={12}/></a>}
          pad={false}
        >
          <div style={{ maxHeight: 360, overflowY: "auto" }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Driver</th>
                  <th>Phone</th>
                  <th style={{ textAlign: "right" }}>Total Loads</th>
                  <th style={{ textAlign: "right" }}>RTI</th>
                  <th style={{ textAlign: "right" }}>Avg / Day</th>
                  <th>Last Load</th>
                </tr>
              </thead>
              <tbody>
                {driverPerf.map((d, i) => (
                  <tr key={i}>
                    <td>
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <Avatar id={d.id} color={d.color} size="sm" pulse={d.loads > 0}/>
                        <span style={{ fontWeight: 500 }}>{d.name}</span>
                      </div>
                    </td>
                    <td className="mono" style={{ color: "var(--t2)" }}>{d.phone}</td>
                    <td className="mono" style={{ textAlign: "right", fontWeight: 600 }}>{d.loads}</td>
                    <td className="mono" style={{ textAlign: "right", color: d.rti > 0 ? "#16a34a" : "var(--t4)" }}>{d.rti}</td>
                    <td className="mono" style={{ textAlign: "right", color: "var(--t2)" }}>{d.avg.toFixed(2)}</td>
                    <td style={{ color: d.lastLoad === "—" ? "var(--t4)" : "var(--t2)", fontSize: 12.5 }}>{d.lastLoad}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        {/* Load Status Donut */}
        <Card title="Load Status Mix" sub="46 active loads">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "8px 0 14px" }}>
            <Donut
              data={[
                { v: 15, color: "#22c55e" },
                { v: 23, color: "#1ea8f3" },
                { v: 6,  color: "#f59e0b" },
                { v: 2,  color: "#a78bfa" },
              ]}
              size={150} thickness={18}
              centerLabel="Total"
              centerValue="46"
            />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {[
              { label: "Ready to invoice", v: 15, color: "#22c55e" },
              { label: "In progress",       v: 23, color: "#1ea8f3" },
              { label: "Unassigned",        v: 6,  color: "#f59e0b" },
              { label: "Split loads",       v: 2,  color: "#a78bfa" },
            ].map((d, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 12.5 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ width: 8, height: 8, background: d.color, borderRadius: 2 }}/>
                  <span style={{ color: "var(--t2)" }}>{d.label}</span>
                </div>
                <span className="mono" style={{ color: "var(--t1)" }}>{d.v}</span>
              </div>
            ))}
          </div>
        </Card>

        {/* On-Time Performance */}
        <Card title="On-Time Performance" sub="Last 30 days">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "8px 0 14px" }}>
            <Donut
              data={[
                { v: 92, color: "#1ea8f3" },
                { v: 8,  color: "rgba(15,23,42,0.07)" },
              ]}
              size={150} thickness={18}
              centerLabel="On-time"
              centerValue="92%"
            />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, paddingTop: 12, borderTop: "1px solid var(--line)" }}>
            <div>
              <div style={{ fontSize: 11, color: "var(--t3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Avg Delivery</div>
              <div style={{ fontSize: 18, fontWeight: 600, marginTop: 2 }} className="tnum">2d 4h</div>
            </div>
            <div>
              <div style={{ fontSize: 11, color: "var(--t3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Delayed</div>
              <div style={{ fontSize: 18, fontWeight: 600, color: "#dc2626", marginTop: 2 }} className="tnum">3</div>
            </div>
          </div>
        </Card>
      </div>

      {/* Bottom row: Fuel · Tasks · Profitability */}
      <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr 1fr", gap: 16 }}>
        {/* Fuel This Week */}
        <Card
          title="Fuel This Week"
          sub="EFS transactions · 1,919 gal"
          right={<a className="btn ghost sm" href="#expenses">Details <Icons.chevR size={12}/></a>}
        >
          <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 4 }}>
            <div style={{ fontSize: 30, fontWeight: 600, letterSpacing: "-0.02em" }} className="tnum">$10,669</div>
            <span style={{ color: "#dc2626", fontSize: 12 }} className="tnum">▼ 42% vs last week</span>
          </div>
          <div style={{ marginTop: 14, marginBottom: 16 }}>
            <Sparkline data={[1700, 1450, 1980, 1240, 2100, 1800, 1399]} color="#1ea8f3" width={320} height={60}/>
          </div>
          <div style={{ borderTop: "1px solid var(--line)", paddingTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
            {[
              { unit: "#009", v: 1690 },
              { unit: "#299", v: 1431 },
              { unit: "#780", v: 1285 },
            ].map((t, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 13 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ width: 8, height: 8, background: FUEL_COLORS[t.unit], borderRadius: 2 }}/>
                  <span className="mono" style={{ color: "var(--t1)" }}>{t.unit}</span>
                  <Icons.truck size={13}/>
                </div>
                <span className="mono">${t.v.toLocaleString()}</span>
              </div>
            ))}
          </div>
        </Card>

        {/* Open Tasks */}
        <Card
          title="Open Tasks"
          sub="4 items needing attention"
          right={<a className="btn ghost sm" href="#tasks">View all <Icons.chevR size={12}/></a>}
          pad={false}
        >
          <div style={{ padding: "4px 0" }}>
            {openTasks.map((t, i) => (
              <div key={i} style={{ padding: "12px 22px", display: "flex", gap: 12, borderBottom: i < openTasks.length - 1 ? "1px solid var(--line)" : "none" }}>
                <div style={{
                  width: 30, height: 30, borderRadius: 8, background: "var(--blue-soft)",
                  display: "flex", alignItems: "center", justifyContent: "center", color: "#0369a1", flexShrink: 0
                }}>
                  <Icons.mail size={14}/>
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, color: "var(--t1)", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {t.subject.replace("Tender TMS ID ", "").replace(": ", " · ")}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4, fontSize: 11.5, color: "var(--t3)" }}>
                    <span>{t.age}</span>
                    <span style={{ width: 3, height: 3, background: "var(--t4)", borderRadius: "50%" }}/>
                    <span>{t.assignee}</span>
                    {t.isNew && <Pill tone="blue" style={{ fontSize: 10, padding: "2px 6px" }}>NEW</Pill>}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Card>

        {/* Profitability */}
        <Card title="Profitability" sub="Revenue minus expenses">
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 4 }}>
            <div style={{ fontSize: 30, fontWeight: 600, letterSpacing: "-0.02em" }} className="tnum">$6,870</div>
            <span style={{ color: "#16a34a", fontSize: 12 }} className="tnum">▲ 8.4%</span>
          </div>
          <div style={{ fontSize: 12, color: "var(--t3)", marginBottom: 14 }}>Net this month · per truck</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {[
              { unit: "#009", rev: 8631, cost: 5240, color: "#1ea8f3" },
              { unit: "#299", rev: 8041, cost: 6210, color: "#f59e0b" },
              { unit: "#530", rev: 7336, cost: 5980, color: "#22c55e" },
              { unit: "#685", rev: 6162, cost: 4900, color: "#a78bfa" },
            ].map((t, i) => {
              const margin = t.rev - t.cost;
              const pct = (margin / t.rev) * 100;
              return (
                <div key={i}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
                    <span className="mono" style={{ color: "var(--t2)" }}>{t.unit}</span>
                    <span className="mono" style={{ color: margin > 0 ? "#16a34a" : "#dc2626" }}>${margin.toLocaleString()}</span>
                  </div>
                  <div style={{ height: 4, background: "var(--bg-2)", borderRadius: 2, overflow: "hidden" }}>
                    <div style={{ height: "100%", width: pct + "%", background: t.color, borderRadius: 2 }}/>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      </div>
    </div>
  );
}

window.PageDashboard = PageDashboard;
