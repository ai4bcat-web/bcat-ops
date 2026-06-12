// Login page — standalone (no sidebar).

function PageLogin({ onLogin }) {
  const [step, setStep] = useState("login");
  const [email, setEmail] = useState("ryne@bcatcorp.com");
  const [pw, setPw] = useState("");
  const [showPw, setShowPw] = useState(false);

  return (
    <div style={{
      width: "100%",
      height: "100vh",
      background: "linear-gradient(135deg, #f4f7fb 0%, #e6f4fd 100%)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: 24,
      position: "relative",
      overflow: "hidden",
    }}>
      {/* decorative blobs */}
      <div style={{ position: "absolute", top: -120, left: -120, width: 400, height: 400, borderRadius: "50%", background: "rgba(30,168,243,0.18)", filter: "blur(100px)", pointerEvents: "none" }}/>
      <div style={{ position: "absolute", bottom: -160, right: -160, width: 460, height: 460, borderRadius: "50%", background: "rgba(124,58,237,0.15)", filter: "blur(120px)", pointerEvents: "none" }}/>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", maxWidth: 980, width: "100%", borderRadius: 24, overflow: "hidden", boxShadow: "0 20px 60px rgba(15,23,42,0.12), 0 6px 16px rgba(15,23,42,0.05)", background: "var(--bg-1)", border: "1px solid var(--line)", position: "relative", zIndex: 1 }}>
        {/* Left brand panel */}
        <div style={{
          background: "linear-gradient(160deg, #0a1422 0%, #0f1e33 40%, #0b8fd9 110%)",
          padding: "44px 40px",
          color: "white",
          display: "flex",
          flexDirection: "column",
          position: "relative",
          overflow: "hidden",
        }}>
          <div style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0, opacity: 0.05,
            backgroundImage: "linear-gradient(rgba(255,255,255,0.5) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.5) 1px, transparent 1px)",
            backgroundSize: "32px 32px", pointerEvents: "none"
          }}/>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 32, position: "relative" }}>
            <div style={{ width: 38, height: 38, borderRadius: 10, background: "rgba(255,255,255,0.12)", border: "1px solid rgba(255,255,255,0.2)", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                <path d="M5 4h7a4 4 0 0 1 0 8H5z M5 12h8a4 4 0 0 1 0 8H5z" fill="white"/>
                <path d="M16 4 Q21 8 21 14 T17 22" stroke="rgba(255,255,255,0.6)" strokeWidth="1.5" fill="none" strokeDasharray="2 2"/>
              </svg>
            </div>
            <div>
              <div style={{ fontSize: 16, fontWeight: 700, letterSpacing: "-0.01em" }}>BCAT <span style={{ color: "#60c5ff" }}>OPS</span></div>
              <div style={{ fontSize: 10, color: "rgba(255,255,255,0.5)", letterSpacing: "0.08em", textTransform: "uppercase", marginTop: 1 }}>Command Center</div>
            </div>
          </div>

          <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", position: "relative" }}>
            <div style={{ fontSize: 30, fontWeight: 600, letterSpacing: "-0.02em", lineHeight: 1.15, marginBottom: 14, textWrap: "pretty" }}>
              Every load.<br/>Every driver.<br/>Every dollar.
            </div>
            <div style={{ fontSize: 14, color: "rgba(255,255,255,0.7)", lineHeight: 1.6, maxWidth: 360 }}>
              The command center for BCAT Logistics — dispatch, intake, fleet compliance, and financials in one place.
            </div>

            <div style={{ marginTop: 36, display: "flex", flexDirection: "column", gap: 14 }}>
              {[
                { v: "44", l: "loads moved this month" },
                { v: "16", l: "trucks & trailers tracked" },
                { v: "92%", l: "on-time performance" },
              ].map((s, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 14 }}>
                  <div className="mono" style={{ fontSize: 24, fontWeight: 600, color: "#60c5ff", letterSpacing: "-0.02em", minWidth: 60 }}>{s.v}</div>
                  <div style={{ fontSize: 12.5, color: "rgba(255,255,255,0.65)" }}>{s.l}</div>
                </div>
              ))}
            </div>
          </div>

          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", position: "relative" }}>© 2026 BCAT Logistics</div>
        </div>

        {/* Right login form */}
        <div style={{ padding: "44px 44px", display: "flex", flexDirection: "column", justifyContent: "center" }}>
          <div style={{ fontSize: 22, fontWeight: 600, letterSpacing: "-0.02em", marginBottom: 6 }}>
            {step === "login" ? "Welcome back" : step === "newpw" ? "Set new password" : "Reset password"}
          </div>
          <div style={{ fontSize: 13.5, color: "var(--t3)", marginBottom: 28 }}>
            {step === "login" ? "Sign in to your BCAT Ops account" : step === "newpw" ? "Choose a password to finish your setup" : "We'll email you a reset link"}
          </div>

          <form onSubmit={(e) => { e.preventDefault(); onLogin && onLogin(); }} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <FieldGroup label="Email Address">
              <div style={{ position: "relative" }}>
                <Icons.mail size={14} style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", color: "var(--t4)" }}/>
                <input className="input" style={{ paddingLeft: 36 }} type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@bcatcorp.com"/>
              </div>
            </FieldGroup>

            {step !== "reset" && (
              <FieldGroup label={
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span>{step === "newpw" ? "New Password" : "Password"}</span>
                  {step === "login" && <a href="#" onClick={e => { e.preventDefault(); setStep("reset"); }} style={{ fontSize: 11.5, color: "var(--blue)", textTransform: "none", letterSpacing: 0 }}>Forgot?</a>}
                </div>
              }>
                <div style={{ position: "relative" }}>
                  <Icons.command size={14} style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", color: "var(--t4)" }}/>
                  <input className="input" style={{ paddingLeft: 36, paddingRight: 40 }} type={showPw ? "text" : "password"} value={pw} onChange={e => setPw(e.target.value)} placeholder="••••••••••••"/>
                  <button type="button" onClick={() => setShowPw(!showPw)} style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", color: "var(--t3)", cursor: "pointer", padding: 4 }}>
                    <Icons.eye size={14}/>
                  </button>
                </div>
              </FieldGroup>
            )}

            {step === "login" && (
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: "var(--t2)" }}>
                <input type="checkbox" defaultChecked style={{ accentColor: "var(--blue)" }}/>
                Keep me signed in on this device
              </label>
            )}

            <button type="submit" className="btn primary" style={{ width: "100%", justifyContent: "center", padding: "12px 18px", fontSize: 14, marginTop: 8 }}>
              {step === "login" ? "Sign in" : step === "newpw" ? "Set password" : "Send reset link"}
              <Icons.arrowR size={14}/>
            </button>

            {step !== "login" && (
              <button type="button" onClick={() => setStep("login")} style={{ background: "none", border: "none", color: "var(--blue)", fontSize: 13, cursor: "pointer", padding: 4 }}>
                ← Back to sign in
              </button>
            )}
          </form>

          <div style={{ marginTop: 32, paddingTop: 20, borderTop: "1px solid var(--line)", fontSize: 11.5, color: "var(--t3)", textAlign: "center" }}>
            Need access? Contact <a href="mailto:ryne@bcatcorp.com" style={{ color: "var(--blue)" }}>ryne@bcatcorp.com</a>
          </div>
        </div>
      </div>
    </div>
  );
}

window.PageLogin = PageLogin;
