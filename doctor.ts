/**
 * doctor.ts — health check for the project-log sync pipeline.
 * Repeatable visibility, no claims: reads the registry, the sweep log, and
 * Notion, and reports what is actually true. Run: bun cli.ts doctor
 *
 * Exit code 0 if healthy, 1 if there are stale projects or interrupted sweeps.
 */
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const BASE = import.meta.dir;
const HOME = process.env.HOME ?? homedir();
const LOG = join(HOME, ".claude", "logs", "projectlog.out.log");
const SETTINGS = join(HOME, ".claude", "settings.json");
const PROJECTS = join(HOME, ".claude", "projects");

function readJson(p: string): any { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } }
function token(): string {
  const raw = readFileSync(join(BASE, ".env"), "utf8");
  for (const l of raw.split("\n")) if (l.trim().startsWith("NOTION_TOKEN=")) return l.trim().slice("NOTION_TOKEN=".length).trim();
  return "";
}
function ago(ms: number): string {
  if (!ms) return "never";
  const d = Date.now() - ms, m = Math.floor(d / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  const dd = Math.floor(h / 24); return dd < 30 ? `${dd}d ago` : `${Math.floor(dd / 30)}mo ago`;
}

export async function doctor(): Promise<number> {
  let problems = 0;
  console.log("=== project-log doctor ===\n");

  // 1. Hooks wired?
  const settings = readJson(SETTINGS) ?? {};
  const hooks = settings.hooks ?? {};
  const has = (k: string, needle: string) =>
    JSON.stringify(hooks[k] ?? []).includes(needle);
  console.log("Hooks (settings.json):");
  const hookChecks: [string, string][] = [
    ["SessionStart", "hook.ts session-start"],
    ["Stop", "tick.sh"],
    ["PostToolUse", "tick.sh"],
    ["SessionEnd", "tick.sh force"],
  ];
  for (const [k, needle] of hookChecks) {
    const ok = has(k, needle);
    if (!ok) problems++;
    console.log(`  ${ok ? "✓" : "✗ MISSING"} ${k}`);
  }

  // 2. Heartbeat freshness
  const now = Date.now();
  const lastSweepStamp = (() => { try { return parseInt(readFileSync(join(BASE, ".last-sweep"), "utf8").trim()) * 1000; } catch { return 0; } })();
  const gs = readJson(join(BASE, "global-state.json")) ?? {};
  const globalMs = gs.lastSweepAt ? Date.parse(gs.lastSweepAt) : 0;
  const lockExists = existsSync(join(BASE, ".lock"));
  console.log("\nHeartbeat:");
  console.log(`  .last-sweep (gate)   : ${ago(lastSweepStamp)}`);
  console.log(`  global lastSweepAt   : ${ago(globalMs)} ${globalMs && now - globalMs > 90 * 60000 ? "⚠️ stale (>90m)" : ""}`);
  console.log(`  lock                 : ${lockExists ? "held (sweep running?)" : "none"}`);
  if (globalMs && now - globalMs > 90 * 60000) problems++;

  // 3. Sweep history from the log
  console.log("\nRecent sweeps (from log):");
  const logLines = (() => { try { return readFileSync(LOG, "utf8").split("\n"); } catch { return []; } })();
  const events: string[] = [];
  let openStart: string | null = null;
  let interrupted = 0;
  for (const ln of logLines) {
    const sm = ln.match(/\[sweep\] START (\S+)/);
    const dm = ln.match(/\[sweep\] DONE (\d+)s synced=(\d+) failed=(\d+) deferred=(\d+)/);
    if (sm) { if (openStart) { events.push(`  ⚠️ ${openStart.slice(11, 19)}  START → (no DONE — INTERRUPTED)`); interrupted++; } openStart = sm[1]; }
    else if (dm) {
      const t = openStart ? openStart.slice(11, 19) : "??:??:??";
      events.push(`  ${dm[3] !== "0" ? "⚠️" : "✓"} ${t}  DONE ${dm[1]}s  synced=${dm[2]} failed=${dm[3]} deferred=${dm[4]}`);
      openStart = null;
    }
  }
  if (openStart) { events.push(`  … ${openStart.slice(11, 19)}  START (running or interrupted)`); }
  if (!events.length) console.log("  (no [sweep] lines yet — logging was just added; will populate as sweeps run)");
  for (const e of events.slice(-10)) console.log(e);
  if (interrupted) { problems++; console.log(`  ⚠️ ${interrupted} interrupted sweep(s) in log history`); }

  // 4. Sync health: transcript activity vs Notion Last Worked
  console.log("\nSync health (transcript activity vs Notion):");
  const reg = readJson(join(BASE, "registry.json")) ?? {};
  const tok = token();
  // max transcript ts per cwd (last 7d window for speed)
  const since = now - 7 * 86400000;
  const cwdMax = new Map<string, number>();
  const walk = (d: string): string[] => { let o: string[] = []; let e; try { e = readdirSync(d, { withFileTypes: true }); } catch { return o; } for (const x of e) { const p = join(d, x.name); if (x.isDirectory()) o.push(...walk(p)); else if (x.name.endsWith(".jsonl")) o.push(p); } return o; };
  try {
    for (const sd of readdirSync(PROJECTS, { withFileTypes: true })) {
      if (!sd.isDirectory()) continue;
      for (const f of walk(join(PROJECTS, sd.name))) {
        let st; try { st = statSync(f); } catch { continue; }
        if (st.mtimeMs < since) continue;
        let c = ""; try { c = readFileSync(f, "utf8"); } catch { continue; }
        for (const ln of c.split("\n")) {
          if (!ln.includes('"cwd"')) continue;
          let o: any; try { o = JSON.parse(ln); } catch { continue; }
          if (o.type !== "user" && o.type !== "assistant") continue;
          if (!o.cwd || !o.timestamp) continue;
          const t = Date.parse(o.timestamp);
          if (t > (cwdMax.get(o.cwd) ?? 0)) cwdMax.set(o.cwd, t);
        }
      }
    }
  } catch {}
  const roots = Object.values(reg).map((e: any) => e.cwd);
  const rootMax = new Map<string, number>();
  for (const [cwd, t] of cwdMax) { let best: string | null = null; for (const r of roots) if ((cwd === r || cwd.startsWith(r + "/")) && (!best || r.length > best.length)) best = r as string; if (best) rootMax.set(best, Math.max(rootMax.get(best) ?? 0, t)); }

  const stale: { name: string; worked: number; notion: number; lag: number }[] = [];
  let current = 0;
  let pending = 0;
  const entries = Object.values(reg) as any[];
  await Promise.all(entries.map(async (e: any) => {
    const worked = rootMax.get(e.cwd);
    if (!worked) return; // not worked in window
    let notion = 0;
    try {
      const j: any = await (await fetch(`https://api.notion.com/v1/pages/${e.notion_page_id}`, { headers: { Authorization: `Bearer ${tok}`, "Notion-Version": "2022-06-28" } })).json();
      notion = j.properties?.["Last Worked"]?.date?.start ? Date.parse(j.properties["Last Worked"].date.start) : 0;
    } catch {}
    const lag = Math.round((worked - notion) / 60000);
    if (lag <= 40) { current++; return; }
    // A real miss only if the work PREDATES the last completed sweep — i.e. a
    // sweep had its chance and Notion is still behind. Work newer than the last
    // sweep is just pending the next cycle (the ~20-min heartbeat latency).
    if (globalMs && worked > globalMs - 60000) { pending++; return; }
    stale.push({ name: e.name, worked, notion, lag });
  }));
  stale.sort((a, b) => b.lag - a.lag);
  console.log(`  ${current} current, ${pending} pending next sweep, ${stale.length} STALE (work predates last sweep, still behind):`);
  for (const s of stale) console.log(`  ⚠️ ${s.name.padEnd(22)} worked ${ago(s.worked)}, notion ${ago(s.notion)}  (lag ${s.lag > 1440 ? Math.round(s.lag / 1440) + "d" : s.lag + "m"})`);
  if (stale.length) problems++;

  // 5. Recent failures
  const fails = logLines.filter(l => /\[sweep\] (synth-FAILED|Notion-FAILED|error )/.test(l)).slice(-5);
  if (fails.length) { console.log("\nRecent failures (log):"); for (const f of fails) console.log("  " + f.trim().slice(0, 120)); }

  console.log(`\n=== ${problems === 0 ? "✓ HEALTHY" : "⚠️ " + problems + " problem area(s)"} ===`);
  return problems === 0 ? 0 : 1;
}

if (import.meta.main) {
  doctor().then((code) => process.exit(code));
}
