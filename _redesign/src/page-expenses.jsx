// Expenses — three tabs: Fuel, Manage (types/allocations/recurring), and history.

function PageExpenses() {
  const [tab, setTab] = useState("Fuel");
  const [range, setRange] = useState("Last 4 Weeks");
  const [showUpload, setShowUpload] = useState(false);

  return (
    <div className="anim-in">
      <PageHeader
        title="Expenses"
        sub="Fuel, insurance, financing, maintenance — per truck"
        right={
          <>
            <button className="btn"><Icons.refresh size={14}/> Refresh</button>
            {tab === "Fuel" && <button className="btn primary" onClick={() => setShowUpload(true)}><Icons.upload size={14}/> Upload EFS Report</button>}
            {tab === "Manage" && <button className="btn primary"><Icons.plus size={14}/> New Expense Type</button>}
          </>
        }
      />

      <div className="tabs" style={{ marginBottom: 18 }}>
        <button className={tab === "Fuel" ? "active" : ""} onClick={() => setTab("Fuel")}><Icons.fuel size={12}/> Fuel</button>
        <button className={tab === "AllCosts" ? "active" : ""} onClick={() => setTab("AllCosts")}><Icons.dollar size={12}/> All Costs by Truck</button>
        <button className={tab === "Manage" ? "active" : ""} onClick={() => setTab("Manage")}><Icons.settings size={12}/> Manage</button>
      </div>

      {tab === "Fuel" && <FuelTab range={range} setRange={setRange}/>}
      {tab === "AllCosts" && <AllCostsTab/>}
      {tab === "Manage" && <ManageTab/>}

      <Drawer open={showUpload} onClose={() => setShowUpload(false)} title="Upload EFS Fuel Report" width={520}>
        <FuelUploadForm onClose={() => setShowUpload(false)}/>
      </Drawer>
    </div>
  );
}

