/**
 * forge-ci/setup-soldr#675: the cook (dependency rematerialization) store of
 * a persistent root. RED stub: no entry is ever found or kept.
 */
import * as path from "node:path";

export const COOK_STORE_DIR = "cook-store";
export const COOK_STORE_KEEP = 4;

export function cookStoreDir(root: string): string {
  return path.join(root, COOK_STORE_DIR);
}

export function cookStorePath(root: string, key: string): string {
  return path.join(cookStoreDir(root), `${key.replace(/[^A-Za-z0-9._-]/g, "_")}.tar.zst`);
}

export async function cookStoreGet(_root: string, _key: string, _dest: string): Promise<number> {
  return 0;
}

export async function cookStorePut(
  _root: string,
  _key: string,
  _src: string,
  _keep: number = COOK_STORE_KEEP,
): Promise<number> {
  return 0;
}
