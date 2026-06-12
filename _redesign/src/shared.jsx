// Shared building blocks: Avatar, Pill, Card, KPI card, charts.

const { useState, useMemo, useEffect, useRef } = React;

// ------- Avatar -------
function Avatar({ id, name, color, size = "md", pulse = false }) {
  const cls = size === "sm" ? "avatar sm" : size === "lg" ? "avatar lg" : "avatar";
  const initials = id || (name || "?").split(" ").map(s => s[0]).slice(0,2).join("").toUpperCase();
  return (
    <div style={{ position: "relative", display: "inline-block" }}>
      <div className={cls} style={{ background: color || "#444" }}>{initials}</div>
      {pulse && <span style={{
        position: "absolute", right: -1, bottom: -1, width: 8, height: 8, borderRadius: "50%",
        background: "var(--ok)", border: "2px solid var(--bg-1)"
      }}/>}
    </div>
  );
}

// ------- Pill / Status -------
function Pill({ tone = "neutral", children, dot, pulse, style }) {
  return (
    <span className={"pill " + tone} style={style}>
      {dot && <span className={"dot" + (pulse ? " pulse" : "")} />}
      {children}
    </span>
  );
}

function LoadStatusPill({ status }) {
  if (status === "ready") return <Pill tone="ok" dot>Ready</Pill>;
  if (status === "needs") return <Pill tone="warn" dot pulse>Needs Appt</Pill>;
  if (status === "open") return <Pill tone="blue" dot>In Progress</Pill>;
  if (status === "unassigned") return <Pill tone="warn">Unassigned</Pill>;
  if (status === "delivered") return <Pill tone="neutral">Delivered</Pill>;
  return <Pill tone="neutral">{status}</Pill>;
}

// ------- KPI card -------
function KPI({ label, value, sublabel, delta, deltaDir = "up", spark = null, sparkColor = "#1ea8f3", icon, accent }) {
  const deltaColor = deltaDir === "up" ? "#16a34a" : deltaDir === "down" ? "#dc2626" : "var(--t2)";
  return (
    <div className="card" style={{ position: "relative", overflow: "hidden" }}>
      {accent && (
        <div style={{
          position: "absolute", top: -40, right: -40, width: 140, height: 140,
          borderRadius: "50%", background: accent, filter: "blur(60px)", opacity: 0.18, pointerEvents: "none"
        }}/>
      )}
      <div className="card-pad" style={{ position: "relative" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
          <div className="eyebrow">{label}</div>
          {icon && (
            <div style={{ width: 30, height: 30, borderRadius: 8, background: "var(--bg-2)", border: "1px solid var(--line)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--t2)" }}>
              {icon}
            </div>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 4 }}>
          <div style={{ fontSize: 30, fontWeight: 600, letterSpacing: "-0.02em", lineHeight: 1.1, color: "var(--t1)" }} className="tnum">
            {value}
          </div>
          {delta != null && (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 12, color: deltaColor, fontWeight: 500 }} className="tnum">
              {deltaDir === "up" ? "▲" : deltaDir === "down" ? "▼" : ""} {delta}
            </span>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 10 }}>
          <div style={{ fontSize: 12, color: "var(--t3)" }}>{sublabel}</div>
          {spark && <Sparkline data={spark} color={sparkColor} width={84} height={28} />}
        </div>
      </div>
    </div>
  );
}

