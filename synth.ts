#!/usr/bin/env bun
/**
 * synth.ts — main sweeper + per-project synthesizer.
 * Usage:
 *   bun synth.ts --sweep [--dry-run]
 *   bun synth.ts --project <path>
 */

import "./env.ts";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  openSync,
  closeSync,
  readdirSync,
  statSync,
  realpathSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";

import {
  loadRegistry,
  saveRegistry,
  loadPending,
  savePending,
  loadIgnore,
  loadConfig,
  isIgnored,
  isUnderCodeRoot,
  findProjectForCwd,
  pathToSlug,
  type RegistryEntry,
} from "./registry.ts";
import {
  slugDirs,
  collectDelta,
  resetFileCache,
  seedOffsetsToNow,
  redact,
  type ProjectState,
  type RecentEntry,
} from "./transcript.ts";
import {
  appendBlocks,
  updatePageProps,
  createChildPage,
  createPage,
  getPage,
  prop,
  richTextProp,
  selectProp,
  titleProp,
  dateProp,
  NotionError,
} from "./notion-api.ts";
import { getAnthropicKey } from "./env.ts";
import { extractJsonObject } from "./json-extract.ts";
import { readFileSync as readEnvFile } from "node:fs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BASE = import.meta.dir;
const STATE_DIR = join(BASE, "state");
const SCRATCH_DIR = join(BASE, ".scratch");
const LOCK_PATH = join(BASE, ".lock");
const GLOBAL_STATE_PATH = join(BASE, "global-state.json");
const NOTION_JSON_PATH = join(BASE, "notion.json");

const CLAUDE_BIN = "/Users/yehosef/.local/bin/claude";
const BUN_BIN = "/opt/homebrew/bin/bun";

const VERBOSE = !!process.env.PROJECTLOG_VERBOSE;

function log(...args: any[]) {
  if (VERBOSE) console.error("[synth]", ...args);
}

// ---------------------------------------------------------------------------
// notion.json loader
// ---------------------------------------------------------------------------

interface NotionConfig {
  projects_db_id: string;
}

function loadNotionConfig(): NotionConfig {
  if (!existsSync(NOTION_JSON_PATH)) {
    throw new Error(
      `notion.json not found at ${NOTION_JSON_PATH}. ` +
        `A separate agent should create it with { "projects_db_id": "..." }`
    );
  }
  const raw = JSON.parse(readFileSync(NOTION_JSON_PATH, "utf8"));
  if (!raw.projects_db_id) {
    throw new Error(
      `notion.json missing 'projects_db_id' field at ${NOTION_JSON_PATH}`
    );
  }
  return raw as NotionConfig;
}

// ---------------------------------------------------------------------------
// Global state (lastSweepAt etc.)
// ---------------------------------------------------------------------------

interface GlobalState {
  lastSweepAt?: string;
}

