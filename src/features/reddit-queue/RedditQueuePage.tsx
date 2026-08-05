import { useEffect, useState } from "react";
import { ExternalLink, Copy, CheckCircle2, XCircle, MessageSquare } from "lucide-react";

// API base — uses VITE_COMMAND_CENTER_URL if set, otherwise same-origin relative.
// In production (ops.bcatcorp.com via Amplify), API must be on same origin.
const CC_URL = import.meta.env.VITE_COMMAND_CENTER_URL || "";

type RedditDraft = {
  id: string;
  createdAt: string;
  subreddit: string;
  title: string;
  threadUrl: string;
  response: string;
  business: "jobsdone" | "bestcare";
  status: "pending" | "posted" | "skipped";
  why: string;
};

type Tab = "pending" | "posted" | "skipped";

const BUSINESS_LABELS: Record<string, string> = {
  jobsdone: "JobsDone Labs",
  bestcare: "Best Care Auto",
};

export function RedditQueuePage() {
  const [drafts, setDrafts] = useState<RedditDraft[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("pending");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());

  const load = async () => {
    setLoading(true);
    try {
      const statusFilter = tab === "pending" ? "pending" : undefined;
      const url = statusFilter
        ? `${CC_URL}/api/reddit-queue?status=${statusFilter}`
        : `${CC_URL}/api/reddit-queue`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`API ${res.status}`);
      const data: RedditDraft[] = await res.json();
      setDrafts(data.filter((d) => (tab === "pending" ? true : d.status === tab)));
      setError(null);
    } catch (e: any) {
      setError(e.message || "Failed to load");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [tab]);

  const markStatus = async (id: string, status: "posted" | "skipped") => {
    setPendingIds((prev) => new Set(prev).add(id));
    try {
      await fetch(`${CC_URL}/api/reddit-queue/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      setDrafts((prev) => prev.filter((d) => d.id !== id));
    } catch (e: any) {
      setError(e.message || "Failed to update");
    } finally {
      setPendingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const copyResponse = async (draft: RedditDraft) => {
    try {
      await navigator.clipboard.writeText(draft.response);
      setCopiedId(draft.id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      const el = document.getElementById(`rd-response-${draft.id}`);
      if (el) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
    }
  };

  const pendingCount = tab === "pending" ? drafts.length : 0;

  return (
    <div className="reddit-queue-page" style={{ padding: 24, maxWidth: 900 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20 }}>
        <MessageSquare size={22} style={{ color: "var(--ds-blue)" }} />
        <h1 style={{ fontSize: 20, fontWeight: 700, color: "var(--ds-t1)", margin: 0 }}>
          Reddit Queue{pendingCount > 0 && ` (${pendingCount})`}
        </h1>
      </div>

      <p style={{ fontSize: 13, color: "var(--ds-t3)", margin: "0 0 20px" }}>
        Drafts from the Reddit monitors. Click <strong>Copy &amp; Open Reddit</strong>, paste, hit Reply, then mark posted.
      </p>

      {/* Tabs */}
      <div style={{ display: "flex", gap: 0, marginBottom: 20, borderBottom: "1px solid var(--ds-border)" }}>
        {(["pending", "posted", "skipped"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              padding: "8px 16px",
              fontSize: 13,
              fontWeight: 600,
              background: "transparent",
              border: "none",
              borderBottom: tab === t ? "2px solid var(--ds-blue)" : "2px solid transparent",
              color: tab === t ? "var(--ds-blue)" : "var(--ds-t3)",
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {error && (
        <div style={{
          padding: "10px 14px", borderRadius: 8, marginBottom: 16,
          background: "var(--ds-red-soft)", color: "#dc2626", fontSize: 13,
          border: "1px solid rgba(220,38,38,0.15)",
        }}>
          {error}
        </div>
      )}

      {loading ? (
        <p style={{ fontSize: 13, color: "var(--ds-t3)" }}>Loading...</p>
      ) : drafts.length === 0 ? (
        <div style={{
          padding: "32px 16px", textAlign: "center", borderRadius: 8,
          background: "var(--ds-surface2)", fontSize: 13, color: "var(--ds-t3)",
        }}>
          {tab === "pending"
            ? "No drafts waiting. Reddit monitors run at 8 AM and 4 PM daily."
            : `No ${tab} items yet.`}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {drafts.map((draft) => (
            <div
              key={draft.id}
              style={{
                border: "1px solid var(--ds-border)",
                borderRadius: 10,
                padding: 16,
                background: "var(--ds-surface1)",
              }}
            >
              {/* Header */}
              <div style={{ marginBottom: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                  <span style={{
                    fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 4,
                    background: "var(--ds-blue-soft)", color: "#0369a1",
                  }}>
                    r/{draft.subreddit}
                  </span>
                  <span style={{ fontSize: 11, color: "var(--ds-t3)" }}>
                    {BUSINESS_LABELS[draft.business] || draft.business}
                  </span>
                </div>
                <h3 style={{ fontSize: 14, fontWeight: 600, color: "var(--ds-t1)", margin: 0 }}>
                  {draft.title}
                </h3>
                {draft.why && (
                  <p style={{ fontSize: 12, color: "var(--ds-t3)", margin: "4px 0 0" }}>
                    {draft.why}
                  </p>
                )}
              </div>

              {/* Response */}
              <div
                id={`rd-response-${draft.id}`}
                style={{
                  fontSize: 13, lineHeight: 1.6, color: "var(--ds-t2)",
                  background: "var(--ds-surface2)", borderRadius: 8, padding: 12,
                  marginBottom: 12, maxHeight: 200, overflowY: "auto",
                  whiteSpace: "pre-wrap", fontFamily: "var(--font-sans)",
                }}
              >
                {draft.response}
              </div>

              {/* Actions */}
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <button
                  onClick={() => copyResponse(draft)}
                  style={{
                    display: "inline-flex", alignItems: "center", gap: 6,
                    padding: "6px 12px", fontSize: 12, fontWeight: 500,
                    borderRadius: 6, border: "1px solid var(--ds-border)",
                    background: "var(--ds-surface1)", color: "var(--ds-t2)",
                    cursor: "pointer", fontFamily: "inherit",
                  }}
                >
                  {copiedId === draft.id ? (
                    <><CheckCircle2 size={14} color="#16a34a" /> Copied!</>
                  ) : (
                    <><Copy size={14} /> Copy response</>
                  )}
                </button>

                <a
                  href={draft.threadUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => copyResponse(draft)}
                  style={{
                    display: "inline-flex", alignItems: "center", gap: 6,
                    padding: "6px 12px", fontSize: 12, fontWeight: 600,
                    borderRadius: 6, background: "var(--ds-blue)", color: "#fff",
                    textDecoration: "none", fontFamily: "inherit",
                  }}
                >
                  <ExternalLink size={14} />
                  Copy &amp; Open Reddit
                </a>

                {draft.status === "pending" && (
                  <>
                    <div style={{ flex: 1 }} />
                    <button
                      onClick={() => markStatus(draft.id, "posted")}
                      disabled={pendingIds.has(draft.id)}
                      style={{
                        display: "inline-flex", alignItems: "center", gap: 4,
                        padding: "6px 12px", fontSize: 12, fontWeight: 600,
                        borderRadius: 6, background: "#16a34a", color: "#fff",
                        border: "none", cursor: "pointer", fontFamily: "inherit",
                        opacity: pendingIds.has(draft.id) ? 0.5 : 1,
                      }}
                    >
                      <CheckCircle2 size={14} />
                      Mark Posted
                    </button>
                    <button
                      onClick={() => markStatus(draft.id, "skipped")}
                      disabled={pendingIds.has(draft.id)}
                      style={{
                        display: "inline-flex", alignItems: "center", gap: 4,
                        padding: "6px 12px", fontSize: 12, fontWeight: 500,
                        borderRadius: 6, border: "1px solid var(--ds-border)",
                        background: "var(--ds-surface1)", color: "var(--ds-t3)",
                        cursor: "pointer", fontFamily: "inherit",
                        opacity: pendingIds.has(draft.id) ? 0.5 : 1,
                      }}
                    >
                      <XCircle size={14} />
                      Skip
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}