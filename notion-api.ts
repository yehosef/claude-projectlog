/**
 * notion-api.ts — Notion REST helpers with retry/backoff.
 * Generalized from /Volumes/code/personal/notion/.claude/scripts/sync-from-notion.ts.
 * Reads NOTION_TOKEN via env.ts. Throws NotionError on failure — never process.exit.
 */

import "./env.ts";
import { getNotionToken } from "./env.ts";

const NOTION_VERSION = "2022-06-28";
const BASE = "https://api.notion.com/v1";
const MAX_RETRIES = 3;

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class NotionError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    message: string
  ) {
    super(message);
    this.name = "NotionError";
  }
}

// ---------------------------------------------------------------------------
// Core fetch with retry/backoff
// ---------------------------------------------------------------------------

async function notionFetch(
  path: string,
  options: RequestInit = {}
): Promise<any> {
  const token = getNotionToken();
  const url = `${BASE}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string> | undefined),
  };

  let lastError: NotionError | null = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      // Exponential backoff: 1s, 2s
      await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
    }

    let res: Response;
    try {
      res = await fetch(url, { ...options, headers });
    } catch (e) {
      // Network-level failure (ECONNRESET, socket closed, DNS, timeout).
      // Treat as retryable instead of letting it throw out of the loop and
      // crash the whole sweep.
      lastError = new NotionError(
        0,
        String(e),
        `Notion network error on ${options.method ?? "GET"} ${path} (attempt ${attempt + 1})`
      );
      continue; // retry
    }

    if (res.ok) {
      return res.json();
    }

    const body = await res.text();

    if (res.status === 429 || res.status >= 500) {
      // Honor Retry-After header if present
      const retryAfter = res.headers.get("Retry-After");
      if (retryAfter) {
        const wait = parseFloat(retryAfter) * 1000;
        if (wait > 0 && wait < 60_000) {
          await new Promise((r) => setTimeout(r, wait));
        }
      }
      lastError = new NotionError(
        res.status,
        body,
        `Notion ${res.status} on ${options.method ?? "GET"} ${path} (attempt ${attempt + 1})`
      );
      continue; // retry
    }

    // 4xx other than 429 — don't retry
    throw new NotionError(
      res.status,
      body,
      `Notion ${res.status} on ${options.method ?? "GET"} ${path}: ${body.slice(0, 200)}`
    );
  }

  throw lastError!;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Query all pages in a database (handles pagination). */
export async function notionQuery(
  dbId: string,
  filter?: object
): Promise<any[]> {
  const results: any[] = [];
  let cursor: string | undefined;

  do {
    const body: any = {};
    if (cursor) body.start_cursor = cursor;
    if (filter) body.filter = filter;

    const data = await notionFetch(`/databases/${dbId}/query`, {
      method: "POST",
      body: JSON.stringify(body),
    });

    results.push(...data.results);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);

  return results;
}

/** Fetch a single page by ID. */
export async function getPage(pageId: string): Promise<any> {
  return notionFetch(`/pages/${pageId}`);
}

/** Create a page in a database. */
export async function createPage(
  dbId: string,
  props: Record<string, any>
): Promise<any> {
  return notionFetch("/pages", {
    method: "POST",
    body: JSON.stringify({
      parent: { database_id: dbId },
      properties: props,
    }),
  });
}

/** Create a child page (not in a database) under a parent page. */
export async function createChildPage(
  parentPageId: string,
  title: string
): Promise<any> {
  return notionFetch("/pages", {
    method: "POST",
    body: JSON.stringify({
      parent: { page_id: parentPageId },
      properties: {
        title: {
          title: [{ type: "text", text: { content: title } }],
        },
      },
    }),
  });
}

/** Update page properties (PATCH). */
export async function updatePageProps(
  pageId: string,
  props: Record<string, any>
): Promise<any> {
  return notionFetch(`/pages/${pageId}`, {
    method: "PATCH",
    body: JSON.stringify({ properties: props }),
  });
}

/** Append block children to a block/page. */
export async function appendBlocks(
  blockId: string,
  children: any[]
): Promise<any> {
  // Notion limits to 100 children per request — chunk if needed
  for (let i = 0; i < children.length; i += 100) {
    await notionFetch(`/blocks/${blockId}/children`, {
      method: "PATCH",
      body: JSON.stringify({ children: children.slice(i, i + 100) }),
    });
  }
}

// ---------------------------------------------------------------------------
// Property builder helpers
// ---------------------------------------------------------------------------

/** Build a Notion title property value. */
export function titleProp(text: string): any {
  return { title: [{ type: "text", text: { content: text } }] };
}

/** Build a Notion select property value. */
export function selectProp(name: string): any {
  return { select: { name } };
}

/** Build a Notion rich_text property value. */
export function richTextProp(text: string): any {
  return {
    rich_text: [{ type: "text", text: { content: text.slice(0, 2000) } }],
  };
}

/** Build a Notion date property value (start only). */
export function dateProp(isoDate: string): any {
  return { date: { start: isoDate } };
}

// ---------------------------------------------------------------------------
// Property extractor
// ---------------------------------------------------------------------------

/** Extract a scalar value from a Notion page property. */
export function prop(page: any, name: string): string | null {
  const p = page?.properties?.[name];
  if (!p) return null;
  switch (p.type) {
    case "title":
      return p.title.map((t: any) => t.plain_text).join("") || null;
    case "select":
      return p.select?.name ?? null;
    case "rich_text":
      return p.rich_text.map((t: any) => t.plain_text).join("") || null;
    case "date":
      return p.date?.start ?? null;
    default:
      return null;
  }
}