function loadGlobalState(): GlobalState {
  if (!existsSync(GLOBAL_STATE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(GLOBAL_STATE_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveGlobalState(gs: GlobalState): void {
  const tmp = GLOBAL_STATE_PATH + ".tmp." + randomBytes(4).toString("hex");
  writeFileSync(tmp, JSON.stringify(gs, null, 2) + "\n");
  renameSync(tmp, GLOBAL_STATE_PATH);
}

// ---------------------------------------------------------------------------
// Per-project state
// ---------------------------------------------------------------------------

function stateDir(slug: string): string {
  return join(STATE_DIR, slug);
}

function statePath(slug: string): string {
  return join(STATE_DIR, slug + ".json");
}

function stateMdPath(slug: string): string {
  return join(stateDir(slug), "STATE.md");
}

function loadProjectState(slug: string): ProjectState {
  const p = statePath(slug);
  if (!existsSync(p)) return { files: {} };
  try {
    return JSON.parse(readFileSync(p, "utf8")) as ProjectState;
  } catch {
    return { files: {} };
  }
}

function saveProjectState(slug: string, state: ProjectState): void {
  mkdirSync(stateDir(slug), { recursive: true });
  const p = statePath(slug);
  const tmp = p + ".tmp." + randomBytes(4).toString("hex");
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  renameSync(tmp, p);
}

// ---------------------------------------------------------------------------
// Lockfile
// ---------------------------------------------------------------------------

interface LockData {
  pid: number;
  startedAt: string;
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Best-effort guard against PID reuse: only treat a live pid as "our sweep" if
// its command line actually references synth.ts. Prevents us from SIGTERMing an
// innocent, unrelated process that happens to inherit a leaked lock's pid.
function pidIsOurSweep(pid: number): boolean {
  try {
    const r = spawnSync("ps", ["-o", "command=", "-p", String(pid)], {
      encoding: "utf8",
    });
    return r.status === 0 && /synth\.ts/.test(r.stdout);
  } catch {
    return false;
  }
}

function waitForDeath(pid: number, ms: number): boolean {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!pidIsAlive(pid)) return true;
    spawnSync("sleep", ["0.2"]); // brief, non-busy wait
  }
  return !pidIsAlive(pid);
}

// Atomically drop the current lock so two concurrent reclaimers can't both
// delete-then-recreate (which would let both sweeps run). Only the process whose
// rename succeeds removes the file; losers get ENOENT and fall through to retry
// the "wx" create, where exactly one wins. Never blindly unlink during reclaim.
function reclaimLock(): void {
  const tmp = `${LOCK_PATH}.reclaim.${process.pid}`;
  try {
    renameSync(LOCK_PATH, tmp);
    try {
      unlinkSync(tmp);
    } catch {}
  } catch {
    // Someone else already renamed/removed it — fine.
  }
}

function acquireLock(): boolean {
  const HUNG_MS = 3 * 60 * 60 * 1000; // 3h — above worst-case legit sweep (59 projects × 120s ≈ 2h)

  // Up to 2 passes: if we lose a reclaim race on pass 1, the winner's fresh lock
  // is now present and pass 2 sees a live young sweep and correctly holds.
  for (let attempt = 0; attempt < 2; attempt++) {
    // Fast path: create the lock atomically (O_CREAT|O_EXCL via "wx").
    try {
      const fd = openSync(LOCK_PATH, "wx");
      const data: LockData = { pid: process.pid, startedAt: new Date().toISOString() };
      writeFileSync(fd, Buffer.from(JSON.stringify(data), "utf8"));
      try { closeSync(fd); } catch {}
      return true;
    } catch (e: any) {
      if (e.code !== "EEXIST") throw e;
      // Lock already exists — evaluate whether it is reclaimable.
    }

    let lockData: LockData | null = null;
    try {
      lockData = JSON.parse(readFileSync(LOCK_PATH, "utf8"));
    } catch {
      lockData = null; // corrupt / unreadable / vanished between existsSync and read
    }

    if (!lockData || typeof lockData.pid !== "number") {
      // Corrupt, `null`, or malformed lock — reclaim atomically and retry create.
      reclaimLock();
      continue;
    }

    const alive = pidIsAlive(lockData.pid);
    const ageMs = Date.now() - new Date(lockData.startedAt).getTime();
    const ageKnown = Number.isFinite(ageMs);

    if (alive) {
      // A live process holds the lock. NEVER steal from it before the hung
      // ceiling — that is exactly the bug that made sweeps stack. A bogus
      // (NaN) timestamp also holds rather than risk killing a healthy sweep.
      if (!ageKnown || ageMs < HUNG_MS) return false;

      // Past the hung ceiling. Only kill if it is genuinely one of our sweeps;
      // otherwise it is a reused pid on a leaked lock — reclaim the file but do
      // NOT touch the unrelated process.
      if (pidIsOurSweep(lockData.pid)) {
        log(`Terminating hung sweep pid=${lockData.pid} (age=${Math.round(ageMs / 1000)}s)`);
        try { process.kill(lockData.pid, "SIGTERM"); } catch {}
        if (!waitForDeath(lockData.pid, 5000)) {
          try { process.kill(lockData.pid, "SIGKILL"); } catch {}
          if (!waitForDeath(lockData.pid, 3000)) {
            // Survived even SIGKILL (uninterruptible D-state, e.g. a wedged
            // disk/NFS read). Do NOT reclaim — starting a new sweep now would
            // stack it on the still-alive one, the exact bug we're fixing. Back
            // off; a later tick retries once the process finally dies.
            log(`pid=${lockData.pid} survived SIGKILL — backing off, not reclaiming`);
            return false;
          }
        }
      } else {
        log(`Reclaiming leaked lock held by reused pid=${lockData.pid} (not a sweep)`);
      }
      reclaimLock();
      continue;
    }

    // pid is dead → safe to reclaim.
    log(`Reclaiming lock from dead pid=${lockData.pid} (age=${ageKnown ? Math.round(ageMs / 1000) + "s" : "unknown"})`);
    reclaimLock();
    continue;
  }

  // Lost the create race twice — another sweep owns the lock now. Back off.
  return false;
}

function releaseLock(): void {
  // Only remove the lock if WE still own it. A hung-sweep takeover may have
  // reclaimed it and handed it to a newer sweep; deleting that would let a
  // third sweep stack. So verify ownership before unlinking.
  let lockData: LockData | null = null;
  try {
    lockData = JSON.parse(readFileSync(LOCK_PATH, "utf8"));
  } catch {
    return; // nothing readable to release
  }
  if (lockData && lockData.pid === process.pid) {
    try {
      unlinkSync(LOCK_PATH);
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// Claude headless synthesis
// ---------------------------------------------------------------------------

interface SynthResult {
  progress: string;
  suggested_next: string;
  open_questions: string[];
  blockers: string[];
  bullets: string[];
}

function runClaudeSynth(digest: string): SynthResult | null {
  const prompt =
    'You are summarizing a development-session delta for a project activity log. ' +
    'Output STRICT JSON: ' +
    '{"progress": "<one line, current state>", ' +
    '"suggested_next": "<ONE concrete next action — name the specific file, command, or function to touch where the delta makes it knowable; not vague>", ' +
    '"open_questions": ["unresolved choices or decisions-in-flight, and the WHY behind notable decisions; [] if none"], ' +
    '"blockers": ["what is stalling progress / what you\'re waiting on; [] if none — be conservative, only real blockers"], ' +
    '"bullets": ["2-5 concise bullets of what happened"]}. ' +
    'No verbatim quotes, no credentials, no code blocks.\n\n' +
    digest;

  mkdirSync(SCRATCH_DIR, { recursive: true });

  const apiKey = getAnthropicKey();
  // Replace the default system prompt so this behaves as a clean, single-shot
  // JSON completion rather than an agent. Without this, subscription `claude -p`
  // loads the user's global CLAUDE.md and tools, goes multi-turn, and sometimes
  // replies in prose ("Nothing to commit here…") — which breaks JSON parsing.
  // Disabling tools keeps it to one turn.
  const synthSystem =
    "You are a non-interactive JSON generator for an automated logging pipeline. " +
    "Do not use tools. Do not converse, explain, or add any commentary. " +
    "Output exactly one JSON object matching the schema in the user message — " +
    "nothing before it, nothing after it, no markdown fences.";
  const args = [
    "-p",
    "--model",
    "claude-haiku-4-5",
    "--output-format",
    "json",
    "--system-prompt",
    synthSystem,
    "--disallowed-tools",
    "Bash,Read,Edit,Write,Glob,Grep,Task,WebFetch,WebSearch,NotebookEdit,TodoWrite",
  ];
  if (apiKey) {
    args.push("--bare");
  }

  // Inherit the full env: claude's keychain credential lookup needs USER (and
  // possibly other session vars) — a minimal env yields "Not logged in".
  const env: Record<string, string | undefined> = {
    ...process.env,
    PATH: `/opt/homebrew/bin:/Users/yehosef/.local/bin:${process.env.PATH ?? "/usr/bin:/bin"}`,
    HOME: process.env.HOME ?? "/Users/yehosef",
    USER: process.env.USER ?? "yehosef",
    LOGNAME: process.env.LOGNAME ?? "yehosef",
    CLAUDE_PROJECTLOG_SYNTH: "1",
  };
  if (apiKey) {
    env.ANTHROPIC_API_KEY = apiKey;
  }

  log(`Running claude ${args.join(" ")} with ${digest.length} char digest`);

  const result = spawnSync(CLAUDE_BIN, args, {
    input: prompt,
    cwd: SCRATCH_DIR,
    env,
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
    encoding: "utf8",
  });

  if (result.error || result.status !== 0) {
    log(
      `claude exited with status ${result.status}: ${result.stderr?.slice(0, 500)}`
    );
    return null;
  }

  const stdout = result.stdout ?? "";
  log(`claude output (${stdout.length} chars): ${stdout.slice(0, 200)}`);

  // Parse the outer --output-format json envelope
  let outerJson: any;
  try {
    outerJson = JSON.parse(stdout);
  } catch {
    // Maybe no envelope (when not using --bare with subscription creds)
    outerJson = { result: stdout };
  }

  const innerRaw: string =
    outerJson?.result ?? outerJson?.content ?? outerJson?.text ?? stdout;

  // Strip markdown fences if present
  const stripped = innerRaw
    .replace(/^```(?:json)?\s*/m, "")
    .replace(/\s*```\s*$/m, "")
    .trim();

  // The model sometimes wraps the JSON in prose ("Here's the summary JSON: {...}")
  // or a code fence, so a strict JSON.parse of the whole response fails and the
  // synthesis is lost. Extract the first balanced {...} object instead.
  const parsed = extractJsonObject(stripped) ?? extractJsonObject(innerRaw);
  if (parsed) {
    return {
      progress: parsed.progress ?? "",
      suggested_next: parsed.suggested_next ?? "",
      open_questions: Array.isArray(parsed.open_questions) ? parsed.open_questions : [],
      blockers: Array.isArray(parsed.blockers) ? parsed.blockers : [],
      bullets: Array.isArray(parsed.bullets) ? parsed.bullets : [],
    } as SynthResult;
  }
  log(`Failed to parse inner JSON: ${stripped.slice(0, 300)}`);
  return null;
}

// extractJsonObject moved to ./json-extract.ts (pure + unit-tested).

// ---------------------------------------------------------------------------
// Git context gathering
// ---------------------------------------------------------------------------

interface GitContext {
  isRepo: boolean;
  branch: string;
  recentCommits: string[]; // up to 10 lines
  uncommittedFiles: string[]; // up to 30 lines
}

function gatherGitContext(cwd: string): GitContext {
  // Check if inside a git repo
  const check = spawnSync("git", ["-C", cwd, "rev-parse", "--is-inside-work-tree"], {
    encoding: "utf8",
    timeout: 5000,
  });
  if (check.status !== 0) {
    return { isRepo: false, branch: "", recentCommits: [], uncommittedFiles: [] };
  }

  // Branch
  const branchRes = spawnSync("git", ["-C", cwd, "branch", "--show-current"], {
    encoding: "utf8",
    timeout: 5000,
  });
  const branch = (branchRes.status === 0 ? branchRes.stdout.trim() : "") || "(detached)";

  // Recent commits (last 10, within 14 days)
  const logRes = spawnSync(
    "git",
    ["-C", cwd, "log", "--oneline", "-10", '--since=14 days ago'],
    { encoding: "utf8", timeout: 5000 }
  );
  const recentCommits =
    logRes.status === 0
      ? logRes.stdout.trim().split("\n").filter(Boolean).slice(0, 10)
      : [];

  // Uncommitted files (status --porcelain, capped at 30 lines)
  const statusRes = spawnSync("git", ["-C", cwd, "status", "--porcelain"], {
    encoding: "utf8",
    timeout: 5000,
  });
  const uncommittedFiles =
    statusRes.status === 0
      ? statusRes.stdout.trim().split("\n").filter(Boolean).slice(0, 30)
      : [];

  return { isRepo: true, branch, recentCommits, uncommittedFiles };
}

function buildGitBlock(ctx: GitContext): string {
  if (!ctx.isRepo) return "";
  const lines: string[] = ["=== GIT CONTEXT ==="];
  lines.push(`Branch: ${ctx.branch}`);
  if (ctx.recentCommits.length > 0) {
    lines.push(`Recent commits (last 14 days):`);
    for (const c of ctx.recentCommits) lines.push(`  ${c}`);
  } else {
    lines.push("Recent commits: (none in last 14 days)");
  }
  if (ctx.uncommittedFiles.length > 0) {
    lines.push(`Uncommitted files:`);
    for (const f of ctx.uncommittedFiles) lines.push(`  ${f}`);
  } else {
    lines.push("Uncommitted files: (working tree clean)");
  }
  lines.push("=== END GIT CONTEXT ===");
  const block = lines.join("\n");
  // Cap at ~3KB
  return block.slice(0, 3000);
}

// ---------------------------------------------------------------------------
// Notion Activity Log
// ---------------------------------------------------------------------------

async function getOrCreateLogPage(
  projectPageId: string,
  slug: string,
  state: ProjectState,
  yearMonth: string, // "YYYY-MM"
  dryRun: boolean
): Promise<string | null> {
  if (state.logPages?.[yearMonth]) {
    return state.logPages[yearMonth];
  }

  const title = `Log ${yearMonth}`;
  if (dryRun) {
    console.log(`  [dry-run] Would create log child page: "${title}"`);
    return null;
  }

  const page = await createChildPage(projectPageId, title);
  if (!state.logPages) state.logPages = {};
  state.logPages[yearMonth] = page.id;
  log(`Created log page "${title}" with id ${page.id}`);
  return page.id;
}

async function appendActivityLogEntry(
  logPageId: string,
  isoDatetime: string,
  bullets: string[],
  dryRun: boolean,
  gitCtx?: GitContext
): Promise<void> {
  if (dryRun) {
    console.log(`  [dry-run] Would append activity log entry at ${isoDatetime}`);
    for (const b of bullets) console.log(`    - ${b}`);
    return;
  }

  const blocks: any[] = [
    {
      object: "block",
      type: "heading_3",
      heading_3: {
        rich_text: [{ type: "text", text: { content: isoDatetime } }],
      },
    },
  ];

  // Optional italic git line under the heading (branch + commit count)
  if (gitCtx?.isRepo && gitCtx.branch) {
    const commitCount = gitCtx.recentCommits.length;
    const gitLine = `${gitCtx.branch} · ${commitCount} recent commit${commitCount !== 1 ? "s" : ""}`;
    blocks.push({
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: [{ type: "text", text: { content: gitLine }, annotations: { italic: true } }],
      },
    });
  }

  blocks.push(
    ...bullets.map((b) => ({
      object: "block",
      type: "bulleted_list_item",
      bulleted_list_item: {
        rich_text: [{ type: "text", text: { content: b.slice(0, 2000) } }],
      },
    }))
  );

  await appendBlocks(logPageId, blocks);
}

// ---------------------------------------------------------------------------
// STATE.md generation
// ---------------------------------------------------------------------------

function generateStateMd(
  entry: RegistryEntry,
  state: ProjectState,
  synthResult: SynthResult | null,
  gitCtx?: GitContext
): string {
  const lines: string[] = [];
  lines.push(`# ${entry.name}`);
  lines.push(`**Path:** ${entry.cwd}`);
  lines.push(`**Area:** ${entry.area}`);
  const status = state.statusCache?.value ?? "Active";
  lines.push(`Status: ${status}`);
  lines.push("");

  // Git branch line (omit if not a repo)
  if (gitCtx?.isRepo && gitCtx.branch) {
    const commitCount = gitCtx.recentCommits.length;
    lines.push(`**Branch:** ${gitCtx.branch} · ${commitCount} recent commit${commitCount !== 1 ? "s" : ""}`);
    lines.push("");
  }

  // Resume Here (synth-owned: suggested_next)
  if (synthResult?.suggested_next) {
    lines.push("## Resume Here");
    lines.push(synthResult.suggested_next);
    lines.push("");
  }

  // Open Questions (omit section if empty)
  const openQ = synthResult?.open_questions ?? [];
  if (openQ.length > 0) {
    lines.push("## Open Questions");
    for (const q of openQ) lines.push(`- ${q}`);
    lines.push("");
  }

  // Blocked / Waiting (omit if empty)
  const blockers = synthResult?.blockers ?? [];
  if (blockers.length > 0) {
    lines.push("## Blocked / Waiting");
    for (const b of blockers) lines.push(`- ${b}`);
    lines.push("");
  }

  // Progress
  if (synthResult?.progress) {
    lines.push("## Progress");
    lines.push(synthResult.progress);
    lines.push("");
  }

  // Recent Activity (last 5 entries)
  const recent = state.recentEntries ?? [];
  if (recent.length > 0) {
    lines.push("## Recent Activity");
    for (const re of recent.slice(-5)) {
      lines.push(`**${re.isoDate}**`);
      for (const b of re.bullets) {
        lines.push(`- ${b}`);
      }
    }
    lines.push("");
  }

  // Cap at ~70 lines
  return lines.slice(0, 70).join("\n") + "\n";
}

function writeStateMd(slug: string, content: string): void {
  const dir = stateDir(slug);
  mkdirSync(dir, { recursive: true });
  const path = stateMdPath(slug);
  const tmp = path + ".tmp." + randomBytes(4).toString("hex");
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, path);
}

// ---------------------------------------------------------------------------
// Per-project synthesis
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Status cache helpers
// ---------------------------------------------------------------------------

/** Status values the user owns; auto-changes are never applied to these. */
const USER_OWNED_STATUSES = new Set(["Done", "Idea"]);

/**
 * Lazily refresh statusCache from Notion (same ≥1h staleness as nextStepsCache).
 * Mutates state in place; does NOT save — caller must save.
 */
async function refreshStatusCacheIfStale(
  state: ProjectState,
  entry: RegistryEntry,
  now: Date
): Promise<void> {
  const cacheAge = state.statusCache
    ? Date.now() - new Date(state.statusCache.fetchedAt).getTime()
    : Infinity;
  if (cacheAge <= 3_600_000) return; // still fresh

  try {
    const page = await getPage(entry.notion_page_id);
    const statusVal = prop(page, "Status") ?? "Active";
    state.statusCache = { value: statusVal, fetchedAt: now.toISOString() };
    log(`Refreshed Status cache: ${statusVal}`);
  } catch (e) {
    log(`Failed to refresh Status cache: ${e}`);
  }
}

type ProcessResult = "synced" | "debounced" | "deferred" | "failed";

async function processProject(
  slug: string,
  entry: RegistryEntry,
  otherProjectCwds: string[],
  dryRun: boolean,
  isSweep: boolean = false,
  allowSynth: boolean = true
): Promise<ProcessResult> {
  const ignoreList = loadIgnore();
  const state = loadProjectState(slug);

  log(`Processing project: ${entry.name} (${entry.cwd})`);

  const now = new Date();

  // --- Staleness → Paused pass (sweep-only) ---
  // Run BEFORE delta check so it happens even if no new activity.
  if (isSweep && !dryRun) {
    const cachedStatus = state.statusCache?.value ?? "Active";
    if (!USER_OWNED_STATUSES.has(cachedStatus) && cachedStatus === "Active") {
      const lastSynthAt = state.lastSynthAt
        ? new Date(state.lastSynthAt).getTime()
        : 0;
      const ageMs = lastSynthAt > 0 ? Date.now() - lastSynthAt : Infinity;
      const FOURTEEN_DAYS_MS = 14 * 24 * 3_600_000;
      if (ageMs > FOURTEEN_DAYS_MS) {
        log(`Project ${entry.name} stale (${Math.round(ageMs / 86_400_000)}d) → Paused`);
        try {
          await updatePageProps(entry.notion_page_id, { Status: selectProp("Paused") });
          state.statusCache = { value: "Paused", fetchedAt: now.toISOString() };
          saveProjectState(slug, state);
          log(`Set Status=Paused for ${entry.name}`);
        } catch (e) {
          log(`Failed to set Paused for ${entry.name}: ${e}`);
        }
      }
    }
  }

  // Collect delta
  const delta = await collectDelta({
    projectPath: entry.cwd,
    state,
    ignoreList,
    otherProjectCwds,
  });

  log(`Delta: ${delta.count} lines from ${Object.keys(delta.newOffsets).length} files`);

  // Debounce: need at least 3 new lines
  if (delta.count < 3) {
    log(`Debounce: only ${delta.count} lines, skipping`);
    return "debounced";
  }

  const digest = delta.digestLines.join("\n");

  if (dryRun) {
    console.log(`\n[dry-run] Would synthesize for: ${entry.name}`);
    console.log(`  ${delta.count} new lines, digest ${digest.length} chars`);
    return "debounced";
  }

  // Per-sweep synthesis budget reached: leave this project's delta for the next
  // sweep (offsets NOT advanced, so nothing is lost). Combined with stalest-first
  // ordering, this bounds each sweep's wall-time so it reliably completes, while
  // still draining a backlog a few projects per sweep.
  if (!allowSynth) {
    log(`Deferred ${entry.name} (${delta.count} lines) — sweep synth budget reached`);
    return "deferred";
  }

  // Gather git context only now that we know we'll synthesize. Each call spawns
  // ~4 git subprocesses; doing it for every debounced project was the bulk of
  // sweep wall-time (≈200 git spawns/sweep). Now it runs only for projects with
  // real new activity.
  const gitCtx = gatherGitContext(entry.cwd);
  log(`Git context: isRepo=${gitCtx.isRepo}, branch=${gitCtx.branch}, commits=${gitCtx.recentCommits.length}`);

  // Build git context block and prepend to digest
  const gitBlock = buildGitBlock(gitCtx);
  const fullDigest = gitBlock
    ? redact(gitBlock) + "\n\n" + redact(digest)
    : redact(digest);

  // Run claude synthesis
  const synthResult = runClaudeSynth(fullDigest);

  if (!synthResult) {
    console.error(`[sweep] synth-FAILED ${entry.name} (parse/model error)`);
    // Still advance offsets? No — per spec, only advance after successful Notion write.
    return "failed";
  }

  const isoDatetime = now.toISOString().replace("T", " ").slice(0, 16);
  const yearMonth = now.toISOString().slice(0, 7); // "YYYY-MM"

  // Notion write (wrapped so one failure doesn't abort sweep)
  try {
    const logPageId = await getOrCreateLogPage(
      entry.notion_page_id,
      slug,
      state,
      yearMonth,
      dryRun
    );

    if (logPageId) {
      await appendActivityLogEntry(
        logPageId,
        isoDatetime,
        synthResult.bullets,
        dryRun,
        gitCtx
      );
    }

    // Lazily refresh both caches (next steps + status) if stale
    const nextStepsCacheAge = state.nextStepsCache
      ? Date.now() - new Date(state.nextStepsCache.fetchedAt).getTime()
      : Infinity;
    if (nextStepsCacheAge > 3_600_000) {
      try {
        const page = await getPage(entry.notion_page_id);
        const nextSteps = prop(page, "Next Steps");
        const statusVal = prop(page, "Status") ?? "Active";
        state.nextStepsCache = { value: nextSteps ?? "", fetchedAt: now.toISOString() };
        state.statusCache = { value: statusVal, fetchedAt: now.toISOString() };
        log(`Refreshed Next Steps: ${nextSteps?.slice(0, 50)}, Status: ${statusVal}`);
      } catch (e) {
        log(`Failed to refresh Next Steps/Status: ${e}`);
        // Try status cache refresh independently
        await refreshStatusCacheIfStale(state, entry, now);
      }
    } else {
      // Next steps fresh; check status independently
      await refreshStatusCacheIfStale(state, entry, now);
    }

    // --- Auto Status: Active on real activity ---
    const cachedStatus = state.statusCache?.value ?? "Active";
    let newStatus: string | null = null;
    if (!USER_OWNED_STATUSES.has(cachedStatus) && cachedStatus !== "Active") {
      newStatus = "Active";
    }
    if (newStatus) {
      try {
        await updatePageProps(entry.notion_page_id, { Status: selectProp(newStatus) });
        state.statusCache = { value: newStatus, fetchedAt: now.toISOString() };
        log(`Set Status=${newStatus} for ${entry.name}`);
      } catch (e) {
        log(`Failed to set Status=${newStatus} for ${entry.name}: ${e}`);
      }
    }

    // Build props to update (excluding "Next Steps" — user-owned)
    const openQText = synthResult.open_questions.join("\n• ");
    const blockersText = synthResult.blockers.join("\n• ");
    const propsToUpdate: Record<string, any> = {
      Progress: richTextProp(synthResult.progress),
      "Suggested Next": richTextProp(synthResult.suggested_next),
      "Open Questions": richTextProp(openQText),
      Blockers: richTextProp(blockersText),
      "Last Worked": dateProp(now.toISOString()), // full datetime → relative "ago" + precise sort
    };
    if (newStatus || (!USER_OWNED_STATUSES.has(cachedStatus) && cachedStatus === "Active")) {
      // Status already written above if newStatus; add to props if active (avoid double-write by checking)
      // Only include in batch if it wasn't already written above
      if (!newStatus) {
        // Already Active and already correct — don't redundantly write
      }
    }
    await updatePageProps(entry.notion_page_id, propsToUpdate);

    // Update recentEntries (rolling max 5)
    const newEntry: RecentEntry = {
      isoDate: isoDatetime,
      bullets: synthResult.bullets,
    };
    const recent = state.recentEntries ?? [];
    recent.push(newEntry);
    state.recentEntries = recent.slice(-5);

    // ONLY after successful Notion write: advance offsets and write state
    for (const [file, offset] of Object.entries(delta.newOffsets)) {
      state.files[file] = { offset };
    }
    state.lastSynthAt = now.toISOString();

    saveProjectState(slug, state);
    log(`Saved state for ${slug}`);

    // Write STATE.md
    const stateMd = generateStateMd(entry, state, synthResult, gitCtx);
    writeStateMd(slug, stateMd);
    log(`Wrote STATE.md for ${slug}`);
    console.error(`[sweep] synced ${entry.name} (${delta.count} lines)`);
    return "synced";
  } catch (e) {
    if (e instanceof NotionError) {
      console.error(
        `[sweep] Notion-FAILED ${entry.name}: ${e.status} ${e.body.slice(0, 160)}`
      );
    } else {
      console.error(`[sweep] error ${entry.name}:`, e);
    }
    // Do NOT advance offsets on failure
    return "failed";
  }
}

// ---------------------------------------------------------------------------
// Discovery / sweep
// ---------------------------------------------------------------------------

/** Extract distinct cwds and assistant-turn counts from recent transcript files. */
function discoverFromTranscripts(since: number): Map<string, number> {
  const cwdTurns = new Map<string, number>(); // cwd -> assistant turn count

  for (const slugDir of slugDirs()) {
    // Find all jsonl files
    const files = findJsonlFilesRecursive(slugDir);
    for (const file of files) {
      try {
        const mtime = statSync(file).mtimeMs;
        if (mtime < since) continue;
      } catch {
        continue;
      }

      // Sample lines
      try {
        const content = readFileSync(file, "utf8");
        for (const lineStr of content.split("\n")) {
          const trimmed = lineStr.trim();
          if (!trimmed) continue;
          let obj: any;
          try { obj = JSON.parse(trimmed); } catch { continue; }
          if (obj.type !== "user" && obj.type !== "assistant") continue;
          const cwd = obj.cwd ?? "";
          if (!cwd) continue;
          if (obj.type === "assistant") {
            cwdTurns.set(cwd, (cwdTurns.get(cwd) ?? 0) + 1);
          } else {
            if (!cwdTurns.has(cwd)) cwdTurns.set(cwd, 0);
          }
        }
      } catch {
        continue;
      }
    }
  }

  return cwdTurns;
}

function findJsonlFilesRecursive(dir: string): string[] {
  const results: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...findJsonlFilesRecursive(full));
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        results.push(full);
      }
    }
  } catch {}
  return results;
}

