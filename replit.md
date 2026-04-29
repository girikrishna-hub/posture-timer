# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.

## Artifacts

### Sit/Stand Timer (PWA)
- **Path**: `artifacts/sit-stand-timer/` — React + Vite frontend served at `/`
- **API Server**: `artifacts/api-server/` — Express 5 backend served at `/api`
- **Features**:
  - Sit / Stand / Rest mode switching with live elapsed timer
  - Configurable reminders: sitting alert (default 45m, 3 reminders 1m apart), standing alert (default 10–15m)
  - Web Audio API tones on mode switch and reminders
  - Browser Notification API for background tab alerts (with service worker in `public/sw.js`)
  - Persistent sessions in PostgreSQL (start/end/duration/restType classification: nap vs sleep)
  - Daily stats + weekly stats + streak tracking
  - Settings page with sliders for all timer thresholds
  - PWA manifest (`public/manifest.json`) for installability
  - **Dashboard**: Overview (summary cards + weekly Recharts bar chart), Daily timeline, Monthly heatmap calendar, Sessions log with pagination and CSV export
  - Bottom nav: Timer ↔ Dashboard tabs
  - **Walking mode**: Auto-detect walking via Geolocation `watchPosition` speed (0.3–3.5 m/s). Opt-in toggle in Settings (requests location permission on toggle-on, shows permission status). 15s debounce to start, 15s to stop. Null-speed fallback derives speed from haversine distance between consecutive fixes. On stop: walking session ends to idle (no forced sitting). Preference persisted in localStorage. Teal color theme. GPS status indicator in header (requesting/active/denied states).

### Key Files
- `lib/api-spec/openapi.yaml` — OpenAPI contract (sessions, settings, stats, metrics)
- `lib/api-zod/src/index.ts` — Zod schema exports + selective type re-exports
- `lib/api-client-react/src/generated/api.ts` — generated TanStack Query hooks
- `lib/db/src/schema/sessions.ts` — sessionsTable: id, mode, startedAt, endedAt, durationSeconds, restType
- `lib/db/src/schema/settings.ts` — settingsTable: id, dailyStandingGoalMinutes, sittingAlertMinutes, standingMinMinutes, standingMaxMinutes, reminderIntervalMinutes, remindersCount
- `artifacts/api-server/src/routes/sessions.ts` — POST/GET list/GET active/PATCH end/GET export (CSV)
- `artifacts/api-server/src/routes/settings.ts` — GET/PATCH with auto-create defaults
- `artifacts/api-server/src/routes/stats.ts` — today + weekly aggregation + streak
- `artifacts/api-server/src/routes/metrics.ts` — GET /metrics/daily (per-day breakdown) + GET /metrics/summary (streak, health score, sleep stats)
- `artifacts/sit-stand-timer/src/contexts/TimerContext.tsx` — timer state machine, reminder logic, audio, notifications
- `artifacts/sit-stand-timer/src/utils/audio.ts` — Web Audio API tone generation
- `artifacts/sit-stand-timer/src/pages/TimerPage.tsx` — main timer UI
- `artifacts/sit-stand-timer/src/pages/SettingsPage.tsx` — settings sliders UI
- `artifacts/sit-stand-timer/src/pages/DashboardPage.tsx` — analytics dashboard (Overview/Daily/Monthly/Sessions tabs)
- `artifacts/sit-stand-timer/src/components/BottomNav.tsx` — Timer/Dashboard bottom navigation

### Rest Classification Logic
Rest sessions are auto-classified on end:
- **nap**: duration < 3 hours AND time is between 11am–6pm
- **sleep**: duration ≥ 3 hours OR start/end time is nighttime (9pm–8am)
