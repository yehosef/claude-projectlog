/**
 * json-extract.ts — tolerant JSON extraction for model output.
 * Pure, dependency-free, so it can be unit-tested directly. The synthesis model
 * sometimes wraps its JSON in prose or a code fence; a strict JSON.parse then
 * fails and the whole synthesis is discarded. This recovers the JSON object.
 */
export function extractJsonObject(text: string): any | null {
  try {
    return JSON.parse(text);
  } catch {}
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (esc) { esc = false; continue; }
    if (ch === "\\") { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}
