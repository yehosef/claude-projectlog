// Spawn the sweep FULLY DETACHED (its own session/process group via setsid),
// then exit immediately. This is the reliability fix: a hook (Stop/PostToolUse/
// SessionEnd) runs tick.sh as a child of Claude Code, and Claude Code tears down
// the hook's process group when the turn/session ends. A plain `nohup ... &`
// stays in that group and gets killed mid-sweep (a sweep takes ~30-60s). With
// detached:true the child calls setsid(), leaving the hook's process group, so
// it survives to completion. unref() lets this launcher exit right away.
import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { join } from "node:path";

const DIR = import.meta.dir;
const home = process.env.HOME ?? "";

let out: number | "ignore" = "ignore";
try {
  out = openSync(join(home, ".claude", "logs", "projectlog.out.log"), "a");
} catch {
  out = "ignore";
}

const child = spawn(process.execPath, [join(DIR, "synth.ts"), "--sweep"], {
  detached: true,
  stdio: ["ignore", out, out],
});
child.unref();
// Exit promptly; the detached sweep keeps running in its own session.
process.exit(0);
