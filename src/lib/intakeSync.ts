// Intake → Command Center sync (Phase 6 producer side).
//
// bcat-ops owns the legacy intake queue; the Group Command Center is the
// unified task queue. This module polls IntakeItems and pushes any not-yet-
// synced ones to the command center as Tasks, following the Phase 6 field
// mapping. It tracks what it has already synced so re-polling doesn't create
// duplicates.
//
// The command center now also dedupes on `externalId` (a re-POST of the same
// externalId returns the existing Task with 200, not a new one), so this is
// belt-and-suspenders: the local ledger avoids the redundant network call, and
// the server guards against any gap in the ledger.
//
// Usage (e.g. from a background effect or an admin action):
//
//     import { startIntakeSync } from '@/lib/intakeSync'
//     const stop = startIntakeSync()   // polls every 30s; call stop() to halt
//
// or one-shot:
//
//     import { syncIntakeOnce } from '@/lib/intakeSync'
//     const { created, skipped } = await syncIntakeOnce()

import { listIntakeItems } from '@/lib/apiClient';
import { createTask, type CreateTaskInput } from '@/lib/commandCenterClient';
import type { IntakeItem, IntakeStatus } from '@/types';

const POLL_MS = 30_000;
const LEDGER_KEY = 'commandCenter:syncedIntakeIds';

// All bcat-ops intake belongs to the `bcat` business in the command center.
const BUSINESS = 'bcat';
const EXTERNAL_SOURCE = 'bcat-ops';

// IntakeStatus → command-center Task status. The intake enum is already
// upper-cased; BUILT/ARCHIVED have no direct Task equivalent, so we fold them
// onto the nearest lifecycle state.
const STATUS_MAP: Record<IntakeStatus, string> = {
  NEW: 'NEW',
  IN_PROGRESS: 'IN_PROGRESS',
  BUILT: 'IN_PROGRESS',
  DONE: 'DONE',
  ARCHIVED: 'DONE',
};

// --- Synced-id ledger -------------------------------------------------------
// Persisted in localStorage when available (browser), otherwise an in-memory
// Set for non-DOM contexts (tests / scripts). Keyed by the stable externalId
// when present, falling back to the intake item's own id.

function dedupeKey(item: IntakeItem): string {
  return item.externalId && item.externalId.length > 0 ? item.externalId : item.id;
}

const memoryLedger = new Set<string>();

function loadLedger(): Set<string> {
  if (typeof localStorage === 'undefined') return memoryLedger;
  try {
    const raw = localStorage.getItem(LEDGER_KEY);
    if (!raw) return new Set<string>();
    const parsed = JSON.parse(raw) as unknown;
    return new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set<string>();
  }
}

function saveLedger(ledger: Set<string>): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(LEDGER_KEY, JSON.stringify([...ledger]));
  } catch {
    // Quota / disabled storage — fall back to memory for this session.
    ledger.forEach((id) => memoryLedger.add(id));
  }
}

// --- Mapping ----------------------------------------------------------------

export function intakeToTask(item: IntakeItem): CreateTaskInput {
  return {
    title: item.subject || item.fromEmail || `Intake ${item.id}`,
    business: BUSINESS,
    source: item.externalSource ?? 'web', // gmail | slack | web
    subject: item.subject || undefined,
    bodyText: item.bodyText || undefined,
    bodyHtml: item.bodyHtml || undefined,
    externalUrl: item.externalUrl ?? undefined,
    proNumber: item.proNumber ?? undefined,
    notes: item.notes ?? undefined,
    receivedAt: item.receivedAt || undefined,
    status: STATUS_MAP[item.status] ?? 'NEW',
    assignedTo: item.assignedTo || undefined,
    // Provenance / idempotency. The command center dedupes on externalId.
    externalSource: EXTERNAL_SOURCE,
    externalId: dedupeKey(item),
  } as CreateTaskInput;
}

// --- Sync engine ------------------------------------------------------------

export type SyncResult = {
  created: number;
  skipped: number;
  failed: number;
  errors: Array<{ id: string; message: string }>;
};

/** Poll IntakeItems once and push any not-yet-synced ones to the command center. */
export async function syncIntakeOnce(
  filter?: { assignedTo?: string; source?: string },
): Promise<SyncResult> {
  const ledger = loadLedger();
  const result: SyncResult = { created: 0, skipped: 0, failed: 0, errors: [] };

  const items = await listIntakeItems(filter);
  for (const item of items) {
    const key = dedupeKey(item);
    if (ledger.has(key)) {
      result.skipped += 1;
      continue;
    }
    try {
      await createTask(intakeToTask(item));
      ledger.add(key);
      result.created += 1;
    } catch (err) {
      result.failed += 1;
      result.errors.push({ id: item.id, message: err instanceof Error ? err.message : String(err) });
    }
  }

  saveLedger(ledger);
  return result;
}

/**
 * Start a polling sync loop. Returns a stop() function. Runs an immediate sync,
 * then repeats every `intervalMs` (default 30s). Errors per cycle are logged and
 * swallowed so the loop survives transient failures.
 */
export function startIntakeSync(
  options: { filter?: { assignedTo?: string; source?: string }; intervalMs?: number } = {},
): () => void {
  const intervalMs = options.intervalMs ?? POLL_MS;
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    try {
      const r = await syncIntakeOnce(options.filter);
      if (r.created > 0 || r.failed > 0) {
        console.info(`[intakeSync] created=${r.created} skipped=${r.skipped} failed=${r.failed}`);
      }
    } catch (err) {
      console.error('[intakeSync] cycle error', err);
    }
  };

  void tick();
  const handle = setInterval(tick, intervalMs);
  return () => {
    stopped = true;
    clearInterval(handle);
  };
}
