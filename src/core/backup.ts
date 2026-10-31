import BetterSqlite3 from "better-sqlite3";
import { chmodSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

// Snapshot the SQLite DB to <backupDir>/macbrain-<YYYY-MM-DD>.db via the online
// backup API, then delete macbrain-*.db files older than retentionDays (by mtime).
// `now` is injectable for deterministic tests. Replaces the pg_dump job.
export async function backupDb(
  dbPath: string,
  backupDir: string,
  retentionDays = 30,
  now: Date = new Date(),
): Promise<{ file: string; pruned: number }> {
  // A backup is a full copy of the brain: keep it as private as the live DB.
  // mkdir's mode is umask-masked and a no-op on an existing dir, so chmod both
  // the dir and the snapshot explicitly rather than trusting the umask.
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  chmodSync(backupDir, 0o700);
  const file = join(backupDir, `enscribe-${now.toISOString().slice(0, 10)}.db`);
  const db = new BetterSqlite3(dbPath, { readonly: true });
  try {
    await db.backup(file);
  } finally {
    db.close();
  }
  chmodSync(file, 0o600);
  const cutoff = now.getTime() - retentionDays * 86400000;
  let pruned = 0;
  for (const f of readdirSync(backupDir)) {
    // Old macbrain-* snapshots from before the 2026-10-31 rename still age out.
    if (!/^(?:enscribe|macbrain)-\d{4}-\d{2}-\d{2}\.db$/.test(f)) continue;
    const full = join(backupDir, f);
    if (full === file) continue;
    if (statSync(full).mtimeMs < cutoff) {
      unlinkSync(full);
      pruned++;
    }
  }
  return { file, pruned };
}
