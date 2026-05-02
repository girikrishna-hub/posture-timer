/**
 * Integration tests for DashboardPage trophy badge replay triggering the banner.
 *
 * These tests render the real DashboardPage with mocked dependencies and verify
 * that tapping the trophy badge causes the "Goal reached!" celebration banner to
 * appear. This is the primary regression guard for the combined replay flow:
 * onReplayCelebration → replayCelebration() + goalCelebrationBanner.show().
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { CELEBRATION_KEY, todayStr } from "@/hooks/useGoalCelebration";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("@/contexts/TimerContext", () => ({
  useTimer: () => ({
    mode: "idle",
    elapsedSeconds: 0,
    reminderCount: 0,
    inReminderPhase: false,
    isLoading: false,
    switchMode: vi.fn(),
    gpsStatus: "unavailable",
    notificationPermission: "default",
    requestNotificationPermission: vi.fn(),
  }),
}));

vi.mock("@/utils/audio", () => ({
  playGoalCelebrationTone: vi.fn(),
  isSoundEnabled: () => true,
  setSoundEnabled: vi.fn(),
}));

// html2canvas is not needed for these tests; mock it to avoid JSDOM limitations.
vi.mock("html2canvas", () => ({ default: vi.fn() }));

// Shared mutable references — tests mutate these to change what the hooks return.
let _mockTodayStats: object | undefined = undefined;

vi.mock("@workspace/api-client-react", () => ({
  useGetTodayStats: () => ({ data: _mockTodayStats }),
  // Return isLoading: false so OverviewTab renders past the skeleton guard
  // and shows the progress bar / trophy badge area.
  useGetMetricsSummary: () => ({ data: undefined, isLoading: false }),
  useGetDailyMetrics: () => ({ data: undefined, isLoading: false }),
  useListSessions: () => ({ data: undefined, isLoading: false }),
  getGetTodayStatsQueryKey: () => ["today-stats"],
  getVapidPublicKey: vi.fn().mockResolvedValue({ publicKey: "" }),
  subscribePush: vi.fn().mockResolvedValue({ ok: true }),
  unsubscribePush: vi.fn().mockResolvedValue(undefined),
  schedulePush: vi.fn().mockResolvedValue({ ok: true, scheduled: false }),
  cancelPushSchedule: vi.fn().mockResolvedValue({ ok: true }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildStats(standingMinutes: number, goalMinutes: number) {
  return {
    date: todayStr(),
    sittingMinutes: 0,
    standingMinutes,
    walkingMinutes: 0,
    restingMinutes: 0,
    activeMinutes: standingMinutes,
    goalMinutes,
    goalProgressPercent: Math.min(100, (standingMinutes / goalMinutes) * 100),
    sessionCount: 1,
    currentStreak: 1,
  };
}

import DashboardPage from "@/pages/DashboardPage";

function renderPage() {
  return render(<DashboardPage />);
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  localStorage.clear();
  _mockTodayStats = undefined;
});

afterEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Scenario: replay via trophy badge shows the celebration banner
// ---------------------------------------------------------------------------

describe("DashboardPage — trophy badge replay shows celebration banner", () => {
  it("tapping the trophy badge causes the 'Goal reached!' banner to appear", () => {
    // Arrange: goal was already achieved today (badge is visible on load).
    localStorage.setItem(CELEBRATION_KEY, todayStr());
    _mockTodayStats = buildStats(60, 60);

    act(() => {
      renderPage();
    });

    // The badge is present because goalAchieved=true from localStorage.
    const badge = screen.getByRole("button", { name: /replay goal celebration/i });
    expect(badge).toBeInTheDocument();

    // The banner should NOT be shown before the tap.
    expect(screen.queryByRole("status")).toBeNull();

    // Act: tap the badge.
    act(() => {
      fireEvent.click(badge);
    });

    // Assert: the celebration banner is now in the DOM.
    const banner = screen.getByRole("status");
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveTextContent("Goal reached!");
  });

  it("tapping the badge shows the banner even after a page reload (skipBadgePopIn scenario)", () => {
    // Arrange: simulate a reload — CELEBRATION_KEY already written, stats at goal.
    localStorage.setItem(CELEBRATION_KEY, todayStr());
    _mockTodayStats = buildStats(60, 60);

    act(() => {
      renderPage();
    });

    // Banner absent before tap.
    expect(screen.queryByRole("status")).toBeNull();

    // Act: tap badge.
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /replay goal celebration/i }));
    });

    // Assert: banner is shown.
    expect(screen.getByRole("status")).toHaveTextContent("Goal reached!");
  });

  it("banner can be dismissed via its dismiss button after replay", () => {
    vi.useFakeTimers();

    localStorage.setItem(CELEBRATION_KEY, todayStr());
    _mockTodayStats = buildStats(60, 60);

    act(() => {
      renderPage();
    });

    // Tap badge to show banner.
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /replay goal celebration/i }));
    });

    expect(screen.getByRole("status")).toBeInTheDocument();

    // Click the dismiss button inside the banner.
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    });

    // After dismiss + fade-out timer (350 ms), banner unmounts.
    act(() => {
      vi.advanceTimersByTime(400);
    });

    expect(screen.queryByRole("status")).toBeNull();
  });
});
