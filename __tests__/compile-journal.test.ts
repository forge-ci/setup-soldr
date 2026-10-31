// Tests for src/lib/compile-journal.ts.
//
// The behaviour we care about, in order:
//   1. readJournal: ENOENT → null (the common "no build happened"
//      case); malformed lines silently skipped so a single garbled
//      record doesn't blank the dump.
//   2. summarize: outcome histogram, miss_reason histogram,
//      per-extension hit/miss, slowest_misses ordering, sample picker
//      covers one record per distinct miss_reason.
//   3. formatJournalSection: includes every section header AND every
//      distinct miss_reason from the input.
//   4. Env redaction: a record with a token env var must not leak it
//      into the formatted output.
//   5. formatRollupsSection: tolerates missing / null inputs without
//      throwing.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  formatJournalSection,
  formatRollupsSection,
  readJournal,
  summarize,
  type JournalRecord,
} from "../src/lib/compile-journal.js";

const tmpDirs: string[] = [];

after(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function mkTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function writeJsonl(p: string, records: readonly object[]): void {
  const body = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  fs.writeFileSync(p, body, "utf8");
}

test("readJournal returns null when file is missing", () => {
  const tmp = mkTmp("journal-");
  assert.equal(readJournal(path.join(tmp, "no-such-file.jsonl")), null);
});

test("readJournal skips malformed lines", () => {
  const tmp = mkTmp("journal-");
  const p = path.join(tmp, "bad.jsonl");
  fs.writeFileSync(
    p,
    '{"outcome":"hit"}\nthis-is-not-json\n{"outcome":"miss"}\n\n',
    "utf8",
  );
  const records = readJournal(p)!;
  assert.equal(records.length, 2);
  assert.equal(records[0]!.outcome, "hit");
  assert.equal(records[1]!.outcome, "miss");
});

test("summarize produces correct histograms + per-extension split", () => {
  const records: JournalRecord[] = [
    { outcome: "hit", output_ext: "rmeta", latency_ns: 200_000_000 },
    { outcome: "miss", miss_reason: "ContentChanged", output_ext: "rmeta", latency_ns: 800_000_000 },
    { outcome: "miss", miss_reason: "ContentChanged", output_ext: "rlib", latency_ns: 500_000_000 },
    { outcome: "miss", miss_reason: "NoCacheFile", output_ext: "rmeta", latency_ns: 1_500_000_000 },
    { outcome: "miss", miss_reason: "CacheCorrupt", output_ext: "rlib", latency_ns: 300_000_000 },
    { outcome: "error", output_ext: "rmeta" },
  ];
  const s = summarize(records);

  assert.equal(s.total, 6);
  assert.deepEqual(s.outcomes, { hit: 1, miss: 4, error: 1 });
  assert.deepEqual(s.miss_reasons, {
    ContentChanged: 2,
    NoCacheFile: 1,
    CacheCorrupt: 1,
  });
  assert.deepEqual(s.per_extension, {
    rmeta: { hit: 1, miss: 2 }, // 1 error doesn't count as hit OR miss
    rlib: { hit: 0, miss: 2 },
  });

  // slowest_misses sorted descending by latency_ns.
  assert.equal(s.slowest_misses.length, 4);
  assert.equal(s.slowest_misses[0]!.latency_ms, 1500);
  assert.equal(s.slowest_misses[0]!.reason, "NoCacheFile");
  assert.equal(s.slowest_misses[1]!.latency_ms, 800);
  assert.equal(s.slowest_misses[3]!.latency_ms, 300);

  // sample picker: one record per distinct miss_reason (3 reasons),
  // plus one hit sample = 4 records.
  const sampledReasons = s.sample_records
    .filter((r) => r.outcome === "miss")
    .map((r) => r.miss_reason);
  assert.deepEqual(
    new Set(sampledReasons),
    new Set(["ContentChanged", "NoCacheFile", "CacheCorrupt"]),
  );
  assert.ok(s.sample_records.some((r) => r.outcome === "hit"), "should include one hit sample");
});

test("formatJournalSection includes every reason name in output", () => {
  const records: JournalRecord[] = [
    { outcome: "miss", miss_reason: "ContentChanged", output_ext: "rmeta" },
    { outcome: "miss", miss_reason: "NoCacheFile", output_ext: "rmeta" },
    { outcome: "miss", miss_reason: "CacheCorrupt", output_ext: "rlib" },
  ];
  const out = formatJournalSection(summarize(records)).join("\n");
  assert.match(out, /\[compile_journal\]/);
  assert.match(out, /outcomes:/);
  assert.match(out, /miss_reasons/);
  assert.match(out, /ContentChanged/);
  assert.match(out, /NoCacheFile/);
  assert.match(out, /CacheCorrupt/);
  assert.match(out, /per_output_ext/);
  assert.match(out, /slowest_misses/);
  assert.match(out, /sample_records/);
});

test("formatJournalSection redacts token env values in sample records (object form)", () => {
  const records: JournalRecord[] = [
    {
      outcome: "miss",
      miss_reason: "ContentChanged",
      crate_name: "demo",
      output_ext: "rmeta",
      env: {
        GITHUB_TOKEN: "ghs_super_secret_123",
        CARGO_TERM_COLOR: "always",
      },
    },
  ];
  const out = formatJournalSection(summarize(records)).join("\n");
  assert.doesNotMatch(out, /ghs_super_secret_123/);
  assert.match(out, /GITHUB_TOKEN":"<redacted>"/);
  // Non-token vars stay verbatim.
  assert.match(out, /CARGO_TERM_COLOR":"always"/);
});

test("formatJournalSection redacts env when zccache writes array-of-pairs", () => {
  // This is the on-the-wire shape (run 26145372118 leaked the full
  // env on every sample because the previous impl indexed by array
  // position so the redaction regex never matched the real key names).
  const records: JournalRecord[] = [
    {
      outcome: "miss",
      miss_reason: "ContentChanged",
      crate_name: "demo",
      output_ext: "rmeta",
      env: [
        ["GITHUB_TOKEN", "ghs_super_secret_array_form"],
        ["CARGO_TERM_COLOR", "always"],
        ["RUSTUP_TOOLCHAIN", "stable"],
      ],
    },
  ];
  const out = formatJournalSection(summarize(records)).join("\n");
  assert.doesNotMatch(
    out,
    /ghs_super_secret_array_form/,
    "secret must NOT appear verbatim regardless of env shape",
  );
  assert.match(out, /GITHUB_TOKEN":"<redacted>"/);
  assert.match(out, /CARGO_TERM_COLOR":"always"/);
  assert.match(out, /RUSTUP_TOOLCHAIN":"stable"/);
  // The previous bug produced keys like "0", "1" — assert that pattern
  // no longer appears in our output so a regression jumps out fast.
  assert.doesNotMatch(out, /"0":\[/);
  assert.doesNotMatch(out, /"1":\[/);
});

test("formatJournalSection recovers env from legacy index-keyed-object shape", () => {
  // If some intermediate layer stringifies an array via
  // `Object.fromEntries(arr.entries())` we'd get `{"0":[k,v]}`. We
  // detect + recover so secrets still get redacted.
  const records: JournalRecord[] = [
    {
      outcome: "miss",
      miss_reason: "ContentChanged",
      crate_name: "demo",
      env: {
        "0": ["GITHUB_TOKEN", "ghs_legacy_form"] as unknown as string,
        "1": ["CARGO_TERM_COLOR", "always"] as unknown as string,
      } as unknown as Record<string, string>,
    },
  ];
  const out = formatJournalSection(summarize(records)).join("\n");
  assert.doesNotMatch(out, /ghs_legacy_form/);
  assert.match(out, /GITHUB_TOKEN":"<redacted>"/);
});

test("formatJournalSection handles empty input gracefully", () => {
  const out = formatJournalSection(summarize([])).join("\n");
  assert.match(out, /total_records=0/);
  assert.match(out, /\(none\)/);
});

test("formatRollupsSection tolerates missing report", () => {
  assert.deepEqual(
    formatRollupsSection(undefined).join("\n"),
    "[compile_rollups (zccache analyze --json)]\n  (no report payload)",
  );
  assert.deepEqual(
    formatRollupsSection(null as unknown as Record<string, unknown> | undefined).join("\n"),
    "[compile_rollups (zccache analyze --json)]\n  (no report payload)",
  );
  assert.deepEqual(
    formatRollupsSection({}).join("\n"),
    "[compile_rollups (zccache analyze --json)]\n  (no rollups field)",
  );
});

test("formatRollupsSection formats by_extension + slowest + miss_crate_counts", () => {
  const report = {
    rollups: {
      by_extension: {
        rmeta: { hits: 12, misses: 4, total_ns: 4_500_000_000 },
        rlib: { hits: 3, misses: 7, total_ns: 2_000_000_000 },
      },
      slowest_entries: [
        { outcome: "miss", crate_name: "tokio", latency_ns: 1_800_000_000 },
        { outcome: "hit", crate_name: "serde", latency_ns: 50_000_000 },
      ],
      miss_crate_counts: {
        tokio: 4,
        regex: 2,
        serde: 1,
      },
    },
  };
  const out = formatRollupsSection(report).join("\n");
  assert.match(out, /by_extension/);
  assert.match(out, /rmeta/);
  assert.match(out, /hits=\s*12/);
  assert.match(out, /rate=\s*75\.0%/);
  assert.match(out, /tokio/);
  assert.match(out, /miss_crate_counts/);
});

test("readJournal round-trip via summarize agrees with synthetic counts", () => {
  const tmp = mkTmp("journal-rt-");
  const p = path.join(tmp, "last-session.jsonl");
  const records: JournalRecord[] = [
    { outcome: "hit", output_ext: "rmeta", crate_name: "a" },
    { outcome: "miss", miss_reason: "ContentChanged", output_ext: "rmeta", crate_name: "b" },
    { outcome: "miss", miss_reason: "ContentChanged", output_ext: "rlib", crate_name: "c" },
  ];
  writeJsonl(p, records);
  const parsed = readJournal(p)!;
  const s = summarize(parsed);
  assert.equal(s.total, 3);
  assert.equal(s.outcomes["hit"], 1);
  assert.equal(s.outcomes["miss"], 2);
  assert.equal(s.miss_reasons["ContentChanged"], 2);
});
