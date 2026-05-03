import type { RunnerConfig } from "./types.js";

export interface ApiResponse<T = unknown> {
  status: number;
  body: T;
  ok: boolean;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function apiFetch<T = unknown>(
  config: RunnerConfig,
  method: string,
  path: string,
  body?: unknown,
  maxRetries = 2,
): Promise<ApiResponse<T>> {
  const url = `${config.baseUrl}${path}`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.authToken) {
    headers["Authorization"] = `Bearer ${config.authToken}`;
  }

  if (config.verbose) {
    const bodyStr = body !== undefined ? ` ${JSON.stringify(body)}` : "";
    console.log(`  → ${method} ${path}${bodyStr}`);
  }

  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      await sleep(500 * attempt);
    }
    try {
      const res = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      let parsed: T;
      const text = await res.text();
      try {
        parsed = JSON.parse(text) as T;
      } catch {
        parsed = text as unknown as T;
      }
      if (config.verbose) {
        console.log(`  ← ${res.status} ${JSON.stringify(parsed).slice(0, 200)}`);
      }
      if (res.status >= 500 && attempt < maxRetries) {
        lastError = new Error(`HTTP ${res.status}`);
        continue;
      }
      return { status: res.status, body: parsed, ok: res.ok };
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      if (attempt < maxRetries) continue;
    }
  }
  throw lastError ?? new Error("Request failed");
}

export async function getSystemState(config: RunnerConfig) {
  const { body } = await apiFetch<import("./types.js").SystemState>(
    config,
    "GET",
    "/debug/system-state",
  );
  return body;
}

export async function pollUntil<T>(
  fn: () => Promise<T>,
  condition: (result: T) => boolean,
  timeoutMs: number,
  intervalMs = 1_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (condition(result)) return result;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(intervalMs, remaining));
  }
  throw new Error(`pollUntil timed out after ${timeoutMs}ms`);
}