/** Get git root for a directory, or fallback to the dir itself. */
function gitRoot(cwd: string): string {
  const result = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    timeout: 5000,
  });
  if (result.status === 0 && result.stdout.trim()) {
    return result.stdout.trim();
  }
  return cwd;
}

/** Guess area from path. */
function guessArea(cwd: string): string {
  if (cwd.includes("/geula/")) return "Geula Projects";
  if (cwd.includes("/happyflow/")) return "Happy Flow";
  if (cwd.includes("/personal/")) return "Personal";
  if (cwd.includes("/sunday/")) return "Sunday";
  return "Personal";
}

async function runSweep(dryRun: boolean): Promise<void> {
  resetFileCache(); // read each transcript from disk at most once per sweep

  const gs = loadGlobalState();
  const lastSweepAt = gs.lastSweepAt
    ? new Date(gs.lastSweepAt).getTime()
    : Date.now() - 24 * 3_600_000; // first run: last 24h

  const ignoreList = loadIgnore();
  const config = loadConfig();
  const registry = loadRegistry();
  const pending = loadPending();

  // Step 1: discover cwds from recent transcripts
  const cwdTurns = discoverFromTranscripts(lastSweepAt);
  log(`Discovered ${cwdTurns.size} distinct cwds`);

  // Step 2: process discovered cwds — deduplicate by resolved git root
  const notionConfig = loadNotionConfig();

  // First resolve all cwds to git roots, accumulate max turns per root
  const rootTurns = new Map<string, number>(); // resolved root -> max turns
  for (const [cwd, turns] of cwdTurns) {
    let resolvedCwd: string;
    try { resolvedCwd = realpathSync(cwd); } catch { resolvedCwd = cwd; }
    if (isIgnored(resolvedCwd, ignoreList)) {
      log(`Ignored: ${cwd}`);
      continue;
    }
    if (findProjectForCwd(cwd)) continue; // already registered

    const root = gitRoot(cwd);
    let resolvedRoot: string;
    try { resolvedRoot = realpathSync(root); } catch { resolvedRoot = root; }
    if (isIgnored(resolvedRoot, ignoreList)) {
      log(`Ignored (git root): ${root}`);
      continue;
    }
    // accumulate max turns per git root
    rootTurns.set(root, Math.max(rootTurns.get(root) ?? 0, turns));
  }

  for (const [root, turns] of rootTurns) {
    let resolvedRoot: string;
    try { resolvedRoot = realpathSync(root); } catch { resolvedRoot = root; }

    // Re-check if registered after previous iterations may have registered it
    if (findProjectForCwd(root)) continue;

    // Already pending?
    const existingPending = pending.find((p) => p.cwd === root);

    // Track-by-default (opt-out): auto-register any non-ignored project with real
    // activity. ignore.json (checked above) is the only opt-out. The turns>=3 floor
    // is a junk filter (skip barely-touched dirs), NOT an approval gate.
    if (turns >= 3) {
      // Auto-register
      const slug = pathToSlug(root);
      const name = root.split("/").pop() ?? slug;
      const area = guessArea(root);

      if (dryRun) {
        console.log(`[dry-run] Would auto-register: ${root} (${turns} turns, area=${area})`);
        continue;
      }

      log(`Auto-registering: ${root}`);

      // Create Notion page
      let notionPage: any;
      try {
        notionPage = await createPage(notionConfig.projects_db_id, {
          Name: titleProp(name),
          Status: selectProp("Active"),
          Area: selectProp(area),
          "Repo Path": richTextProp(root),
        });
      } catch (e) {
        console.error(`[synth] Failed to create Notion page for ${root}:`, e);
        continue;
      }

      // Seed offsets to now
      const files = seedOffsetsToNow(root);

      // Write registry
      registry[slug] = {
        cwd: root,
        name,
        area,
        notion_page_id: notionPage.id,
        created: new Date().toISOString(),
      };
      saveRegistry(registry);

      // Write initial state
      const state: ProjectState = {
        files,
        lastSynthAt: new Date().toISOString(),
      };
      saveProjectState(slug, state);

      // Remove from pending if present
      const pi = pending.findIndex((p) => p.cwd === root);
      if (pi !== -1) pending.splice(pi, 1);

      console.log(`Registered: ${name} (${root})`);
    } else {
      // Add/update pending
      if (!existingPending) {
        if (dryRun) {
          console.log(`[dry-run] Would add to pending: ${root} (${turns} turns)`);
        } else {
          pending.push({
            cwd: root,
            firstSeen: new Date().toISOString(),
            turns,
          });
          log(`Added to pending: ${root}`);
        }
      } else {
        existingPending.turns = Math.max(existingPending.turns, turns);
      }
    }
  }

  if (!dryRun) {
    savePending(pending);
  }

  // Step 3: process registered projects STALEST-FIRST (least-recently-synced),
  // so an interrupted sweep still drains the most-overdue projects rather than
  // always neglecting the same late-registered ones. Cap synthesis (claude +
  // Notion) calls per sweep so each sweep stays bounded and reliably completes;
  // deferred projects keep their offsets and sync on the next sweep.
  const allCwds = Object.values(registry).map((e) => e.cwd);
  const ordered = Object.entries(registry)
    .map(([slug, entry]) => {
      const st = loadProjectState(slug);
      const lsa = st.lastSynthAt ? new Date(st.lastSynthAt).getTime() : 0;
      return { slug, entry, lsa };
    })
    .sort((a, b) => a.lsa - b.lsa);

  const MAX_SYNTH = 8;
  let synthCount = 0;
  let synced = 0;
  let failed = 0;
  let deferred = 0;
  const sweepStart = Date.now();
  console.error(
    `[sweep] START ${new Date().toISOString()} pid=${process.pid} projects=${ordered.length}`
  );

  for (const { slug, entry } of ordered) {
    const otherCwds = allCwds.filter((c) => c !== entry.cwd);
    try {
      const res = await processProject(
        slug,
        entry,
        otherCwds,
        dryRun,
        true,
        synthCount < MAX_SYNTH
      );
      if (res === "synced") { synthCount++; synced++; }
      else if (res === "failed") { synthCount++; failed++; }
      else if (res === "deferred") { deferred++; }
    } catch (e) {
      failed++;
      console.error(`[sweep] error processing ${entry.name}:`, e);
    }
  }

  const dur = Math.round((Date.now() - sweepStart) / 1000);
  console.error(
    `[sweep] DONE ${dur}s synced=${synced} failed=${failed} deferred=${deferred}`
  );

  // Advance the discovery watermark ONLY after the loop completes, so an
  // interrupted/killed sweep does not falsely mark itself done.
  if (!dryRun) {
    saveGlobalState({ ...gs, lastSweepAt: new Date().toISOString() });
  }
}

