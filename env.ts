/**
 * env.ts — load .env from import.meta.dir, assert mode 0600.
 * Exports getNotionToken() and getAnthropicKey() (may be null).
 */

import { statSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ENV_PATH = join(import.meta.dir, ".env");

function loadEnv(): void {
  // Assert the .env file exists and has mode 0600
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(ENV_PATH);
  } catch {
    console.error(`[env] .env not found at ${ENV_PATH}`);
    process.exit(1);
  }

  const mode = st.mode & 0o777;
  if (mode !== 0o600) {
    console.error(
      `[env] .env at ${ENV_PATH} has permissions 0${mode.toString(8)}, expected 0600. ` +
        `Run: chmod 600 ${ENV_PATH}`
    );
    process.exit(1);
  }

  // Parse KEY=VALUE lines
  let raw: string;
  try {
    raw = readFileSync(ENV_PATH, "utf8");
  } catch (e) {
    console.error(`[env] Cannot read .env: ${e}`);
    process.exit(1);
  }

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    // Only set if not already in env (don't override explicit env vars)
    if (key && !(key in process.env)) {
      process.env[key] = value;
    }
  }
}

// Load eagerly on import
loadEnv();

export function getNotionToken(): string {
  const tok = process.env.NOTION_TOKEN;
  if (!tok) {
    console.error("[env] NOTION_TOKEN is not set. Add it to .env");
    process.exit(1);
  }
  return tok;
}

export function getAnthropicKey(): string | null {
  return process.env.ANTHROPIC_API_KEY ?? null;
}
