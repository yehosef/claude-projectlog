/**
 * transcript.ts — read transcript .jsonl files under ~/.claude/projects/<slug>/
 * with per-file byte-offset watermarks. Returns a redacted digest of new lines.
 */

import { readdirSync, statSync, realpathSync, openSync, readSync, closeSync } from "node:fs";
import { join, resolve } from "node:path";
import { isIgnored, findProjectForCwd } from "./registry.ts";

// Per-sweep caches. A sweep processes every project, and each project's
// collectDelta would otherwise (a) re-walk the whole ~/.claude/projects tree,
// (b) re-stat every file, and (c) re-read AND re-parse the same (often large)
// transcripts — all O(projects × files). Caching the file list, stats, and
// PARSED tail records for the duration of one sweep makes each O(files) instead.
// The difference is a multi-minute sweep vs a sub-second one. Cleared per sweep.
//
// parseCache is keyed by "path@readStart": the heavy work (read + JSON.parse +
// text extraction + redaction) runs ONCE per file and is shared across all
// projects (which advance through a shared file to the same offset), rather than
// once per project. Routing/ignore filtering stays per-project (it's cheap).
interface ParsedTail {
  records: { cwd: string; line: string }[];
  newOffset: number;
}
let parseCache = new Map<string, ParsedTail>();
let fileListCache: string[] | null = null;
let statCache = new Map<string, { mtimeMs: number; size: number } | null>();
let realpathCache = new Map<string, string>();

export function resetFileCache(): void {
  parseCache = new Map();
  fileListCache = null;
  statCache = new Map();
  realpathCache = new Map();
}

/** realpathSync, cached per sweep. There are only ~100 distinct cwds across the
 *  whole tree, but routing previously called realpathSync per line × per other
 *  project — millions of syscalls. Caching collapses that to one per path. */
function cachedRealpath(p: string): string {
  const hit = realpathCache.get(p);
  if (hit !== undefined) return hit;
  let r: string;
  try {
    r = realpathSync(p);
  } catch {
    r = p;
  }
  realpathCache.set(p, r);
  return r;
}

/**
 * Decide whether a transcript line (by its cwd) belongs to a given project.
 * A line belongs to the project whose registered cwd is the LONGEST prefix of
 * the line's cwd. Pure + exported so it can be unit-tested directly — this is
 * the routing logic that had the nested-project bug (bhm/mikdash3 under bhm).
 *
 * All args must be resolved (realpath'd) absolute paths.
 */
export function lineBelongsToProject(
  lineCwd: string,
  projectCwd: string,
  otherCwds: string[]
): boolean {
  // Must be within (at or under) this project's cwd.
  const within = lineCwd === projectCwd || lineCwd.startsWith(projectCwd + "/");
  if (!within) return false;
  // ...unless a MORE SPECIFIC (longer) project also contains it — then it's theirs.
  for (const other of otherCwds) {
    if (other.length <= projectCwd.length) continue; // not more specific
    if (lineCwd === other || lineCwd.startsWith(other + "/")) return false;
  }
  return true;
}

/** All transcript .jsonl files, enumerated once per sweep. */
function getAllJsonl(): string[] {
  if (fileListCache) return fileListCache;
  const out: string[] = [];
  for (const slugDir of slugDirs()) out.push(...findJsonlFiles(slugDir));
  fileListCache = out;
  return out;
}

