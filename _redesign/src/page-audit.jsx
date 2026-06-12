// Audit Log page.

function PageAudit() {
  const actionTone = { Update: "blue", Create: "ok", Delete: "bad" };

  return (
    <div className="anim-in">
      <PageHeader
        title="Audit Log"
        sub="252 entries · most recent first · system-wide activity"
        right={
          <>
            <button className="btn"><Icons.filter size={14}/> Filter</button>
            <button className="btn"><Icons.download size={14}/> Export</button>
          </>
        }
      />

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 18 }}>
        {[
          { label: "Total Events (7d)", value: 252, color: "#1ea8f3" },
          { label: "Updates", value: 198, color: "#0369a1" },
          { label: "Creates", value: 47, color: "#22c55e" },
          { label: "Deletes", value: 7, color: "#ef4444" },
        ].map((k, i) => (
          <div key={i} className="card card-pad">
            <div className="eyebrow">{k.label}</div>
            <div style={{ fontSize: 26, fontWeight: 600, marginTop: 4, color: k.color, letterSpacing: "-0.02em" }} className="tnum">{k.value}</div>
          </div>
        ))}
      </div>

      <Card pad={false}>
        <table className="tbl zebra">
          <thead>
            <tr>
              <th>Time</th>
              <th>Action</th>
              <th>Entity</th>
              <th>ID</th>
              <th>User</th>
              <th style={{ textAlign: "right" }}>Changes</th>
              <th style={{ width: 60 }}></th>
            </tr>
          </thead>
          <tbody>
            {AUDIT.map((a, i) => (
              <tr key={i}>
                <td className="mono" style={{ fontSize: 12, color: "var(--t2)" }}>{a.when}</td>
                <td><Pill tone={actionTone[a.action]}>{a.action}</Pill></td>
                <td>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5 }}>
                    {a.entity === "Load" ? <Icons.box size={12} stroke="var(--t3)"/> : <Icons.drivers size={12} stroke="var(--t3)"/>}
                    {a.entity}
                  </span>
                </td>
                <td className="mono" style={{ color: "var(--t3)", fontSize: 12 }}>{a.id}</td>
                <td>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <Avatar id={a.user[0].toUpperCase()} color={a.user.includes("ryne") ? "#1ea8f3" : "#a78bfa"} size="sm"/>
                    <span style={{ fontSize: 12.5, color: "var(--t2)" }}>{a.user}</span>
                  </div>
                </td>
                <td className="mono" style={{ textAlign: "right", color: "var(--t2)" }}>{a.fields} field{a.fields > 1 ? "s" : ""}</td>
                <td><button className="btn ghost icon"><Icons.chevR size={12}/></button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

window.PageAudit = PageAudit;