// ---------------------------------------------------------------------------
// Per-project mode
// ---------------------------------------------------------------------------

async function runProject(projectPath: string): Promise<void> {
  const absPath = resolve(projectPath);
  const found = findProjectForCwd(absPath);

  if (!found) {
    console.error(
      `[synth] No registered project found for path: ${absPath}\n` +
        `Run: bun cli.ts register ${absPath}`
    );
    process.exit(1);
  }

  const [slug, entry] = found;
  const registry = loadRegistry();
  const allCwds = Object.values(registry).map((e) => e.cwd);
  const otherCwds = allCwds.filter((c) => c !== entry.cwd);

  await processProject(slug, entry, otherCwds, false, false);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");

  if (args[0] === "--sweep") {
    const acquired = acquireLock();
    if (!acquired) {
      // Another instance is running — exit silently
      process.exit(0);
    }

    // Reliability: ensure the lock is released even on a hard crash (uncaught
    // error / unhandled rejection), so a leaked lock can't freeze future sweeps.
    // Handlers are installed only AFTER we own the lock, so we never delete
    // another process's lock.
    const onFatal = (label: string) => (e: unknown) => {
      console.error(`[synth] ${label}:`, e);
      try { releaseLock(); } catch {}
      process.exit(1);
    };
    process.on("uncaughtException", onFatal("uncaughtException"));
    process.on("unhandledRejection", onFatal("unhandledRejection"));

    try {
      await runSweep(dryRun);
    } finally {
      releaseLock();
    }
  } else if (args[0] === "--project") {
    const projectPath = args[1];
    if (!projectPath) {
      console.error("Usage: bun synth.ts --project <path>");
      process.exit(1);
    }

    const acquired = acquireLock();
    if (!acquired) {
      console.error("[synth] Another synth instance is running. Try again.");
      process.exit(1);
    }

    try {
      await runProject(projectPath);
    } finally {
      releaseLock();
    }
  } else {
    console.error("Usage: bun synth.ts --sweep [--dry-run] | --project <path>");
    process.exit(1);
  }
}