/** statSync result, cached once per sweep (null if the file is gone). */
function getStat(filePath: string): { mtimeMs: number; size: number } | null {
  if (statCache.has(filePath)) return statCache.get(filePath)!;
  let s: { mtimeMs: number; size: number } | null = null;
  try {
    const st = statSync(filePath);
    s = { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    s = null;
  }
  statCache.set(filePath, s);
  return s;
}

const PROJECTS_DIR = join(
  process.env.HOME ?? "/Users/yehosef",
  ".claude",
  "projects"
);

// Marker env var set when synth.ts spawns claude -p (to skip self-feeding)
const SYNTH_MARKER = "CLAUDE_PROJECTLOG_SYNTH";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FileState {
  offset: number;
}

export interface ProjectState {
  files: Record<string, FileState>;
  lastSynthAt?: string; // ISO-8601
  nextStepsCache?: { value: string; fetchedAt: string };
  statusCache?: { value: string; fetchedAt: string }; // Notion Status (Active/Paused/Idea/Done)
  logPages?: Record<string, string>; // "YYYY-MM" -> pageId
  recentEntries?: RecentEntry[];
}

export interface RecentEntry {
  isoDate: string;
  bullets: string[];
}

export interface DeltaResult {
  digestLines: string[];
  newOffsets: Record<string, number>;
  count: number; // number of new lines processed
}

// ---------------------------------------------------------------------------
// Slug dir enumeration
// ---------------------------------------------------------------------------

export function slugDirs(): string[] {
  try {
    return readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(PROJECTS_DIR, d.name));
  } catch {
    return [];
  }
}

/** Recursively find all *.jsonl files under a directory. */
function findJsonlFiles(dir: string): string[] {
  const results: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...findJsonlFiles(full));
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        results.push(full);
      }
    }
  } catch {
    // skip unreadable dirs
  }
  return results;
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

const REDACT_PATTERNS: RegExp[] = [
  // Anthropic API keys
  /sk-[A-Za-z0-9_-]{10,}/g,
  // GitHub tokens
  /ghp_\w+/g,
  /gho_\w+/g,
  // AWS access key IDs
  /AKIA[A-Z0-9]{12,}/g,
  // Slack tokens
  /xox[baprs]-[\w-]+/g,
  // JWTs
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g,
  // PEM blocks
  /-----BEGIN[\s\S]*?KEY-----[\s\S]*?-----END[^-]*-----/g,
  // Bearer tokens
  /Bearer\s+[A-Za-z0-9._~+/\-]{16,}/g,
  // KEY=value, TOKEN=value, SECRET=value, PASSWORD=value, PASSWD=value, API_KEY=value
  /(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|API_KEY)\s*[=:]\s*\S{8,}/gi,
];

// High entropy base64/hex run detector (>= 40 chars)
const HIGH_ENTROPY_RE =
  /(?:[A-Za-z0-9+/]{40,}={0,2}|[0-9a-fA-F]{40,})/g;

function hasHighEntropy(s: string): boolean {
  // Rough charset diversity check: if more than 10 distinct chars, likely high-entropy
  const chars = new Set(s.split(""));
  return chars.size >= 10;
}

export function redact(text: string): string {
  let out = text;
  for (const re of REDACT_PATTERNS) {
    out = out.replace(re, (m) => {
      // For KEY=value style, keep the key name, redact value
      const eqIdx = m.search(/[=:]/);
      if (eqIdx !== -1 && /KEY|TOKEN|SECRET|PASSWORD|PASSWD|API_KEY/i.test(m.slice(0, eqIdx))) {
        return m.slice(0, eqIdx + 1) + "[REDACTED]";
      }
      return "[REDACTED]";
    });
  }
  // High-entropy runs
  out = out.replace(HIGH_ENTROPY_RE, (m) => {
    if (hasHighEntropy(m)) return "[REDACTED]";
    return m;
  });
  return out;
}

// ---------------------------------------------------------------------------
// Content extraction from a parsed line
// ---------------------------------------------------------------------------

function extractTextFromContent(
  content: string | any[],
  type: "user" | "assistant"
): string {
  if (typeof content === "string") {
    return content.slice(0, 400);
  }
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text") {
      parts.push(block.text?.slice(0, 400) ?? "");
    } else if (type === "assistant" && block.type === "tool_use") {
      // For assistant lines: include tool name only, no inputs/outputs
      parts.push(`[tool: ${block.name}]`);
    }
    // Skip tool_result blocks entirely
  }
  return parts.join(" ").slice(0, 400);
}

// ---------------------------------------------------------------------------
// Core collectDelta
// ---------------------------------------------------------------------------

export interface CollectOptions {
  projectPath: string; // absolute path of the registered project root
  state: ProjectState;
  ignoreList: string[];
  /** All registered project cwds except this project (to avoid cross-contamination) */
  otherProjectCwds: string[];
}