function FuelTab({ range, setRange }) {
  const labels = FUEL_WEEKLY.map(w => w.week);
  const series = FUEL_TRUCKS.map(t => ({
    name: t, color: FUEL_COLORS[t],
    data: FUEL_WEEKLY.map(w => w[t]),
  }));

  return (
    <>
      <div style={{ display: "flex", gap: 8, marginBottom: 18 }}>
        <div className="chips">
          {["Yesterday", "This Week", "This Month", "Last 30 Days", "Last 4 Weeks", "This Year", "Custom"].map(r => (
            <button key={r} className={"chip" + (range === r ? " active" : "")} onClick={() => setRange(r)}>{r}</button>
          ))}
        </div>
        <span style={{ marginLeft: "auto", alignSelf: "center", fontSize: 12, color: "var(--t3)" }}>Showing Apr 19, 2026 – May 23, 2026</span>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12, marginBottom: 18 }}>
        {[
          { label: "Total Fuel Spend", value: "$35,766.75", sub: "95 fuel transactions", color: "#1ea8f3" },
          { label: "Total Gallons", value: "6,852.66 gal", sub: "across 5 trucks", color: "#7c3aed" },
          { label: "Avg $/Gallon", value: "$5.22", sub: "+$0.18 vs prev", color: "#d97706" },
          { label: "Fuel Transactions", value: "95", sub: "Avg 19/truck", color: "#16a34a" },
          { label: "Other Charges", value: "$1,964.28", sub: "6 non-fuel items", color: "#dc2626" },
        ].map((k, i) => (
          <div key={i} className="card card-pad">
            <div className="eyebrow">{k.label}</div>
            <div style={{ fontSize: 22, fontWeight: 600, color: "var(--t1)", letterSpacing: "-0.02em", marginTop: 6 }} className="tnum">{k.value}</div>
            <div style={{ fontSize: 11.5, color: "var(--t3)", marginTop: 3 }}>{k.sub}</div>
          </div>
        ))}
      </div>

      <Card title="Weekly Fuel Spend by Truck" sub="Sunday–Saturday weeks · fuel only · click a cell to see transactions" pad={false}>
        <table className="tbl">
          <thead>
            <tr>
              <th>Truck</th>
              {FUEL_WEEKLY.map(w => <th key={w.week} className="mono" style={{ textAlign: "right" }}>{w.week}</th>)}
              <th style={{ textAlign: "right" }}>Total</th>
            </tr>
          </thead>
          <tbody>
            {FUEL_TRUCKS.map(t => {
              const total = FUEL_WEEKLY.reduce((s, w) => s + w[t], 0);
              return (
                <tr key={t}>
                  <td className="mono" style={{ color: FUEL_COLORS[t], fontWeight: 600 }}>
                    <Icons.truck size={12} style={{ marginRight: 6, verticalAlign: "middle" }}/>
                    {t}
                  </td>
                  {FUEL_WEEKLY.map(w => <td key={w.week} className="mono" style={{ textAlign: "right", color: "var(--t2)" }}>${w[t].toLocaleString(undefined, {minimumFractionDigits:2,maximumFractionDigits:2})}</td>)}
                  <td className="mono" style={{ textAlign: "right", fontWeight: 600 }}>${total.toLocaleString(undefined, {minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                </tr>
              );
            })}
            <tr style={{ background: "var(--bg-2)", fontWeight: 600 }}>
              <td className="mono">TOTAL</td>
              {FUEL_WEEKLY.map(w => {
                const sum = FUEL_TRUCKS.reduce((s, t) => s + w[t], 0);
                return <td key={w.week} className="mono" style={{ textAlign: "right" }}>${sum.toLocaleString(undefined, {minimumFractionDigits:2,maximumFractionDigits:2})}</td>;
              })}
              <td className="mono" style={{ textAlign: "right" }}>$35,766.75</td>
            </tr>
          </tbody>
        </table>
      </Card>

      <div style={{ marginTop: 16 }}>
        <Card title="Fuel Over Time" sub="Weekly spend by truck">
          <LineChart series={series} labels={labels} height={320} yFmt={v => "$" + v.toLocaleString()}/>
        </Card>
      </div>
    </>
  );
}

function AllCostsTab() {
  const cats = [
    { key: "fuel",        label: "Fuel",        color: "#1ea8f3" },
    { key: "insurance",   label: "Insurance",   color: "#7c3aed" },
    { key: "financing",   label: "Financing",   color: "#d97706" },
    { key: "lease",       label: "Lease",       color: "#16a34a" },
    { key: "maintenance", label: "Maintenance", color: "#dc2626" },
    { key: "permits",     label: "Permits",     color: "#0d9488" },
    { key: "tolls",       label: "Tolls",       color: "#db2777" },
    { key: "other",       label: "Other",       color: "#64748b" },
  ];
  const trucks = [
    { unit: "#009", fuel: 8631, insurance: 1875, financing: 0,    lease: 0,    maintenance: 240,  permits: 95,  tolls: 220, other: 60 },
    { unit: "#299", fuel: 8041, insurance: 1875, financing: 0,    lease: 0,    maintenance: 10538, permits: 95, tolls: 180, other: 40 },
    { unit: "#530", fuel: 7336, insurance: 1875, financing: 1240, lease: 0,    maintenance: 6015, permits: 95, tolls: 310, other: 80 },
    { unit: "#685", fuel: 6162, insurance: 1875, financing: 1240, lease: 0,    maintenance: 6466, permits: 95, tolls: 240, other: 50 },
    { unit: "#780", fuel: 5596, insurance: 1875, financing: 0,    lease: 0,    maintenance: 1784, permits: 95, tolls: 160, other: 30 },
  ];

  return (
    <Card title="All Costs by Truck" sub="May 2026 · all expense categories combined" pad={false}>
      <table className="tbl">
        <thead>
          <tr>
            <th>Truck</th>
            {cats.map(c => <th key={c.key} className="mono" style={{ textAlign: "right" }}>{c.label}</th>)}
            <th className="mono" style={{ textAlign: "right" }}>Total</th>
          </tr>
        </thead>
        <tbody>
          {trucks.map((t, i) => {
            const total = cats.reduce((s, c) => s + (t[c.key] || 0), 0);
            return (
              <tr key={i}>
                <td className="mono" style={{ fontWeight: 600 }}>{t.unit}</td>
                {cats.map(c => (
                  <td key={c.key} className="mono" style={{ textAlign: "right", color: t[c.key] ? "var(--t1)" : "var(--t4)" }}>
                    {t[c.key] ? "$" + t[c.key].toLocaleString() : "—"}
                  </td>
                ))}
                <td className="mono" style={{ textAlign: "right", fontWeight: 600 }}>${total.toLocaleString()}</td>
              </tr>
            );
          })}
          <tr style={{ background: "var(--bg-2)", fontWeight: 600 }}>
            <td className="mono">TOTAL</td>
            {cats.map(c => {
              const sum = trucks.reduce((s, t) => s + (t[c.key] || 0), 0);
              return <td key={c.key} className="mono" style={{ textAlign: "right" }}>${sum.toLocaleString()}</td>;
            })}
            <td className="mono" style={{ textAlign: "right" }}>
              ${trucks.reduce((s, t) => s + cats.reduce((ss, c) => ss + (t[c.key] || 0), 0), 0).toLocaleString()}
            </td>
          </tr>
        </tbody>
      </table>
    </Card>
  );
}

function ManageTab() {
  const expenseTypes = [
    { name: "Diesel Fuel",          category: "FUEL",        entry: "AUTO_INGESTED", active: true,  records: 95 },
    { name: "Liability Insurance",  category: "INSURANCE",   entry: "FIXED",         active: true,  records: 12 },
    { name: "Truck Financing #530", category: "FINANCING",   entry: "FIXED",         active: true,  records: 12 },
    { name: "Truck Financing #685", category: "FINANCING",   entry: "FIXED",         active: true,  records: 12 },
    { name: "Maintenance Repairs",  category: "MAINTENANCE", entry: "MANUAL",        active: true,  records: 28 },
    { name: "IRP Registration",     category: "PERMITS",     entry: "FIXED",         active: true,  records: 1 },
    { name: "EFS Tollway",          category: "TOLLS",       entry: "AUTO_INGESTED", active: true,  records: 47 },
  ];

  const allocations = [
    { name: "Insurance — All Trucks",   method: "SPLIT_EVEN", trucks: ["#009","#299","#530","#685","#780","#TBD"] },
    { name: "Financing — #530 Direct",  method: "DIRECT",     trucks: ["#530"] },
    { name: "Financing — #685 Direct",  method: "DIRECT",     trucks: ["#685"] },
    { name: "Permits — Fuel Cards Only",method: "SPLIT_EVEN", trucks: ["#009","#299","#530","#685","#780"] },
  ];

  const recurring = [
    { type: "Liability Insurance",  alloc: "Insurance — All Trucks",   monthly: 11250, start: "2026-01", end: null },
    { type: "Truck Financing #530", alloc: "Financing — #530 Direct",  monthly: 1240,  start: "2026-01", end: "2028-12" },
    { type: "Truck Financing #685", alloc: "Financing — #685 Direct",  monthly: 1240,  start: "2026-01", end: "2028-12" },
    { type: "IRP Registration",     alloc: "Permits — Fuel Cards Only",monthly: 475,   start: "2026-01", end: null },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Card
        title="Expense Types"
        sub={expenseTypes.length + " types · grouped by category"}
        right={<button className="btn sm"><Icons.plus size={12}/> Add Type</button>}
        pad={false}
      >
        <table className="tbl">
          <thead>
            <tr>
              <th>Name</th>
              <th>Category</th>
              <th>Entry Method</th>
              <th style={{ textAlign: "right" }}>Records</th>
              <th>Status</th>
              <th style={{ width: 80 }}></th>
            </tr>
          </thead>
          <tbody>
            {expenseTypes.map((t, i) => (
              <tr key={i}>
                <td style={{ fontWeight: 500 }}>{t.name}</td>
                <td><Pill tone={t.category === "FUEL" ? "blue" : t.category === "INSURANCE" ? "violet" : t.category === "MAINTENANCE" ? "bad" : "neutral"}>{t.category}</Pill></td>
                <td className="mono" style={{ fontSize: 12, color: "var(--t2)" }}>{t.entry}</td>
                <td className="mono" style={{ textAlign: "right" }}>{t.records}</td>
                <td><Pill tone="ok" dot>Active</Pill></td>
                <td style={{ textAlign: "right" }}>
                  <button className="btn ghost icon"><Icons.edit size={13}/></button>
                  <button className="btn ghost icon"><Icons.trash size={13}/></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card
        title="Truck Allocations"
        sub="How costs split across the fleet"
        right={<button className="btn sm"><Icons.plus size={12}/> New Allocation</button>}
        pad={false}
      >
        <table className="tbl">
          <thead>
            <tr>
              <th>Allocation Name</th>
              <th>Method</th>
              <th>Trucks</th>
              <th style={{ width: 80 }}></th>
            </tr>
          </thead>
          <tbody>
            {allocations.map((a, i) => (
              <tr key={i}>
                <td style={{ fontWeight: 500 }}>{a.name}</td>
                <td><Pill tone={a.method === "DIRECT" ? "blue" : "violet"}>{a.method.replace("_", " ")}</Pill></td>
                <td>
                  <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                    {a.trucks.map(t => (
                      <span key={t} className="mono" style={{ fontSize: 11, padding: "2px 7px", background: "var(--bg-2)", borderRadius: 5, color: "var(--t1)" }}>{t}</span>
                    ))}
                  </div>
                </td>
                <td style={{ textAlign: "right" }}>
                  <button className="btn ghost icon"><Icons.edit size={13}/></button>
                  <button className="btn ghost icon"><Icons.trash size={13}/></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card
        title="Recurring Expenses"
        sub="Auto-posted on the 1st of each month"
        right={<button className="btn sm"><Icons.plus size={12}/> New Recurring</button>}
        pad={false}
      >
        <table className="tbl">
          <thead>
            <tr>
              <th>Expense Type</th>
              <th>Allocation</th>
              <th style={{ textAlign: "right" }}>Monthly</th>
              <th>Start</th>
              <th>End</th>
              <th>Status</th>
              <th style={{ width: 80 }}></th>
            </tr>
          </thead>
          <tbody>
            {recurring.map((r, i) => (
              <tr key={i}>
                <td style={{ fontWeight: 500 }}>{r.type}</td>
                <td style={{ fontSize: 12.5, color: "var(--t2)" }}>{r.alloc}</td>
                <td className="mono" style={{ textAlign: "right", fontWeight: 600 }}>${r.monthly.toLocaleString()}</td>
                <td className="mono" style={{ color: "var(--t2)" }}>{r.start}</td>
                <td className="mono" style={{ color: "var(--t3)" }}>{r.end || "—"}</td>
                <td><Pill tone="ok" dot>Active</Pill></td>
                <td style={{ textAlign: "right" }}>
                  <button className="btn ghost icon"><Icons.edit size={13}/></button>
                  <button className="btn ghost icon"><Icons.trash size={13}/></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

function FuelUploadForm({ onClose }) {
  const [file, setFile] = useState(null);
  const [stage, setStage] = useState("idle"); // idle | parsing | preview

  return (
    <div style={{ padding: 22, display: "flex", flexDirection: "column", gap: 18, flex: 1 }}>
      <div style={{ fontSize: 12.5, color: "var(--t2)", lineHeight: 1.6 }}>
        Upload a .txt fuel transaction report from EFS. Records are deduplicated by transaction ID before insert.
      </div>

      <div style={{
        border: "2px dashed " + (file ? "var(--blue)" : "var(--line-strong)"),
        borderRadius: 12,
        padding: 32,
        textAlign: "center",
        background: file ? "var(--blue-bg)" : "var(--bg-2)",
        transition: "all 0.2s",
        cursor: "pointer",
      }}
      onClick={() => setFile({ name: "EFS_TRANS_2026-05-20.txt", size: 142318 })}>
        <Icons.upload size={28} stroke="var(--t3)" style={{ marginBottom: 12 }}/>
        {file ? (
          <>
            <div style={{ fontSize: 14, fontWeight: 500, color: "var(--t1)", marginBottom: 4 }}>{file.name}</div>
            <div style={{ fontSize: 12, color: "var(--t3)" }} className="mono">{(file.size / 1024).toFixed(1)} KB · ready to parse</div>
          </>
        ) : (
          <>
            <div style={{ fontSize: 14, fontWeight: 500, color: "var(--t1)", marginBottom: 4 }}>Drop EFS report here</div>
            <div style={{ fontSize: 12, color: "var(--t3)" }}>or click to browse — .txt only</div>
          </>
        )}
      </div>

      {file && (
        <div className="card card-pad" style={{ background: "var(--bg-2)" }}>
          <div className="eyebrow" style={{ marginBottom: 10 }}>Preview · 12 new transactions detected</div>
          <table className="tbl" style={{ fontSize: 11.5 }}>
            <thead><tr><th>Truck</th><th>Date</th><th>Gallons</th><th style={{textAlign:"right"}}>Amount</th></tr></thead>
            <tbody>
              <tr><td className="mono">#009</td><td className="mono">2026-05-19</td><td className="mono">82.4</td><td className="mono" style={{textAlign:"right"}}>$430.13</td></tr>
              <tr><td className="mono">#299</td><td className="mono">2026-05-19</td><td className="mono">76.1</td><td className="mono" style={{textAlign:"right"}}>$397.24</td></tr>
              <tr><td className="mono">#530</td><td className="mono">2026-05-20</td><td className="mono">91.2</td><td className="mono" style={{textAlign:"right"}}>$476.06</td></tr>
              <tr><td colSpan={4} style={{ textAlign: "center", color: "var(--t3)", fontSize: 11 }}>+9 more rows…</td></tr>
            </tbody>
          </table>
        </div>
      )}

      <div style={{ marginTop: "auto", paddingTop: 20, borderTop: "1px solid var(--line)", display: "flex", justifyContent: "flex-end", gap: 10 }}>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={!file}>
          <Icons.check size={14}/> Import {file ? "12 transactions" : ""}
        </button>
      </div>
    </div>
  );
}

window.PageExpenses = PageExpenses;
