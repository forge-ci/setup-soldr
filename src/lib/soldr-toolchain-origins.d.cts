// Type declarations for soldr-toolchain-origins.cjs. Keep in sync with its
// exports; the implementation is plain ESM so scripts/ can share it.

export const DEFAULT_TOOLCHAIN_REDIRECT_URL: string;
export const BUILTIN_TOOLCHAIN_ORIGINS: ReadonlyArray<string>;
export const TOOLCHAIN_REDIRECT_TIMEOUT_MS: number;
export const TOOLCHAIN_FILE_TIMEOUT_MS: number;

export type ToolchainEnv = Record<string, string | undefined>;

export interface ToolchainOriginOptions {
  env?: ToolchainEnv;
  fetch?: typeof fetch;
  /** Redirect manifest timeout (default 5 s). */
  timeoutMs?: number;
  log?: (message: string) => void;
}

export interface ToolchainFileOptions extends ToolchainOriginOptions {
  /** Per-origin timeout for the toolchain file itself (default 60 s). */
  fileTimeoutMs?: number;
  headers?: Record<string, string>;
}

export function normalizeOrigin(value: string): string;
export function parseRedirectManifest(payload: unknown): string[] | null;
export function mergeOrigins(...lists: ReadonlyArray<ReadonlyArray<string>>): string[];
export function resetToolchainRedirectCache(): void;
export function resolveToolchainOrigins(options?: ToolchainOriginOptions): Promise<string[]>;
export function isFailoverStatus(status: number): boolean;
export function fetchToolchainFile(
  relativePath: string,
  options?: ToolchainFileOptions,
): Promise<{ url: string; body: Buffer }>;
export function fetchToolchainJson(
  relativePath: string,
  options?: ToolchainFileOptions,
): Promise<{ url: string; payload: Record<string, unknown> }>;