// ------- Sparkline -------
function Sparkline({ data, color = "#1ea8f3", width = 80, height = 28, fill = true }) {
  if (!data || data.length < 2) return null;
  const min = Math.min(...data), max = Math.max(...data);
  const range = max - min || 1;
  const stepX = width / (data.length - 1);
  const pts = data.map((v, i) => [i * stepX, height - ((v - min) / range) * (height - 4) - 2]);
  const path = pts.map((p, i) => (i === 0 ? "M" : "L") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
  const areaPath = path + ` L ${width} ${height} L 0 ${height} Z`;
  const gradId = "sg_" + Math.random().toString(36).slice(2,7);
  return (
    <svg width={width} height={height} style={{ display: "block" }}>
      {fill && (
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.32"/>
            <stop offset="100%" stopColor={color} stopOpacity="0"/>
          </linearGradient>
        </defs>
      )}
      {fill && <path d={areaPath} fill={`url(#${gradId})`} />}
      <path d={path} fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

// ------- Line chart -------
function LineChart({ series, labels, height = 280, yTicks = 5, yFmt = (v) => v, showLegend = true, smooth = true }) {
  const PAD = { top: 16, right: 16, bottom: 32, left: 56 };
  const [hover, setHover] = useState(null);
  const wrap = useRef(null);
  const [w, setW] = useState(800);
  useEffect(() => {
    const ro = new ResizeObserver(e => setW(e[0].contentRect.width));
    if (wrap.current) ro.observe(wrap.current);
    return () => ro.disconnect();
  }, []);
  const innerW = w - PAD.left - PAD.right;
  const innerH = height - PAD.top - PAD.bottom;

  const all = series.flatMap(s => s.data);
  const min = Math.min(0, ...all);
  const max = Math.max(...all);
  const range = max - min || 1;
  const xCount = labels.length;
  const xStep = xCount > 1 ? innerW / (xCount - 1) : innerW;
  const yScale = (v) => PAD.top + innerH - ((v - min) / range) * innerH;
  const xScale = (i) => PAD.left + i * xStep;

  const pathFor = (data) => {
    if (smooth) {
      // simple monotone cubic
      let d = "";
      for (let i = 0; i < data.length; i++) {
        const x = xScale(i), y = yScale(data[i]);
        if (i === 0) d += `M ${x} ${y}`;
        else {
          const xPrev = xScale(i-1), yPrev = yScale(data[i-1]);
          const cx1 = xPrev + (x - xPrev) * 0.5;
          const cx2 = x - (x - xPrev) * 0.5;
          d += ` C ${cx1} ${yPrev}, ${cx2} ${y}, ${x} ${y}`;
        }
      }
      return d;
    } else {
      return data.map((v, i) => (i ? "L" : "M") + xScale(i) + " " + yScale(v)).join(" ");
    }
  };

  const ticks = Array.from({ length: yTicks + 1 }, (_, i) => min + (range * i / yTicks));

  return (
    <div ref={wrap} style={{ width: "100%" }}>
      <svg width={w} height={height} style={{ display: "block", overflow: "visible" }}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const x = e.clientX - rect.left - PAD.left;
          const i = Math.max(0, Math.min(xCount - 1, Math.round(x / xStep)));
          setHover(i);
        }}>
        {/* grid */}
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={PAD.left} x2={w - PAD.right} y1={yScale(t)} y2={yScale(t)} stroke="rgba(15,23,42,0.06)" strokeDasharray={i === 0 ? "" : "3 4"}/>
            <text x={PAD.left - 10} y={yScale(t) + 4} fill="var(--t3)" fontSize="10.5" textAnchor="end" fontFamily="Geist Mono">{yFmt(Math.round(t * 100) / 100)}</text>
          </g>
        ))}
        {/* x labels */}
        {labels.map((l, i) => (
          (i % Math.max(1, Math.floor(xCount / 8)) === 0 || i === xCount - 1) && (
            <text key={i} x={xScale(i)} y={height - 8} fill="var(--t3)" fontSize="10.5" textAnchor="middle" fontFamily="Geist Mono">{l}</text>
          )
        ))}
        {/* series */}
        {series.map((s, si) => {
          const d = pathFor(s.data);
          const gradId = "lg_" + si + "_" + Math.random().toString(36).slice(2,5);
          return (
            <g key={si}>
              <defs>
                <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={s.color} stopOpacity="0.22"/>
                  <stop offset="100%" stopColor={s.color} stopOpacity="0"/>
                </linearGradient>
              </defs>
              {s.fill !== false && <path d={d + ` L ${xScale(xCount - 1)} ${PAD.top + innerH} L ${xScale(0)} ${PAD.top + innerH} Z`} fill={`url(#${gradId})`}/>}
              <path d={d} fill="none" stroke={s.color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </g>
          );
        })}
        {/* hover */}
        {hover != null && (
          <g>
            <line x1={xScale(hover)} x2={xScale(hover)} y1={PAD.top} y2={PAD.top + innerH} stroke="rgba(15,23,42,0.2)"/>
            {series.map((s, si) => (
              <circle key={si} cx={xScale(hover)} cy={yScale(s.data[hover])} r="4" fill="var(--bg-0)" stroke={s.color} strokeWidth="2"/>
            ))}
          </g>
        )}
      </svg>
      {hover != null && (
        <div style={{ position: "absolute" }}>
          {/* tooltip rendered as plain element below for layout simplicity */}
        </div>
      )}
      {showLegend && (
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginTop: 8, paddingLeft: PAD.left }}>
          {series.map((s, si) => (
            <div key={si} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--t2)" }}>
              <span style={{ width: 10, height: 2, background: s.color, borderRadius: 1 }}/>
              <span className="mono">{s.name}</span>
              {hover != null && (
                <span className="mono" style={{ color: "var(--t1)" }}>{yFmt(s.data[hover])}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ------- Bar chart (vertical) -------
function BarChart({ data, height = 240, color = "#1ea8f3", yFmt = (v) => v, showValues = false }) {
  const PAD = { top: 12, right: 8, bottom: 28, left: 36 };
  const wrap = useRef(null);
  const [w, setW] = useState(800);
  useEffect(() => {
    const ro = new ResizeObserver(e => setW(e[0].contentRect.width));
    if (wrap.current) ro.observe(wrap.current);
    return () => ro.disconnect();
  }, []);
  const innerW = w - PAD.left - PAD.right;
  const innerH = height - PAD.top - PAD.bottom;
  const max = Math.max(...data.map(d => d.v), 1);
  const xStep = innerW / data.length;
  const barW = Math.max(6, Math.min(28, xStep * 0.55));

  return (
    <div ref={wrap} style={{ width: "100%" }}>
      <svg width={w} height={height} style={{ display: "block" }}>
        {/* grid */}
        {[0, 0.25, 0.5, 0.75, 1].map((t, i) => (
          <g key={i}>
            <line x1={PAD.left} x2={w - PAD.right} y1={PAD.top + innerH * (1 - t)} y2={PAD.top + innerH * (1 - t)} stroke="rgba(15,23,42,0.06)" strokeDasharray={i === 0 ? "" : "3 4"}/>
            <text x={PAD.left - 8} y={PAD.top + innerH * (1 - t) + 4} fill="var(--t3)" fontSize="10.5" textAnchor="end" fontFamily="Geist Mono">{yFmt(Math.round(max * t))}</text>
          </g>
        ))}
        <defs>
          <linearGradient id="barg" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="1"/>
            <stop offset="100%" stopColor={color} stopOpacity="0.5"/>
          </linearGradient>
        </defs>
        {data.map((d, i) => {
          const h = (d.v / max) * innerH;
          const x = PAD.left + i * xStep + (xStep - barW) / 2;
          const y = PAD.top + innerH - h;
          return (
            <g key={i}>
              <rect x={x} y={y} width={barW} height={h} fill="url(#barg)" rx={3} />
              {showValues && d.v > 0 && (
                <text x={x + barW/2} y={y - 6} fill="var(--t2)" fontSize="10" textAnchor="middle" fontFamily="Geist Mono">{d.v}</text>
              )}
              {(i % Math.max(1, Math.floor(data.length / 7)) === 0) && (
                <text x={x + barW/2} y={height - 8} fill="var(--t3)" fontSize="10" textAnchor="middle" fontFamily="Geist Mono">{d.d}</text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ------- Horizontal bar (for Loads per Driver) -------
function HBarChart({ data, height = 240, valueFmt = (v) => v }) {
  const max = Math.max(...data.map(d => d.v), 1);
  const rowH = Math.max(28, Math.floor(height / Math.max(data.length, 1)));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {data.map((d, i) => {
        const pct = (d.v / max) * 100;
        return (
          <div key={i} style={{ display: "grid", gridTemplateColumns: "92px 1fr 36px", alignItems: "center", gap: 12 }}>
            <div style={{ fontSize: 12, color: "var(--t2)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{d.label}</div>
            <div style={{ position: "relative", height: 18, background: "rgba(15,23,42,0.04)", borderRadius: 4, overflow: "hidden" }}>
              <div style={{
                position: "absolute", left: 0, top: 0, bottom: 0, width: pct + "%",
                background: `linear-gradient(90deg, ${d.color} 0%, ${d.color}cc 100%)`,
                borderRadius: 4,
                boxShadow: `0 0 16px ${d.color}40`,
                transition: "width 0.6s cubic-bezier(0.2,0.7,0.3,1)"
              }}/>
            </div>
            <div className="mono" style={{ fontSize: 12, color: "var(--t1)", textAlign: "right", fontWeight: 500 }}>{valueFmt(d.v)}</div>
          </div>
        );
      })}
    </div>
  );
}

// ------- Donut chart -------
function Donut({ data, size = 140, thickness = 16, centerLabel, centerValue }) {
  const total = data.reduce((s, d) => s + d.v, 0) || 1;
  const r = size / 2 - thickness / 2;
  const C = 2 * Math.PI * r;
  let offset = 0;
  return (
    <div style={{ position: "relative", width: size, height: size }}>
      <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="rgba(15,23,42,0.06)" strokeWidth={thickness}/>
        {data.map((d, i) => {
          const len = (d.v / total) * C;
          const el = (
            <circle key={i} cx={size/2} cy={size/2} r={r} fill="none" stroke={d.color}
              strokeWidth={thickness} strokeDasharray={`${len} ${C - len}`} strokeDashoffset={-offset}
              strokeLinecap="butt"/>
          );
          offset += len;
          return el;
        })}
      </svg>
      <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
        <div style={{ fontSize: 22, fontWeight: 600, color: "var(--t1)", letterSpacing: "-0.02em" }} className="tnum">{centerValue}</div>
        <div style={{ fontSize: 11, color: "var(--t3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>{centerLabel}</div>
      </div>
    </div>
  );
}

// ------- Section header -------
function SectionHeader({ title, sub, right }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", marginBottom: 18, gap: 16 }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 24, fontWeight: 600, letterSpacing: "-0.02em" }}>{title}</h1>
        {sub && <div style={{ marginTop: 4, fontSize: 13, color: "var(--t3)" }}>{sub}</div>}
      </div>
      {right && <div>{right}</div>}
    </div>
  );
}

// ------- Page header (within content) -------
function PageHeader({ title, sub, right }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", marginBottom: 24, gap: 16, flexWrap: "wrap" }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 26, fontWeight: 600, letterSpacing: "-0.025em" }}>{title}</h1>
        {sub && <div style={{ marginTop: 5, fontSize: 13.5, color: "var(--t3)" }}>{sub}</div>}
      </div>
      {right && <div style={{ display: "flex", gap: 10, alignItems: "center" }}>{right}</div>}
    </div>
  );
}

// ------- Card primitive -------
function Card({ title, sub, right, children, pad = true, className = "", style = {} }) {
  return (
    <div className={"card " + className} style={style}>
      {(title || right) && (
        <div className="card-header">
          <div>
            <div className="h-title-lg">{title}</div>
            {sub && <div style={{ fontSize: 12, color: "var(--t3)", marginTop: 2 }}>{sub}</div>}
          </div>
          {right}
        </div>
      )}
      <div className={pad ? "card-pad" : ""}>{children}</div>
    </div>
  );
}

// ------- Drawer (right-side) -------
function Drawer({ open, onClose, title, children, width = 480 }) {
  return (
    <>
      <div className={"drawer-overlay" + (open ? " open" : "")} onClick={onClose}/>
      <div className={"drawer" + (open ? " open" : "")} style={{ width }}>
        <div style={{ padding: "18px 22px", borderBottom: "1px solid var(--line)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ fontSize: 15, fontWeight: 600 }}>{title}</div>
          <button className="btn ghost icon" onClick={onClose}><Icons.x size={16}/></button>
        </div>
        <div style={{ flex: 1, overflowY: "auto" }}>{children}</div>
      </div>
    </>
  );
}

// ------- Mini route line (used in load rows) -------
function RouteLine({ from, to }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--t1)", fontSize: 13 }}>
      <span>{from}</span>
      <svg width="14" height="6"><path d="M0 3 L12 3 M9 0 L13 3 L9 6" stroke="var(--t3)" strokeWidth="1.2" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>
      <span>{to}</span>
    </div>
  );
}

window.Avatar = Avatar;
window.Pill = Pill;
window.LoadStatusPill = LoadStatusPill;
window.KPI = KPI;
window.Sparkline = Sparkline;
window.LineChart = LineChart;
window.BarChart = BarChart;
window.HBarChart = HBarChart;
window.Donut = Donut;
window.SectionHeader = SectionHeader;
window.PageHeader = PageHeader;
window.Card = Card;
window.Drawer = Drawer;
window.RouteLine = RouteLine;
