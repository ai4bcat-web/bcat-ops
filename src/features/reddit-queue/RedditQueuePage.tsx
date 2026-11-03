import { useEffect, useState } from "react";
import { ExternalLink, Copy, CheckCircle2, XCircle } from "lucide-react";
import { TmsScrollPage } from "@/features/tms/kit/TmsScrollPage";

const CC_URL = import.meta.env.VITE_COMMAND_CENTER_URL ?? "http://localhost:4501";

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
  // Derived: true until a fetch for the CURRENT tab has settled.
  const [loadedTab, setLoadedTab] = useState<Tab | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("pending");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    const statusFilter = tab === "pending" ? "pending" : undefined;
    const url = statusFilter
      ? `${CC_URL}/api/reddit-queue?status=${statusFilter}`
      : `${CC_URL}/api/reddit-queue`;
    fetch(url)
      .then(async (res) => {
        if (!res.ok) throw new Error(`API ${res.status}`);
        const data: RedditDraft[] = await res.json();
        setDrafts(data.filter((d) => (tab === "pending" ? true : d.status === tab)));
        setError(null);
      })
      .catch((e: unknown) => {
        setError(e instanceof Error && e.message ? e.message : "Failed to load");
      })
      .finally(() => setLoadedTab(tab));
  }, [tab]);
  const loading = loadedTab !== tab;

  const markStatus = async (id: string, status: "posted" | "skipped") => {
    setPendingIds((prev) => new Set(prev).add(id));
    try {
      await fetch(`${CC_URL}/api/reddit-queue/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      setDrafts((prev) => prev.filter((d) => d.id !== id));
    } catch (e: unknown) {
      setError(e instanceof Error && e.message ? e.message : "Failed to update");
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
    <TmsScrollPage
      className="reddit-queue-page"
      title={<>Reddit Queue{pendingCount > 0 && ` (${pendingCount})`}</>}
      subtitle={<>Drafts from the Reddit monitors. Click <strong>Copy &amp; Open Reddit</strong>, paste, hit Reply, then mark posted.</>}
    >
      <div style={{ maxWidth: 900 }}>

      {/* Tabs */}
      <div style={{ display: "flex", gap: 0, marginBottom: 20, borderBottom: "1px solid var(--tms-border)" }}>
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
              borderBottom: tab === t ? "2px solid var(--tms-primary)" : "2px solid transparent",
              color: tab === t ? "var(--tms-primary)" : "var(--tms-muted)",
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
          background: "var(--tms-badge-red-tint)", color: "var(--tms-badge-red)", fontSize: 13,
          border: "1px solid var(--tms-badge-red)",
        }}>
          {error}
        </div>
      )}

      {loading ? (
        <p style={{ fontSize: 13, color: "var(--tms-muted)" }}>Loading...</p>
      ) : drafts.length === 0 ? (
        <div style={{
          padding: "32px 16px", textAlign: "center", borderRadius: 8,
          background: "var(--tms-surface)", fontSize: 13, color: "var(--tms-muted)",
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
                border: "1px solid var(--tms-border)",
                borderRadius: 10,
                padding: 16,
                background: "var(--tms-card)",
              }}
            >
              {/* Header */}
              <div style={{ marginBottom: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                  <span style={{
                    fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 4,
                    background: "var(--tms-primary-tint)", color: "var(--tms-primary-ink)",
                  }}>
                    r/{draft.subreddit}
                  </span>
                  <span style={{ fontSize: 11, color: "var(--tms-muted)" }}>
                    {BUSINESS_LABELS[draft.business] || draft.business}
                  </span>
                </div>
                <h3 style={{ fontSize: 14, fontWeight: 600, color: "var(--tms-text)", margin: 0 }}>
                  {draft.title}
                </h3>
                {draft.why && (
                  <p style={{ fontSize: 12, color: "var(--tms-muted)", margin: "4px 0 0" }}>
                    {draft.why}
                  </p>
                )}
              </div>

              {/* Response */}
              <div
                id={`rd-response-${draft.id}`}
                style={{
                  fontSize: 13, lineHeight: 1.6, color: "var(--tms-text-2)",
                  background: "var(--tms-surface)", borderRadius: 8, padding: 12,
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
                    borderRadius: 6, border: "1px solid var(--tms-border)",
                    background: "var(--tms-card)", color: "var(--tms-text-2)",
                    cursor: "pointer", fontFamily: "inherit",
                  }}
                >
                  {copiedId === draft.id ? (
                    <><CheckCircle2 size={14} color="var(--tms-badge-green)" /> Copied!</>
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
                    borderRadius: 6, background: "var(--tms-primary)", color: "var(--tms-on-primary)",
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
                        borderRadius: 6, background: "var(--tms-badge-green)", color: "var(--tms-on-primary)",
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
                        borderRadius: 6, border: "1px solid var(--tms-border)",
                        background: "var(--tms-card)", color: "var(--tms-muted)",
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
    </TmsScrollPage>
  );
}