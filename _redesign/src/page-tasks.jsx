// Tasks page — open intake items grouped by assignee.

function PageTasks() {
  const tasks = INTAKE_ACTIVE;
  const groups = { Dennis: tasks, Arcie: [], Ryne: [], Jason: [] };

  return (
    <div className="anim-in">
      <PageHeader
        title="Tasks"
        sub="Open intake items requiring action · grouped by assignee"
        right={
          <>
            <button className="btn"><Icons.filter size={14}/> Filter</button>
            <button className="btn"><Icons.refresh size={14}/> Refresh</button>
          </>
        }
      />

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14, marginBottom: 20 }}>
        {[
          { label: "Total Open", value: 4, color: "#1ea8f3" },
          { label: "Unassigned", value: 0, color: "#f59e0b" },
          { label: "Overdue", value: 1, color: "#ef4444" },
          { label: "Closed Today", value: 12, color: "#22c55e" },
        ].map((k, i) => (
          <div key={i} className="card card-pad">
            <div className="eyebrow">{k.label}</div>
            <div style={{ fontSize: 28, fontWeight: 600, marginTop: 6, color: k.color, letterSpacing: "-0.02em" }} className="tnum">{k.value}</div>
          </div>
        ))}
      </div>

      {Object.entries(groups).map(([name, list]) => (
        <div key={name} style={{ marginBottom: 22 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
            <Avatar id={name[0]} color={name === "Dennis" ? "#a78bfa" : name === "Arcie" ? "#22c55e" : name === "Ryne" ? "#1ea8f3" : "#f59e0b"} size="md"/>
            <div style={{ fontSize: 15, fontWeight: 600 }}>{name}</div>
            <Pill tone="neutral">{list.length}</Pill>
          </div>
          {list.length === 0 ? (
            <div className="card card-pad" style={{ color: "var(--t3)", fontSize: 13, textAlign: "center", padding: "24px 22px" }}>
              <Icons.check size={20} stroke="var(--t4)"/>
              <div style={{ marginTop: 6 }}>All clear · no open tasks</div>
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14 }}>
              {list.map((t, i) => (
                <div key={i} className="card card-pad" style={{ display: "flex", flexDirection: "column", gap: 12, position: "relative" }}>
                  {t.isNew && (
                    <span style={{ position: "absolute", top: 16, right: 16 }}>
                      <Pill tone="blue" dot pulse>NEW</Pill>
                    </span>
                  )}
                  <div style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.3, paddingRight: 50 }}>{t.subject}</div>
                  <div style={{ display: "flex", gap: 8, fontSize: 11, color: "var(--t3)", flexWrap: "wrap", alignItems: "center" }}>
                    <span>{t.age}</span>
                    <span style={{ width: 3, height: 3, background: "var(--t4)", borderRadius: "50%" }}/>
                    <Icons.msg size={11}/> Slack
                    <span style={{ width: 3, height: 3, background: "var(--t4)", borderRadius: "50%" }}/>
                    <Icons.ext size={11}/> View
                  </div>
                  <div style={{ fontSize: 11.5, color: "var(--t3)", lineHeight: 1.5,
                                display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                    {t.body}
                  </div>
                  <div style={{ display: "flex", gap: 6, marginTop: "auto" }}>
                    <button className="btn primary sm" style={{ flex: 1 }}><Icons.plus size={12}/> Build Load</button>
                    <button className="btn sm"><Icons.pulse size={12}/></button>
                    <button className="btn sm icon"><Icons.trash size={12}/></button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

window.PageTasks = PageTasks;