/**
 * Collect new transcript lines for a project.
 * Routes each line by its own cwd field.
 */
export async function collectDelta(opts: CollectOptions): Promise<DeltaResult> {
  const { projectPath, state, ignoreList, otherProjectCwds } = opts;

  // Resolve paths once (cached), not per line. otherProjectCwds is the same for
  // every line, so resolve the whole set up front.
  const resolvedProjectPath = cachedRealpath(projectPath);
  const resolvedOthers = otherProjectCwds.map(cachedRealpath);

  const lastSynthAt = state.lastSynthAt
    ? new Date(state.lastSynthAt).getTime()
    : 0;
  // 1h slack: re-read files modified slightly before lastSynthAt
  const mtimeThreshold = lastSynthAt - 3_600_000;

  const allJsonl = getAllJsonl();

  const digestLines: string[] = [];
  const newOffsets: Record<string, number> = {};

  for (const filePath of allJsonl) {
    const st = getStat(filePath);
    if (!st) continue; // file gone
    // mtime optimization: skip files not touched since threshold
    if (mtimeThreshold > 0 && st.mtimeMs < mtimeThreshold) continue;

    const fileState = state.files[filePath] ?? { offset: 0 };
    let offset = fileState.offset;

    // Cheap pre-check using the cached size: if this project's offset is already
    // at/after EOF, there is nothing new — skip without reading the file at all.
    // This is what makes dormant projects nearly free.
    if (st.size <= offset) {
      newOffsets[filePath] = offset;
      continue;
    }

    // Read only the NEW tail since this project's offset — seek to it instead of
    // loading the whole (often 50–100 MB) transcript just to slice its end.
    // Cap how much we load per file per sweep: a single huge backlog delta (e.g.
    // a 100 MB subagent dump read from offset 0) must not balloon RAM. The final
    // digest is capped at 30 KB anyway (see below), so older backlog beyond the
    // cap adds nothing — recent lines are what the summary needs.
    const MAX_DELTA_BYTES = 8 * 1024 * 1024; // 8 MB per file per sweep
    let readStart = offset;
    let capped = false;
    if (st.size - readStart > MAX_DELTA_BYTES) {
      readStart = st.size - MAX_DELTA_BYTES;
      capped = true;
    }

    // Parse the tail ONCE per (file, offset) and cache the project-INDEPENDENT
    // result. Projects that advance through a shared transcript reach the same
    // offset, so they hit the same key and reuse the parse instead of each
    // re-reading + re-JSON.parsing the same file (was O(projects × files)).
    // Routing and ignore-list filtering are cheap and stay per-project (below).
    const cacheKey = filePath + "@" + readStart;
    let parsed = parseCache.get(cacheKey);
    if (!parsed) {
      // Read only the tail [readStart, size).
      const len = st.size - readStart;
      let tail: Buffer;
      let fd: number | null = null;
      try {
        fd = openSync(filePath, "r");
        tail = Buffer.allocUnsafe(len);
        let read = 0;
        while (read < len) {
          const n = readSync(fd, tail, read, len - read, readStart + read);
          if (n <= 0) break; // short read (truncated/rotated) — use what we got
          read += n;
        }
        if (read < len) tail = tail.subarray(0, read);
      } catch {
        continue;
      } finally {
        if (fd !== null) { try { closeSync(fd); } catch {} }
      }

      if (tail.length === 0) {
        // Short read (file truncated/rotated). Intentionally NOT cached: the
        // offset here is this project's own `offset`, not a shareable value —
        // a rare edge, so re-reading it for another sharer is acceptable.
        newOffsets[filePath] = offset;
        continue;
      }

      // Determine where the first COMPLETE line starts. When capped we began at
      // an arbitrary byte that may split a UTF-8 character or a line, so advance
      // to just past the first newline BYTE (0x0a) in the raw buffer — a clean
      // line boundary. Scanning raw bytes (not the decoded string) keeps byte
      // accounting exact even with multibyte Hebrew content.
      let scan = tail;
      let baseOffset = readStart;
      if (capped) {
        const nl = tail.indexOf(0x0a);
        if (nl === -1) {
          // No newline in the whole window — a single >8MB unterminated record.
          // Nothing parseable; skip the window and re-sync on the next sweep.
          newOffsets[filePath] = readStart + tail.length;
          continue;
        }
        scan = tail.subarray(nl + 1);
        baseOffset = readStart + nl + 1;
      }

      const raw = scan.toString("utf8");
      const parts = raw.split("\n");

      // The last element may be a partial (unterminated) line — don't consume it.
      // Complete lines sit between newlines, so each is valid UTF-8 and its
      // decoded byteLength equals its raw byte count exactly (no U+FFFD inflation).
      const completeLines = parts.slice(0, -1);
      let runningBytes = 0;
      for (let i = 0; i < completeLines.length; i++) {
        runningBytes += Buffer.byteLength(completeLines[i] + "\n", "utf8");
      }

      // Parse each complete line into a project-independent record. Only the
      // expensive work (JSON.parse + text extraction + redaction) happens here;
      // it is shared across every project via the cache.
      const records: { cwd: string; line: string }[] = [];
      for (const lineStr of completeLines) {
        const trimmed = lineStr.trim();
        if (!trimmed) continue;

        let obj: any;
        try {
          obj = JSON.parse(trimmed);
        } catch {
          continue;
        }

        const type = obj.type as string;
        if (type !== "user" && type !== "assistant") continue;

        const lineCwd: string = obj.cwd ?? "";
        if (!lineCwd) continue;

        const message = obj.message;
        if (!message) continue;
        const content = message.content;
        if (!content) continue;

        const text = extractTextFromContent(content, type);
        if (!text.trim()) continue;

        // Resolve cwd (cached) for routing + redact once; routing is per-project.
        const resolvedLineCwd = cachedRealpath(lineCwd);
        const redacted = redact(text);
        records.push({
          cwd: resolvedLineCwd,
          line: `[${type.toUpperCase()} ${obj.timestamp ?? ""}] ${redacted}`,
        });
      }

      parsed = { records, newOffset: baseOffset + runningBytes };
      parseCache.set(cacheKey, parsed);
    }

    // Per-project: route each shared record to this project. These are cheap
    // string ops (prefix checks); the ignore list is applied here so it always
    // reflects THIS project's call even though the parse above is shared.
    for (const rec of parsed.records) {
      if (isIgnored(rec.cwd, ignoreList)) continue;
      if (!lineBelongsToProject(rec.cwd, resolvedProjectPath, resolvedOthers))
        continue;
      digestLines.push(rec.line);
    }

    newOffsets[filePath] = parsed.newOffset;
  }

  // Cap total digest at ~30KB, dropping oldest lines with a note
  const MAX_DIGEST_BYTES = 30_000;
  let totalBytes = digestLines.reduce((s, l) => s + l.length, 0);
  let truncated = false;
  while (totalBytes > MAX_DIGEST_BYTES && digestLines.length > 0) {
    const removed = digestLines.shift()!;
    totalBytes -= removed.length;
    truncated = true;
  }
  if (truncated) {
    digestLines.unshift("[... older lines truncated to stay within 30KB cap ...]");
  }

  return {
    digestLines,
    newOffsets,
    count: digestLines.length,
  };
}

/**
 * Seed a project's file offsets to current file sizes (start from NOW).
 * Called on project registration to avoid backfilling history.
 */
export function seedOffsetsToNow(projectPath: string): Record<string, FileState> {
  const files: Record<string, FileState> = {};

  // Find all slug dirs that might contain transcripts for this project
  // We don't know which slug dir belongs to this project yet at registration time,
  // so we seed ALL current jsonl files to their current size.
  for (const slugDir of slugDirs()) {
    const jsonlFiles = findJsonlFiles(slugDir);
    for (const filePath of jsonlFiles) {
      try {
        const size = statSync(filePath).size;
        files[filePath] = { offset: size };
      } catch {
        // skip
      }
    }
  }

  return files;
}
