/**
 * HttpDiagnosticsJournal — TEMP DIAG (remove once native auth is stable).
 *
 * Records every native-auth HTTP request/response so the in-app overlay
 * can surface the actual URL, status, content-type, classification and
 * a 200-char body snippet without needing chrome://inspect.
 *
 * Classification:
 *   "backend-json"   application/json response from the API (expected)
 *   "html-fallback"  text/html response — Vite / SPA fallback returning
 *                    index.html instead of the API route
 *   "redirect"       3xx redirect (auth flow may be redirecting to login)
 *   "network-error"  fetch threw (DNS, TLS, abort, offline)
 *   "other"          non-json non-html content (binary, plain text)
 */

export type HttpDiagClass =
  | "backend-json"
  | "html-fallback"
  | "redirect"
  | "network-error"
  | "other";

export interface HttpDiagEntry {
  id:          number;
  timestamp:   number;
  method:      string;
  url:         string;
  status:      number | null;
  ok:          boolean;
  contentType: string | null;
  classification: HttpDiagClass;
  snippet:     string;        // first ~200 chars of body (always — easier to read than only-on-failure)
  durationMs:  number;
  error:       string | null;
}

const MAX_ENTRIES = 30;
let nextId = 1;
const entries: HttpDiagEntry[] = [];
const subscribers = new Set<() => void>();

function notify(): void {
  for (const fn of subscribers) {
    try { fn(); } catch { /* ignore */ }
  }
}

export function getHttpDiagEntries(): readonly HttpDiagEntry[] {
  return entries;
}

export function subscribeHttpDiag(fn: () => void): () => void {
  subscribers.add(fn);
  return () => { subscribers.delete(fn); };
}

export function clearHttpDiag(): void {
  entries.length = 0;
  notify();
}

function classify(
  status: number | null,
  contentType: string | null,
  error: string | null,
): HttpDiagClass {
  if (error) return "network-error";
  if (status != null && status >= 300 && status < 400) return "redirect";
  const ct = (contentType ?? "").toLowerCase();
  if (ct.includes("application/json")) return "backend-json";
  if (ct.includes("text/html")) return "html-fallback";
  return "other";
}

function pushEntry(e: Omit<HttpDiagEntry, "id">): HttpDiagEntry {
  const entry: HttpDiagEntry = { id: nextId++, ...e };
  entries.unshift(entry);
  if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES;
  notify();
  return entry;
}

/**
 * Fetch wrapper that records URL / status / content-type / snippet
 * and returns BOTH the Response and the already-read text body so the
 * caller can JSON.parse() it themselves without consuming the stream twice.
 *
 * Caller pattern:
 *   const { response, text, diagEntry } = await fetchWithDiag(url, init);
 *   if (!response.ok) { ...use diagEntry.snippet... }
 *   const data = JSON.parse(text);     // will throw with body visible in diag
 */
export interface FetchWithDiagResult {
  response:  Response;
  text:      string;
  diagEntry: HttpDiagEntry;
}

export async function fetchWithDiag(
  url:    string,
  init?:  RequestInit,
): Promise<FetchWithDiagResult> {
  const method = (init?.method ?? "GET").toUpperCase();
  const startedAt = Date.now();
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    pushEntry({
      timestamp:      startedAt,
      method,
      url,
      status:         null,
      ok:             false,
      contentType:    null,
      classification: classify(null, null, errMsg),
      snippet:        "",
      durationMs:     Date.now() - startedAt,
      error:          errMsg,
    });
    throw err;
  }

  // Read body as text so we can both surface it for diagnostics AND let
  // the caller parse it. Clone first so we don't burn the original stream
  // if the caller wants to read it themselves.
  let text = "";
  try {
    text = await response.clone().text();
  } catch {
    /* body unreadable — leave text empty */
  }

  const contentType = response.headers.get("content-type");
  const snippet = text.slice(0, 200);

  const diagEntry = pushEntry({
    timestamp:      startedAt,
    method,
    url,
    status:         response.status,
    ok:             response.ok,
    contentType,
    classification: classify(response.status, contentType, null),
    snippet,
    durationMs:     Date.now() - startedAt,
    error:          null,
  });

  return { response, text, diagEntry };
}

/**
 * Parse text as JSON; on failure record a synthetic "parse failed" entry
 * pointing at the originating request so the overlay shows the offending
 * URL alongside the body that wouldn't parse.
 */
export function parseJsonWithDiag<T>(text: string, originating: HttpDiagEntry): T {
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    pushEntry({
      timestamp:      Date.now(),
      method:         originating.method,
      url:            originating.url + "  (JSON.parse)",
      status:         originating.status,
      ok:             false,
      contentType:    originating.contentType,
      classification: originating.classification,
      snippet:        text.slice(0, 200),
      durationMs:     0,
      error:          `JSON.parse failed: ${errMsg}`,
    });
    throw err;
  }
}
