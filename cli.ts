#!/usr/bin/env bun
/**
 * cli.ts — project-log command line interface.
 * Usage: bun cli.ts <command> [args]
 */

import "./env.ts";
import {
  existsSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  realpathSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

import {
  loadRegistry,
  saveRegistry,
  loadPending,
  savePending,
  loadIgnore,
  saveIgnore,
  loadConfig,
  findProjectForCwd,
  pathToSlug,
  isUnderCodeRoot,
  type RegistryEntry,
} from "./registry.ts";
import {
  seedOffsetsToNow,
  type ProjectState,
} from "./transcript.ts";
import {
  createPage,
  getPage,
  prop,
  titleProp,
  selectProp,
  richTextProp,
  dateProp,
  NotionError,
} from "./notion-api.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE = import.meta.dir;
const STATE_DIR = join(BASE, "state");
const NOTION_JSON_PATH = join(BASE, "notion.json");

function loadNotionConfig(): { projects_db_id: string } {
  if (!existsSync(NOTION_JSON_PATH)) {
    throw new Error(
      `notion.json not found at ${NOTION_JSON_PATH}. Create it with { "projects_db_id": "..." }`
    );
  }
  const raw = JSON.parse(readFileSync(NOTION_JSON_PATH, "utf8"));
  if (!raw.projects_db_id) {
    throw new Error(`notion.json missing 'projects_db_id'`);
  }
  return raw;
}

function atomicWrite(filePath: string, data: unknown): void {
  const tmp = filePath + ".tmp." + randomBytes(4).toString("hex");
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  renameSync(tmp, filePath);
}

function statePath(slug: string): string {
  return join(STATE_DIR, slug + ".json");
}

function stateDir(slug: string): string {
  return join(STATE_DIR, slug);
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
  atomicWrite(statePath(slug), state);
}

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

function guessArea(cwd: string, provided?: string): string {
  if (provided) return provided;
  if (cwd.includes("/geula/")) return "Geula Projects";
  if (cwd.includes("/happyflow/")) return "Happy Flow";
  if (cwd.includes("/personal/")) return "Personal";
  if (cwd.includes("/sunday/")) return "Sunday";
  return "Personal";
}

function writeStateMd(slug: string, entry: RegistryEntry, state: ProjectState): void {
  const dir = stateDir(slug);
  mkdirSync(dir, { recursive: true });
  const lines: string[] = [];
  lines.push(`# ${entry.name}`);
  lines.push(`**Path:** ${entry.cwd}`);
  lines.push(`**Area:** ${entry.area}`);
  lines.push("");
  if (state.nextStepsCache?.value) {
    lines.push("## Your Next Steps");
    lines.push(state.nextStepsCache.value);
    lines.push("");
  }
  lines.push("## Progress");
  lines.push("(No activity logged yet)");
  lines.push("");

  const path = stateMdPath(slug);
  const tmp = path + ".tmp." + randomBytes(4).toString("hex");
  writeFileSync(tmp, lines.join("\n") + "\n", "utf8");
  renameSync(tmp, path);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdStatus(): Promise<void> {
  const registry = loadRegistry();
  const pending = loadPending();

  console.log("\n=== Registered Projects ===");
  if (Object.keys(registry).length === 0) {
    console.log("  (none)");
  } else {
    console.log(
      `${"Project".padEnd(25)} ${"Area".padEnd(20)} ${"Last Synth".padEnd(25)} Path`
    );
    console.log("-".repeat(100));
    for (const [slug, entry] of Object.entries(registry)) {
      const state = loadProjectState(slug);
      const lastSynth = state.lastSynthAt
        ? new Date(state.lastSynthAt).toLocaleString()
        : "never";
      console.log(
        `${entry.name.slice(0, 24).padEnd(25)} ${entry.area.slice(0, 19).padEnd(20)} ${lastSynth.slice(0, 24).padEnd(25)} ${entry.cwd}`
      );
    }
  }

  console.log("\n=== Pending (not tracked) ===");
  if (pending.length === 0) {
    console.log("  (none)");
  } else {
    for (const p of pending) {
      console.log(`  ${p.cwd}  (${p.turns} turns, first seen ${p.firstSeen.slice(0, 10)})`);
    }
  }

  console.log("");
}

async function cmdSweep(dryRun: boolean): Promise<void> {
  const args = ["--sweep"];
  if (dryRun) args.push("--dry-run");
  const result = spawnSync(
    "/opt/homebrew/bin/bun",
    [join(BASE, "synth.ts"), ...args],
    { stdio: "inherit", env: process.env }
  );
  process.exit(result.status ?? 0);
}

async function cmdSync(pathArg: string): Promise<void> {
  const absPath = pathArg === "." ? process.cwd() : resolve(pathArg);
  const result = spawnSync(
    "/opt/homebrew/bin/bun",
    [join(BASE, "synth.ts"), "--project", absPath],
    { stdio: "inherit", env: process.env }
  );
  process.exit(result.status ?? 0);
}

async function cmdRegister(pathArg: string, area?: string): Promise<void> {
  const absPath = pathArg === "." ? process.cwd() : resolve(pathArg);
  const root = gitRoot(absPath);

  // Check if already registered
  const existing = findProjectForCwd(root);
  if (existing) {
    console.log(`Already registered as: ${existing[1].name}`);
    return;
  }

  const slug = pathToSlug(root);
  const name = root.split("/").pop() ?? slug;
  const resolvedArea = guessArea(root, area);

  console.log(`Registering: ${name} (${root})`);
  console.log(`  Area: ${resolvedArea}`);
  console.log(`  Slug: ${slug}`);

  const notionCfg = loadNotionConfig();

  // Create Notion page
  let notionPage: any;
  try {
    notionPage = await createPage(notionCfg.projects_db_id, {
      Name: titleProp(name),
      Status: selectProp("Active"),
      Area: selectProp(resolvedArea),
      "Repo Path": richTextProp(root),
    });
    console.log(`  Notion page: ${notionPage.id}`);
  } catch (e) {
    if (e instanceof NotionError) {
      console.error(`Notion error: ${e.status} ${e.body.slice(0, 200)}`);
    } else {
      console.error("Failed to create Notion page:", e);
    }
    process.exit(1);
  }

  // Seed offsets to NOW
  const files = seedOffsetsToNow(root);

  // Write registry
  const registry = loadRegistry();
  registry[slug] = {
    cwd: root,
    name,
    area: resolvedArea,
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

  // Build initial STATE.md
  writeStateMd(slug, registry[slug], state);

  // Remove from pending if present
  const pending = loadPending();
  const pi = pending.findIndex((p) => p.cwd === root || p.cwd === absPath);
  if (pi !== -1) {
    pending.splice(pi, 1);
    savePending(pending);
  }

  console.log(`Registered successfully. STATE.md written.`);
}

async function cmdIgnore(pathArg: string): Promise<void> {
  const absPath = pathArg === "." ? process.cwd() : resolve(pathArg);
  const ignoreList = loadIgnore();
  if (ignoreList.includes(absPath)) {
    console.log(`Already in ignore list: ${absPath}`);
    return;
  }
  ignoreList.push(absPath);
  saveIgnore(ignoreList);

  // Remove from pending if present
  const pending = loadPending();
  const before = pending.length;
  const filtered = pending.filter(
    (p) => p.cwd !== absPath && !p.cwd.startsWith(absPath + "/")
  );
  if (filtered.length < before) {
    savePending(filtered);
    console.log(`Removed ${before - filtered.length} pending entries.`);
  }

  console.log(`Added to ignore list: ${absPath}`);
}

async function cmdUnregister(pathArg: string): Promise<void> {
  const absPath = pathArg === "." ? process.cwd() : resolve(pathArg);
  const found = findProjectForCwd(absPath);
  if (!found) {
    console.log(`No registered project found for: ${absPath}`);
    return;
  }

  const [slug, entry] = found;
  const registry = loadRegistry();
  delete registry[slug];
  saveRegistry(registry);

  console.log(`Unregistered: ${entry.name}`);
  console.log(`(Notion page ${entry.notion_page_id} is kept)`);
  console.log(
    `State files preserved at: ${stateDir(slug)} — remove manually if desired.`
  );
}

async function cmdPending(): Promise<void> {
  const pending = loadPending();
  if (pending.length === 0) {
    console.log("No pending projects.");
    return;
  }
  console.log("\n=== Pending Projects ===");
  for (const p of pending) {
    console.log(`  ${p.cwd}`);
    console.log(`    Turns: ${p.turns}, First seen: ${p.firstSeen.slice(0, 10)}`);
    console.log(`    To track: bun ${BASE}/cli.ts register ${p.cwd}`);
    console.log(`    To ignore: bun ${BASE}/cli.ts ignore ${p.cwd}`);
  }
  console.log("");
}

async function cmdPull(pathArg: string): Promise<void> {
  const absPath = pathArg === "." ? process.cwd() : resolve(pathArg);
  const found = findProjectForCwd(absPath);
  if (!found) {
    console.error(`No registered project found for: ${absPath}`);
    process.exit(1);
  }

  const [slug, entry] = found;
  const state = loadProjectState(slug);

  console.log(`Pulling from Notion for: ${entry.name}`);

  try {
    const page = await getPage(entry.notion_page_id);
    const nextSteps = prop(page, "Next Steps");
    const suggestedNext = prop(page, "Suggested Next");
    const progress = prop(page, "Progress");
    const statusVal = prop(page, "Status") ?? "Active";

    const now = new Date();
    state.nextStepsCache = {
      value: nextSteps ?? "",
      fetchedAt: now.toISOString(),
    };
    state.statusCache = {
      value: statusVal,
      fetchedAt: now.toISOString(),
    };
    saveProjectState(slug, state);

    // Rebuild STATE.md with new template
    const dir = stateDir(slug);
    mkdirSync(dir, { recursive: true });
    const lines: string[] = [];
    lines.push(`# ${entry.name}`);
    lines.push(`**Path:** ${entry.cwd}`);
    lines.push(`**Area:** ${entry.area}`);
    lines.push(`Status: ${statusVal}`);
    lines.push("");
    if (suggestedNext) {
      lines.push("## Resume Here");
      lines.push(suggestedNext);
      lines.push("");
    }
    if (progress) {
      lines.push("## Progress");
      lines.push(progress);
      lines.push("");
    }
    const recent = state.recentEntries ?? [];
    if (recent.length > 0) {
      lines.push("## Recent Activity");
      for (const re of recent.slice(-5)) {
        lines.push(`**${re.isoDate}**`);
        for (const b of re.bullets) lines.push(`- ${b}`);
      }
      lines.push("");
    }

    const path = stateMdPath(slug);
    const tmp = path + ".tmp." + randomBytes(4).toString("hex");
    writeFileSync(tmp, lines.slice(0, 70).join("\n") + "\n", "utf8");
    renameSync(tmp, path);

    console.log(`STATE.md updated.`);
    if (nextSteps) console.log(`Next Steps: ${nextSteps.slice(0, 100)}`);
    if (suggestedNext) console.log(`Suggested Next: ${suggestedNext.slice(0, 100)}`);
    console.log(`Status: ${statusVal}`);
  } catch (e) {
    if (e instanceof NotionError) {
      console.error(`Notion error: ${e.status} ${e.body.slice(0, 200)}`);
    } else {
      console.error("Failed to pull from Notion:", e);
    }
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);

  try {
    switch (cmd) {
      case "status":
        await cmdStatus();
        break;

      case "doctor": {
        const { doctor } = await import("./doctor.ts");
        process.exit(await doctor());
      }

      case "sweep": {
        const dryRun = rest.includes("--dry-run");
        await cmdSweep(dryRun);
        break;
      }

      case "sync": {
        const pathArg = rest[0] ?? ".";
        await cmdSync(pathArg);
        break;
      }

      case "register": {
        // register <path|.> [--area X]
        const pathArg = rest[0] ?? ".";
        let area: string | undefined;
        const areaIdx = rest.indexOf("--area");
        if (areaIdx !== -1) area = rest[areaIdx + 1];
        await cmdRegister(pathArg, area);
        break;
      }

      case "ignore": {
        const pathArg = rest[0] ?? ".";
        await cmdIgnore(pathArg);
        break;
      }

      case "unregister": {
        const pathArg = rest[0] ?? ".";
        await cmdUnregister(pathArg);
        break;
      }

      case "pending":
        await cmdPending();
        break;

      case "pull": {
        const pathArg = rest[0] ?? ".";
        await cmdPull(pathArg);
        break;
      }

      default:
        console.log(`project-log — Automatic Notion project activity logger

Commands:
  status                     Show all registered projects and pending
  sweep [--dry-run]          Run the sweep (discover + synthesize all projects)
  sync <path|.>              Force-synthesize one project now
  register <path|.>          Register a project and create Notion page
    [--area <area>]            Set area (Personal, Geula Projects, etc.)
  ignore <path|.>            Add path to ignore list
  unregister <path|.>        Remove from registry (Notion page kept)
  pending                    List pending (unregistered) discovered projects
  pull <path|.>              Refresh Next Steps + STATE.md from Notion

Options:
  PROJECTLOG_VERBOSE=1       Enable debug logging to stderr
`);
        break;
    }
  } catch (e) {
    console.error("Error:", e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
