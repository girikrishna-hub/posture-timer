import { db, fitbitConnectionsTable } from "@workspace/db";
import { desc } from "drizzle-orm";
import { logger } from "../lib/logger";

const FITBIT_TOKEN_URL = "https://api.fitbit.com/oauth2/token";
const FITBIT_INTRADAY_URL =
  "https://api.fitbit.com/1/user/-/activities/steps/date/today/1d/1min.json";

export function getFitbitAuthUrl(redirectUri: string, state: string): string {
  const clientId = process.env["GOOGLE_FIT_CLIENT_ID"] ?? "";
  const scopes = ["activity", "profile"].join("%20");
  return (
    `https://www.fitbit.com/oauth2/authorize` +
    `?response_type=code` +
    `&client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&scope=${scopes}` +
    `&state=${encodeURIComponent(state)}` +
    `&expires_in=604800`
  );
}

export async function exchangeCodeForTokens(
  code: string,
  redirectUri: string,
): Promise<void> {
  const clientId = process.env["GOOGLE_FIT_CLIENT_ID"] ?? "";
  const clientSecret = process.env["GOOGLE_FIT_CLIENT_SECRET"] ?? "";

  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString(
    "base64",
  );

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
  });

  const res = await fetch(FITBIT_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Fitbit token exchange failed: ${res.status} ${text}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    scope: string;
  };

  const expiresAt = new Date(Date.now() + data.expires_in * 1000);

  await db.delete(fitbitConnectionsTable);
  await db.insert(fitbitConnectionsTable).values({
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt,
    scope: data.scope ?? "",
  });

  logger.info("Fitbit tokens stored");
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
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString(
    "base64",
  );

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: conn.refreshToken,
  });

  const res = await fetch(FITBIT_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  if (!res.ok) {
    logger.error({ status: res.status }, "Fitbit token refresh failed");
    return null;
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    scope: string;
  };

  const expiresAt = new Date(Date.now() + data.expires_in * 1000);
  await db.delete(fitbitConnectionsTable);
  await db.insert(fitbitConnectionsTable).values({
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
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
  const now = new Date();
  const bufferMs = 5 * 60 * 1000;

  if (conn.expiresAt.getTime() - bufferMs > now.getTime()) {
    return conn.accessToken;
  }

  return refreshAccessToken();
}

export interface StepMinute {
  time: string;
  steps: number;
}

export async function fetchIntradaySteps(): Promise<StepMinute[]> {
  const token = await getValidAccessToken();
  if (!token) return [];

  const res = await fetch(FITBIT_INTRADAY_URL, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    logger.error({ status: res.status }, "Fitbit intraday fetch failed");
    return [];
  }

  const data = (await res.json()) as {
    "activities-steps-intraday"?: {
      dataset?: { time: string; value: number }[];
    };
  };

  const dataset =
    data["activities-steps-intraday"]?.dataset ?? [];

  return dataset.map((d) => ({ time: d.time, steps: d.value }));
}
