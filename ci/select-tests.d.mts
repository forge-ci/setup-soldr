// Types for ci/select-tests.mjs, so the TypeScript tests can import it.
export type Change = { status: string; path: string; from?: string };
export type Selection = { all: string | null; suites: string[]; reasons: Array<{ path: string; suites: string[]; why: string }> };
export type Miss = { path: string; test: string; suite: string };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Config = any;
export const CONFIG_FILE: string;
export function globToRegExp(glob: string): RegExp;
export function matches(glob: string, file: string): boolean;
export function loadConfig(root: string): Config;
export function npmTestFiles(root: string): string[];
export function buildGraph(root: string, testFiles: string[], trackedFiles: string[], opaque?: string[]): Map<string, Set<string>>;
export function select(changes: Change[], cfg: Config, graph?: Map<string, Set<string>> | null): Selection;
export function guard(changes: Change[], selection: Selection, cfg: Config, graph: Map<string, Set<string>>): Miss[];
export function testFilesFor(suites: string[], cfg: Config, order: string[]): string[];
export function check(root: string, cfg: Config, tracked: string[]): { problems: string[]; observed: number };
export function trackedFiles(root: string): string[];
export function parseNameStatus(text: string): Change[];
