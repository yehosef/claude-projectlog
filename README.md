# project-log

Automatic Notion activity log for all active projects. A background job reads
Claude transcript files, synthesizes a delta with claude-haiku-4-5, appends
entries to Notion, and generates a STATE.md injected at session start.

## Tracking model: opt-OUT (track by default)

Every project you actually work in (≥3 assistant turns of activity) auto-registers
and starts logging to Notion. You don't approve anything. To STOP a project from
being tracked, opt it out:

- `bun ~/.claude/projects-log/cli.ts ignore <path>` — hard-block a dir/tree
- Pre-seeded blocks in `ignore.json`: `/tmp`, `/private/tmp`, and the synth scratch
  dir. Edit that file to add/remove blocks.

Defense in depth: even inside a tracked project, individual transcript lines are
routed by their own `cwd`, so if you `cd` into an ignored directory mid-session,
those lines are dropped and never summarized to Notion. The `≥3 turns`
floor only skips barely-touched throwaway dirs — it is a junk filter, not an
approval gate.

## Commands

```sh
bun ~/.claude/projects-log/cli.ts status           # show tracked projects + pending
bun ~/.claude/projects-log/cli.ts sweep            # run sweep now
bun ~/.claude/projects-log/cli.ts sweep --dry-run  # see what would happen, no writes
bun ~/.claude/projects-log/cli.ts sync .           # force-synthesize current project
bun ~/.claude/projects-log/cli.ts register .       # register current dir
bun ~/.claude/projects-log/cli.ts register . --area "Torah Tech"
bun ~/.claude/projects-log/cli.ts ignore .         # opt OUT: hard-block this dir/tree
bun ~/.claude/projects-log/cli.ts unregister .     # remove from registry (stops logging)
bun ~/.claude/projects-log/cli.ts pending          # dirs seen but below the 3-turn floor
bun ~/.claude/projects-log/cli.ts pull .           # refresh Next Steps + STATE.md
```

## Install LaunchAgent

```sh
cp ~/.claude/projects-log/com.yehosef.projectlog.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.yehosef.projectlog.plist
# Test immediately:
launchctl kickstart -k gui/$(id -u)/com.yehosef.projectlog
# Check logs:
tail -f ~/.claude/logs/projectlog.out.log
```

## Uninstall

```sh
launchctl bootout gui/$(id -u)/com.yehosef.projectlog
rm ~/Library/LaunchAgents/com.yehosef.projectlog.plist
```

## Auth

The sweeper needs either:
1. `ANTHROPIC_API_KEY` in `~/.claude/projects-log/.env` — recommended, metered at
   Haiku rates ($1/$5 per Mtok), deterministic (no keychain dependency).
2. Claude subscription credentials in `~/.claude/.credentials.json` seeded from
   keychain — works interactively but unreliable from launchd (keychain blocked
   non-interactively). If you use this path, run `launchctl kickstart` once in an
   interactive session to prime the credentials.

The `NOTION_TOKEN` must always be present in `.env` (chmod 600).

## Wire session-start hook

Add to `~/.claude/settings.json`:
```json
{
  "hooks": {
    "SessionStart": [{
      "hooks": [{
        "type": "command",
        "command": "bun /Users/yehosef/.claude/projects-log/hook.ts session-start"
      }]
    }]
  }
}
```

## Files

- `registry.json` — slug → {cwd, name, area, notion_page_id, created}
- `ignore.json` — opt-out hard-block list (pre-seeded with /tmp, scratch dir)
- `config.json` — {code_roots: [...]} — legacy; no longer gates registration (track-by-default)
- `state/<slug>.json` — per-file byte offsets, next-steps cache, status cache, recent entries
- `state/<slug>/STATE.md` — injected at session start
- `.env` — NOTION_TOKEN + optional ANTHROPIC_API_KEY (chmod 600)
- `notion.json` — {projects_db_id: "..."} — read-only, not created here

## What each project captures

Each project's Notion page and STATE.md tracks:

- **Progress** — one-line current state of the project
- **Resume Here** (Suggested Next) — the ONE concrete next action, naming the specific file/command/function to touch
- **Open Questions** — unresolved decisions or choices in flight; includes the WHY behind notable design decisions
- **Blockers** — what is stalling progress or being waited on (conservative; only real blockers)
- **Status** (Active/Paused/Idea/Done) — auto-managed: set to Active on real activity; auto-set to Paused after 14 days of inactivity; Done/Idea are user-owned and never auto-changed
- **Recent Activity** — last 5 synthesized entries (bulleted, timestamped)
- **Git context** — current branch and recent commit count anchors the synthesis; shown in STATE.md
- **Monthly activity log** — sub-pages (Log YYYY-MM) with timestamped heading + bullets per sweep
