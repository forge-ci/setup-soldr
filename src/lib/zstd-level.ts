/**
 * Runner-aware zstd level (`zstd-level` input). RED stub.
 */
export type ZstdLevelSource = "input" | "SETUP_SOLDR_ZSTD_LEVEL" | "ZSTD_CLEVEL" | "auto";

export interface ZstdLevelResolution {
  level: number | null;
  source: ZstdLevelSource;
  reason: string;
  ignored: string[];
}

export const ZSTD_RESOLVED_ENV = "SETUP_SOLDR_ZSTD_LEVEL_RESOLVED";

export function isSelfHostedRunner(_env: Record<string, string | undefined>): boolean {
  return false;
}

export function resolveZstdLevel(
  _input: string | undefined,
  _env: Record<string, string | undefined>,
): ZstdLevelResolution {
  return { level: null, source: "auto", reason: "", ignored: [] };
}

export function zstdLevelExports(_r: ZstdLevelResolution): Record<string, string> {
  return {};
}

export function resolvedZstdLevel(_env: Record<string, string | undefined>): string | null {
  return null;
}
