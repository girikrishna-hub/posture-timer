export type SessionMode = "sitting" | "standing" | "resting" | "walking";
export type RestType = "nap" | "sleep";

export interface StartSessionDto {
  mode: SessionMode;
  startedAt?: Date;
  restType?: RestType | null;
}

export interface EndSessionDto {
  endedAt?: Date;
}

export interface ListSessionsDto {
  from?: Date;
  to?: Date;
  limit: number;
  offset: number;
}

export interface SessionDto {
  id: number;
  mode: SessionMode;
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number | null;
  restType: RestType | null;
}
