import { db, fitbitConnectionsTable } from "@workspace/db";
import { desc } from "drizzle-orm";
import { logger } from "../lib/logger";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_FIT_AGGREGATE_URL =
  "https://www.googleapis.com/fitness/v1/users/me/dataset:aggregate";

const FIT_SCOPE = "https://www.googleapis.com/auth/fitness.activity.read";

export function getFitbitAuthUrl(redirectUri: string, state: string): string {
  const clientId = process.env["GOOGLE_FIT_CLIENT_ID"] ?? "";
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: FIT_SCOPE,
    state,
    access_type: "offline",
    prompt: "consent",
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

export async function exchangeCodeForTokens(
  code: string,
  redirectUri: string,
): Promise<void> {
  const clientId = process.env["GOOGLE_FIT_CLIENT_ID"] ?? "";
  const clientSecret = process.env["GOOGLE_FIT_CLIENT_SECRET"] ?? "";

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret,
  });

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google token exchange failed: ${res.status} ${text}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope: string;
  };

  if (!data.refresh_token) {
    throw new Error(
      "Google did not return a refresh_token. Ensure the app requested offline access.",
    );
  }

  const expiresAt = new Date(Date.now() + data.expires_in * 1000);

  await db.delete(fitbitConnectionsTable);
  await db.insert(fitbitConnectionsTable).values({
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt,
    scope: data.scope ?? FIT_SCOPE,
  });

  logger.info("Google Fit tokens stored");
}

export async function refreshAccessToken(): Promise<string | null> {
  const rows = await db
    .select()
    .from(fitbitConnectionsTable)
    .orderBy(desc(fitbitConnectionsTable.id))
    .limit(1);

  if (rows.length === 0) return null;

  const conn = rows[0];
  const clientId = process.env["GOOGLE_FIT_CLIENT_ID"] ?? "";
  const clientSecret = process.env["GOOGLE_FIT_CLIENT_SECRET"] ?? "";

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: conn.refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    logger.error({ status: res.status }, "Google token refresh failed");
    return null;
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope: string;
  };

  const expiresAt = new Date(Date.now() + data.expires_in * 1000);
  await db.delete(fitbitConnectionsTable);
  await db.insert(fitbitConnectionsTable).values({
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? conn.refreshToken,
    expiresAt,
    scope: data.scope ?? conn.scope,
  });

  return data.access_token;
}

export async function getValidAccessToken(): Promise<string | null> {
  const rows = await db
    .select()
    .from(fitbitConnectionsTable)
    .orderBy(desc(fitbitConnectionsTable.id))
    .limit(1);

  if (rows.length === 0) return null;

  const conn = rows[0];
  const bufferMs = 5 * 60 * 1000;

  if (conn.expiresAt.getTime() - bufferMs > Date.now()) {
    return conn.accessToken;
  }

  return refreshAccessToken();
}

export interface StepMinute {
  time: string;
  steps: number;
}

interface GoogleFitBucket {
  startTimeMillis: string;
  endTimeMillis: string;
  dataset: Array<{
    dataSourceId: string;
    point: Array<{
      value: Array<{ intVal?: number; fpVal?: number }>;
    }>;
  }>;
}

interface GoogleFitAggregateResponse {
  bucket?: GoogleFitBucket[];
}

export async function fetchIntradaySteps(): Promise<StepMinute[]> {
  const token = await getValidAccessToken();
  if (!token) return [];

  const endMs = Date.now();
  const startMs = endMs - 15 * 60 * 1000;

  const body = JSON.stringify({
    aggregateBy: [{ dataTypeName: "com.google.step_count.delta" }],
    bucketByTime: { durationMillis: 60_000 },
    startTimeMillis: startMs.toString(),
    endTimeMillis: endMs.toString(),
  });

  const res = await fetch(GOOGLE_FIT_AGGREGATE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body,
  });

  if (!res.ok) {
    logger.error({ status: res.status }, "Google Fit aggregate fetch failed");
    return [];
  }

  const data = (await res.json()) as GoogleFitAggregateResponse;
  const buckets = data.bucket ?? [];

  return buckets.map((bucket) => {
    const tsMs = parseInt(bucket.startTimeMillis, 10);
    const d = new Date(tsMs);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const time = `${hh}:${mm}`;

    const point = bucket.dataset[0]?.point[0];
    const steps = point?.value[0]?.intVal ?? point?.value[0]?.fpVal ?? 0;

    return { time, steps: Math.round(steps) };
  });
}
