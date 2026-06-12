// User Management page.

function PageUsers() {
  const users = [
    { name: "Ryne Bandolik", email: "ryne@bcatcorp.com",   role: "Owner",      status: "active", color: "#1ea8f3", lastSeen: "now" },
    { name: "Dennis Park",   email: "dennis@bcatcorp.com", role: "Dispatcher", status: "active", color: "#a78bfa", lastSeen: "2m ago" },
    { name: "Jason Wright",  email: "jason@bcatcorp.com",  role: "Fleet Mgr",  status: "active", color: "#f59e0b", lastSeen: "4h ago" },
    { name: "Arcie Lopez",   email: "arcie@bcatcorp.com",  role: "Dispatcher", status: "active", color: "#22c55e", lastSeen: "Yesterday" },
  ];
  const roleTone = { Owner: "blue", Dispatcher: "violet", "Fleet Mgr": "warn", Driver: "neutral" };

  return (
    <div className="anim-in">
      <PageHeader
        title="User Management"
        sub="Workspace members · roles · access"
        right={
          <>
            <button className="btn"><Icons.download size={14}/> Export</button>
            <button className="btn primary"><Icons.plus size={14}/> Invite User</button>
          </>
        }
      />

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 18 }}>
        {[
          { label: "Total Users", value: 4, color: "#1ea8f3" },
          { label: "Active", value: 4, color: "#22c55e" },
          { label: "Invite Pending", value: 0, color: "#f59e0b" },
          { label: "Disabled", value: 0, color: "var(--t3)" },
        ].map((k, i) => (
          <div key={i} className="card card-pad">
            <div className="eyebrow">{k.label}</div>
            <div style={{ fontSize: 28, fontWeight: 600, marginTop: 4, color: k.color, letterSpacing: "-0.02em" }} className="tnum">{k.value}</div>
          </div>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1.6fr", gap: 16 }}>
        {/* Invite */}
        <Card title="Invite New User" sub="They'll receive an email with a temporary password.">
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <FieldGroup label="Email Address">
              <input className="input" placeholder="driver@bcatcorp.com"/>
            </FieldGroup>
            <FieldGroup label="Role">
              <select className="input">
                <option>Dispatcher</option>
                <option>Fleet Manager</option>
                <option>Driver</option>
                <option>Owner</option>
              </select>
            </FieldGroup>
            <FieldGroup label="Permissions">
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {["View loads", "Edit loads", "Manage drivers", "Manage fleet", "View financials", "Manage users"].map((p, i) => (
                  <label key={i} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12.5, color: "var(--t2)" }}>
                    <input type="checkbox" defaultChecked={i < 3} style={{ accentColor: "var(--blue)" }}/>
                    {p}
                  </label>
                ))}
              </div>
            </FieldGroup>
            <button className="btn primary" style={{ marginTop: 8 }}><Icons.plus size={14}/> Send Invite</button>
          </div>
        </Card>

        {/* Users list */}
        <Card title="All Users" sub={users.length + " active members"} pad={false}>
          <table className="tbl">
            <thead>
              <tr>
                <th>User</th>
                <th>Role</th>
                <th>Status</th>
                <th>Last Active</th>
                <th style={{ width: 60 }}></th>
              </tr>
            </thead>
            <tbody>
              {users.map((u, i) => (
                <tr key={i}>
                  <td>
                    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                      <Avatar id={u.name.split(" ").map(s => s[0]).join("")} color={u.color} pulse={u.lastSeen === "now"}/>
                      <div>
                        <div style={{ fontWeight: 500 }}>{u.name}</div>
                        <div style={{ fontSize: 11.5, color: "var(--t3)" }}>{u.email}</div>
                      </div>
                    </div>
                  </td>
                  <td><Pill tone={roleTone[u.role]}>{u.role}</Pill></td>
                  <td><Pill tone="ok" dot>Active</Pill></td>
                  <td style={{ fontSize: 12.5, color: "var(--t2)" }}>{u.lastSeen}</td>
                  <td><button className="btn ghost icon"><Icons.more size={14}/></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>
    </div>
  );
}

window.PageUsers = PageUsers;
