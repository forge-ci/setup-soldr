/**
 * Per-job cache ledger (obs-rust/obs-studio#4954 section 13.1).
 *
 * One JSON document per job that says, for every cache layer setup-soldr
 * handled: did it hit, how many bytes did it hold or move, how long did it
 * take, and how much time did a hit save. It is published as the
 * `cache-ledger` output and one log line, so a workflow can roll ledgers up
 * across runs without parsing logs.
 *
 * - Hosted profile: built from the restore records the stats collector
 *   already keeps. An exact key is a hit, a restore-key match is `partial`,
 *   nothing is a miss. Time saved is unknown there (null).
 * - Persistent root: built from probes of the root before and after the
 *   provisioning phases. A layer whose files were already present and which
 *   the phase did not change is a hit; time saved is the duration of that
 *   layer's most recent miss on the same root (from the root's history).
 */
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * `seeded-from-actions` (#691): a cold persistent layer filled read-only from
 * the GitHub Actions cache. Neither a hit (the root did not hold it) nor a
 * miss (nothing was rebuilt from scratch).
 */
export type LedgerStatus = "hit" | "partial" | "miss" | "skipped" | "seeded-from-actions";

export interface LedgerLayer {
  layer: string;
  status: LedgerStatus;
  /** Bytes the layer holds (persistent) or moved (hosted archive), when known. */
  bytes: number | null;
  durationMs: number | null;
  /** Time a hit avoided; null when unknown. */
  savedMs: number | null;
}

export interface CacheLedger {
  schema: 1;
  profile: "persistent-root" | "hosted" | "local";
  root: string | null;
  /** Persistent root only: how the session opened (clean, fresh, recovered, ...). */
  session: string | null;
  layers: LedgerLayer[];
  totals: { hits: number; partial: number; misses: number; seeded: number; bytes: number; durationMs: number; savedMs: number };
}

export function summarizeLedger(
  profile: CacheLedger["profile"],
  root: string | null,
  session: string | null,
  layers: LedgerLayer[],
): CacheLedger {
  const totals = { hits: 0, partial: 0, misses: 0, seeded: 0, bytes: 0, durationMs: 0, savedMs: 0 };
  for (const l of layers) {
    if (l.status === "hit") totals.hits += 1;
    else if (l.status === "partial") totals.partial += 1;
    else if (l.status === "miss") totals.misses += 1;
    else if (l.status === "seeded-from-actions") totals.seeded += 1;
    totals.bytes += l.bytes ?? 0;
    totals.durationMs += l.durationMs ?? 0;
    totals.savedMs += l.savedMs ?? 0;
  }
  return { schema: 1, profile, root, session, layers, totals };
}

/** Restore record shape shared with `StatsCollector.snapshot()`. */
export interface RestoreRecordLike {
  label: string;
  operation: string;
  hit: boolean;
  matchedKey: string;
  archiveBytes: number | null;
  durationMs: number;
}

export function ledgerLayersFromRestores(records: readonly RestoreRecordLike[]): LedgerLayer[] {
  return records
    .filter((r) => r.operation === "restore")
    .map((r) => ({
      layer: r.label,
      status: r.hit ? "hit" : r.matchedKey ? "partial" : "miss",
      bytes: r.archiveBytes,
      durationMs: r.durationMs,
      savedMs: null,
    }));
}

/** Snapshot of one directory: does it hold anything, and how much. */
export interface DirProbe {
  exists: boolean;
  entries: string[];
  bytes: number;
  /** True when the walk stopped at the file budget: `bytes` is a lower bound. */
  truncated: boolean;
}

/**
 * Walk `dir` summing file sizes, bounded by `maxFiles` so a huge cache never
 * stalls the step. `entries` are the top-level names (sorted).
 */
export function probeDir(dir: string, maxFiles = 200_000): DirProbe {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir).sort();
  } catch {
    return { exists: false, entries: [], bytes: 0, truncated: false };
  }
  let bytes = 0;
  let files = 0;
  let truncated = false;
  const stack = entries.map((e) => path.join(dir, e));
  while (stack.length > 0) {
    if (files >= maxFiles) {
      truncated = true;
      break;
    }
    const p = stack.pop()!;
    let st: fs.Stats;
    try {
      st = fs.lstatSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      try {
        for (const child of fs.readdirSync(p)) stack.push(path.join(p, child));
      } catch {
        // unreadable: skip
      }
    } else {
      files += 1;
      bytes += st.size;
    }
  }
  return { exists: true, entries, bytes, truncated };
}

/**
 * A persistent layer's status: a hit when it held content before the phase
 * and the phase left its top-level entries unchanged; `seeded-from-actions`
 * when it was cold and the Actions-cache seed (#691) filled it; else a miss.
 */
export function persistentLayerStatus(before: DirProbe, after: DirProbe, seeded = false): LedgerStatus {
  if (!before.exists || before.entries.length === 0) {
    return seeded && after.entries.length > 0 ? "seeded-from-actions" : "miss";
  }
  const same = before.entries.length === after.entries.length && before.entries.every((e, i) => e === after.entries[i]);
  return same ? "hit" : "miss";
}

export function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GiB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MiB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${n} B`;
}

/** One log line, e.g. `cache-ledger: persistent-root hits=3 misses=1 bytes=1.20 GiB time=4.1s saved=71.0s`. */
export function describeLedger(ledger: CacheLedger): string {
  const t = ledger.totals;
  const parts = ledger.layers.map((l) => `${l.layer}=${l.status}`);
  return (
    `cache-ledger: ${ledger.profile}${ledger.session ? ` (${ledger.session})` : ""} ` +
    `hits=${t.hits} partial=${t.partial} seeded=${t.seeded} misses=${t.misses} bytes=${formatBytes(t.bytes)} ` +
    `time=${(t.durationMs / 1000).toFixed(1)}s saved=${(t.savedMs / 1000).toFixed(1)}s [${parts.join(" ")}]`
  );
}
