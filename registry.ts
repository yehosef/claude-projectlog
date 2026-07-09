/**
 * registry.ts — load/save registry.json, pending.json, ignore.json, config.json.
 * All files under ~/.claude/projects-log/. Atomic writes via tmp+rename.
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  realpathSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";

const BASE = import.meta.dir;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RegistryEntry {
  cwd: string;
  name: string;
  area: string;
  notion_page_id: string;
  created: string; // ISO-8601
}

export type Registry = Record<string, RegistryEntry>;

export interface PendingEntry {
  cwd: string;
  firstSeen: string; // ISO-8601
  turns: number;
}

export interface Config {
  code_roots: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function atomicWrite(filePath: string, data: unknown): void {
  const tmp = filePath + ".tmp." + randomBytes(4).toString("hex");
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  renameSync(tmp, filePath);
}

function readJson<T>(filePath: string, defaultValue: T): T {
  if (!existsSync(filePath)) return defaultValue;
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as T;
  } catch {
    return defaultValue;
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const REGISTRY_PATH = join(BASE, "registry.json");

export function loadRegistry(): Registry {
  return readJson<Registry>(REGISTRY_PATH, {});
}

export function saveRegistry(reg: Registry): void {
  atomicWrite(REGISTRY_PATH, reg);
}

// ---------------------------------------------------------------------------
// Pending
// ---------------------------------------------------------------------------

const PENDING_PATH = join(BASE, "pending.json");

export function loadPending(): PendingEntry[] {
  return readJson<PendingEntry[]>(PENDING_PATH, []);
}

export function savePending(pending: PendingEntry[]): void {
  atomicWrite(PENDING_PATH, pending);
}

// ---------------------------------------------------------------------------
// Ignore list
// ---------------------------------------------------------------------------

const IGNORE_PATH = join(BASE, "ignore.json");

const DEFAULT_IGNORE: string[] = [
  "/Volumes/code/happyflow",
  "/Users/yehosef/.claude/projects-log/.scratch",
  "/private/tmp",
  "/tmp",
];

export function loadIgnore(): string[] {
  if (!existsSync(IGNORE_PATH)) {
    atomicWrite(IGNORE_PATH, DEFAULT_IGNORE);
    return [...DEFAULT_IGNORE];
  }
  return readJson<string[]>(IGNORE_PATH, DEFAULT_IGNORE);
}

export function saveIgnore(list: string[]): void {
  atomicWrite(IGNORE_PATH, list);
}

/**
 * Check if a resolved absolute path is matched by an ignore entry.
 * ignore.json entries are plain path prefixes — exact match or prefix match.
 */
export function isIgnored(resolvedPath: string, ignoreList: string[]): boolean {
  for (const prefix of ignoreList) {
    if (resolvedPath === prefix) return true;
    if (resolvedPath.startsWith(prefix + "/")) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const CONFIG_PATH = join(BASE, "config.json");

const DEFAULT_CONFIG: Config = {
  code_roots: ["/Volumes/code/personal", "/Volumes/code/geula"],
};

export function loadConfig(): Config {
  if (!existsSync(CONFIG_PATH)) {
    atomicWrite(CONFIG_PATH, DEFAULT_CONFIG);
    return { ...DEFAULT_CONFIG };
  }
  const cfg = readJson<Config>(CONFIG_PATH, DEFAULT_CONFIG);
  if (!cfg.code_roots) cfg.code_roots = DEFAULT_CONFIG.code_roots;
  return cfg;
}

export function saveConfig(cfg: Config): void {
  atomicWrite(CONFIG_PATH, cfg);
}

// ---------------------------------------------------------------------------
// Project lookup
// ---------------------------------------------------------------------------

/**
 * Given an absolute cwd, walk up to find a registered project root.
 * Returns [slug, entry] or null.
 */
export function findProjectForCwd(
  cwd: string
): [string, RegistryEntry] | null {
  let resolved: string;
  try {
    resolved = realpathSync(cwd);
  } catch {
    resolved = cwd;
  }

  const reg = loadRegistry();

  // Try exact match first, then walk up
  let current = resolved;
  while (true) {
    for (const [slug, entry] of Object.entries(reg)) {
      let entryReal: string;
      try {
        entryReal = realpathSync(entry.cwd);
      } catch {
        entryReal = entry.cwd;
      }
      if (current === entryReal) {
        return [slug, entry];
      }
    }
    const parent = dirname(current);
    if (parent === current) break; // reached filesystem root
    current = parent;
  }

  return null;
}

/**
 * Compute a slug for a given path (same logic Claude uses for project dirs).
 * Replaces path separators with hyphens, strips leading slash.
 */
export function pathToSlug(absPath: string): string {
  return absPath.replace(/\//g, "-").replace(/^-/, "");
}

/**
 * Check if a path is within any code_root.
 */
export function isUnderCodeRoot(absPath: string, config: Config): boolean {
  for (const root of config.code_roots) {
    if (absPath === root || absPath.startsWith(root + "/")) return true;
  }
  return false;
}
