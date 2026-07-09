/**
 * sync.test.ts — unit tests for the logic that kept breaking.
 * Run: bun test
 *
 * These cover the actual bugs we hit: nested-project routing, prose-wrapped
 * JSON synthesis output, and the ignore-list matching. Pure functions only —
 * no Notion, no filesystem state, no network.
 */
import { test, expect, describe } from "bun:test";
import { lineBelongsToProject } from "./transcript.ts";
import { extractJsonObject } from "./json-extract.ts";
import { isIgnored } from "./registry.ts";

describe("lineBelongsToProject (cwd routing)", () => {
  const P = "/code/geula/bhm";
  const NESTED = "/code/geula/bhm/mikdash3";
  const SIBLING = "/code/geula/rubik";

  test("exact-match line belongs to its project", () => {
    expect(lineBelongsToProject(P, P, [SIBLING])).toBe(true);
  });

  test("subdir line belongs to its project", () => {
    expect(lineBelongsToProject(P + "/src/x", P, [SIBLING])).toBe(true);
  });

  test("line in a nested project belongs to the NESTED one, not the ancestor (the mikdash3 bug)", () => {
    // ancestor bhm must NOT claim a line that lives under the more-specific mikdash3
    expect(lineBelongsToProject(NESTED + "/src/a", P, [NESTED, SIBLING])).toBe(false);
    // and the nested project DOES claim it (ancestor bhm is shorter → not excluded)
    expect(lineBelongsToProject(NESTED + "/src/a", NESTED, [P, SIBLING])).toBe(true);
  });

  test("nested project's exact cwd belongs to it, not the ancestor", () => {
    expect(lineBelongsToProject(NESTED, NESTED, [P])).toBe(true);
    expect(lineBelongsToProject(NESTED, P, [NESTED])).toBe(false);
  });

  test("a line under a sibling does not belong here", () => {
    expect(lineBelongsToProject(SIBLING + "/y", P, [SIBLING])).toBe(false);
  });

  test("a line outside all projects does not belong here", () => {
    expect(lineBelongsToProject("/tmp/whatever", P, [SIBLING])).toBe(false);
  });

  test("prefix is path-segment aware (bhm2 is not under bhm)", () => {
    expect(lineBelongsToProject("/code/geula/bhm2/x", P, [])).toBe(false);
  });
});

describe("extractJsonObject (tolerant synth parsing)", () => {
  const obj = { progress: "did a thing", bullets: ["a", "b"] };

  test("pure JSON parses", () => {
    expect(extractJsonObject(JSON.stringify(obj))).toEqual(obj);
  });

  test("JSON with a prose preamble (the guela-project bug)", () => {
    const s = "Based on the context, here's the summary JSON:\n\n" + JSON.stringify(obj);
    expect(extractJsonObject(s)).toEqual(obj);
  });

  test("JSON inside a ```json code fence", () => {
    const s = "```json\n" + JSON.stringify(obj) + "\n```";
    expect(extractJsonObject(s)).toEqual(obj);
  });

  test("JSON with trailing commentary", () => {
    const s = JSON.stringify(obj) + "\n\nLet me know if you need anything else!";
    expect(extractJsonObject(s)).toEqual(obj);
  });

  test("braces inside strings don't confuse the balancer", () => {
    const tricky = { progress: "refactored handler { x } and y", bullets: [] };
    const s = "here: " + JSON.stringify(tricky);
    expect(extractJsonObject(s)).toEqual(tricky);
  });

  test("pure prose with no JSON returns null (caller then skips, no false data)", () => {
    expect(extractJsonObject("Nothing to commit here — just cleanup.")).toBeNull();
  });

  test("malformed JSON returns null", () => {
    expect(extractJsonObject('{"progress": "unterminated')).toBeNull();
  });
});

describe("isIgnored", () => {
  const ignore = ["/tmp", "/Users/x/.claude/projects-log/.scratch", "/Users/x/Documents"];

  test("exact match is ignored", () => {
    expect(isIgnored("/tmp", ignore)).toBe(true);
  });
  test("subdir of an ignored path is ignored", () => {
    expect(isIgnored("/tmp/foo/bar", ignore)).toBe(true);
    expect(isIgnored("/Users/x/Documents/notes", ignore)).toBe(true);
  });
  test("non-ignored path is not ignored", () => {
    expect(isIgnored("/code/geula/bhm", ignore)).toBe(false);
  });
  test("path-segment aware (/tmpfoo is not under /tmp)", () => {
    expect(isIgnored("/tmpfoo", ignore)).toBe(false);
  });
});
