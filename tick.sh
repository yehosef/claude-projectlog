#!/bin/bash
# project-log heartbeat gate — fired from the Stop hook on every turn.
#
# This is intentionally dumb and cheap: it only checks whether enough wall-clock
# time has elapsed since the last sweep, and if so spawns the sweep DETACHED so
# the user's session never waits on synthesis. The authoritative concurrency
# guard (dead-state-aware O_EXCL lock with pid liveness + 10-min stale reclaim)
# lives in synth.ts — this gate is just a pre-filter to avoid spawning on every
# turn. Always exits 0 and never blocks; it must never interfere with the session.

DIR="$HOME/.claude/projects-log"
STAMP="$DIR/.last-sweep"
TICKLOCK="$DIR/.tick.lock"
LOG="$HOME/.claude/logs/projectlog.out.log"
INTERVAL="${PROJECTLOG_INTERVAL:-1200}"   # seconds between sweeps (default 20 min)

# "force" (passed by the SessionEnd hook) bypasses the time gate so the LAST
# work of a session is always captured — there are no more ticks after the
# session ends, so without this the final edits wait until the next session.
FORCE=0
[ "$1" = "force" ] && FORCE=1

# Not installed → do nothing.
[ -f "$DIR/synth.ts" ] || exit 0

now=$(date +%s)
last=0
[ -f "$STAMP" ] && last=$(cat "$STAMP" 2>/dev/null)
case "$last" in ''|*[!0-9]*) last=0 ;; esac   # guard against corrupt/empty stamp

if [ "$FORCE" = "1" ] || [ $(( now - last )) -ge "$INTERVAL" ]; then
  # Atomically claim the slot so parallel sessions' ticks don't all spawn.
  # mkdir is atomic across processes; only one tick wins the race.
  if mkdir "$TICKLOCK" 2>/dev/null; then
    echo "$now" > "$STAMP.tmp" 2>/dev/null && mv -f "$STAMP.tmp" "$STAMP" 2>/dev/null
    rmdir "$TICKLOCK" 2>/dev/null
    BUN="$(command -v bun)"
    [ -z "$BUN" ] && [ -x /opt/homebrew/bin/bun ] && BUN=/opt/homebrew/bin/bun
    if [ -n "$BUN" ]; then
      mkdir -p "$HOME/.claude/logs" 2>/dev/null
      # Launch the sweep in its OWN session (see spawn-sweep.ts) so the hook's
      # process-group teardown at turn/session end can't kill it mid-sweep.
      "$BUN" "$DIR/spawn-sweep.ts" >/dev/null 2>&1 &
    fi
  fi
fi
exit 0
