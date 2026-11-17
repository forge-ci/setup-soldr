/**
 * forge-ci/setup-soldr#675: the cook (dependency rematerialization) store of
 * a persistent root.
 *
 * A persistent root keeps target/ as per-job scratch, so the cooked
 * dependency closure has to come back each job from somewhere. The store
 * keeps the exact `soldr save` archive of each cook layer under
 * `<root>/cook-store/<key>.tar.zst`; restore copies it out and runs the
 * normal `soldr load`, which replays the freshness metadata (mtimes,
 * fingerprints) that a raw directory copy would get wrong. Read-through
 * order: this store, then the Actions cache, writing an exact remote hit
 * back here.
 *
 * Entries are content-keyed and immutable: put writes a temp file and
 * renames it into place, so a crashed job never leaves a torn entry under a
 * real key. The store keeps the newest `keep` entries (by mtime; get bumps
 * it), which bounds it to a few closures per root.
 */
import * as fsp from "node:fs/promises";
import * as path from "node:path";

export const COOK_STORE_DIR = "cook-store";
/** Entries kept per root: the current key plus a few recipe/lockfile neighbours. */
export const COOK_STORE_KEEP = 4;
const SUFFIX = ".tar.zst";

export function cookStoreDir(root: string): string {
  return path.join(root, COOK_STORE_DIR);
}

export function cookStorePath(root: string, key: string): string {
  return path.join(cookStoreDir(root), `${key.replace(/[^A-Za-z0-9._-]/g, "_")}${SUFFIX}`);
}

/** Copy the entry for `key` to `dest`. Returns its size, or 0 on a miss. */
export async function cookStoreGet(root: string, key: string, dest: string): Promise<number> {
  const src = cookStorePath(root, key);
  let size: number;
  try {
    size = (await fsp.stat(src)).size;
  } catch {
    return 0;
  }
  if (size === 0) return 0;
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.copyFile(src, dest);
  const now = new Date();
  await fsp.utimes(src, now, now).catch(() => {});
  return size;
}

/** Store `src` under `key`, then prune to `keep` entries. Returns the stored size, or 0. */
export async function cookStorePut(
  root: string,
  key: string,
  src: string,
  keep: number = COOK_STORE_KEEP,
): Promise<number> {
  let size: number;
  try {
    size = (await fsp.stat(src)).size;
  } catch {
    return 0;
  }
  if (size === 0) return 0;
  const dir = cookStoreDir(root);
  await fsp.mkdir(dir, { recursive: true });
  const dest = cookStorePath(root, key);
  const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fsp.copyFile(src, tmp);
    await fsp.rename(tmp, dest);
  } catch (err) {
    await fsp.rm(tmp, { force: true });
    throw err;
  }
  await pruneCookStore(dir, keep);
  return size;
}

async function pruneCookStore(dir: string, keep: number): Promise<void> {
  const names = await fsp.readdir(dir).catch(() => [] as string[]);
  const entries: Array<{ file: string; mtimeMs: number }> = [];
  for (const name of names) {
    const file = path.join(dir, name);
    const st = await fsp.stat(file).catch(() => null);
    if (!st?.isFile()) continue;
    if (!name.endsWith(SUFFIX)) {
      // A temp file from a job that died between copy and rename.
      if (Date.now() - st.mtimeMs > 3_600_000) await fsp.rm(file, { force: true });
      continue;
    }
    entries.push({ file, mtimeMs: st.mtimeMs });
  }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const stale of entries.slice(Math.max(keep, 1))) await fsp.rm(stale.file, { force: true });
}
