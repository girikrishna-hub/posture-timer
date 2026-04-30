/**
 * Integration tests for TimerPage celebration guards.
 *
 * These tests render the real TimerPage with mocked dependencies and drive the
 * actual React state transitions that govern whether animations replay on page
 * reload. They complement the unit tests in celebration-guards.test.tsx by
 * verifying the guards work end-to-end inside the page, not just in isolation.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { CELEBRATION_KEY, BADGE_HINT_KEY, todayStr } from "@/pages/TimerPage";

// ---------------------------------------------------------------------------
// Module mocks — declared at top level so they hoist correctly
// ---------------------------------------------------------------------------

const mockSwitchMode = vi.fn();

vi.mock("@/contexts/TimerContext", () => ({
  useTimer: () => ({
    mode: "idle",
    elapsedSeconds: 0,
    reminderCount: 0,
    inReminderPhase: false,
    isLoading: false,
    switchMode: mockSwitchMode,
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

vi.mock("@/hooks/useFitbitDrift", () => ({
  useFitbitDrift: () => ({
    nudge: null,
    confirmNudge: vi.fn(),
    cancelNudge: vi.fn(),
    clearNudge: vi.fn(),
    connected: false,
  }),
}));

// Shared mutable reference — tests mutate this to change what the hook returns
let _mockTodayStats: object | undefined = undefined;
let _mockSettings: object | undefined = undefined;

vi.mock("@workspace/api-client-react", () => ({
  useGetTodayStats: () => ({ data: _mockTodayStats }),
  useGetSettings: () => ({ data: _mockSettings }),
  getGetTodayStatsQueryKey: () => ["today-stats"],
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildStats(
  standingMinutes: number,
  goalMinutes: number,
  opts: Partial<{
    sittingMinutes: number;
    walkingMinutes: number;
    goalProgressPercent: number;
  }> = {},
) {
  return {
    date: todayStr(),
    sittingMinutes: opts.sittingMinutes ?? 0,
    standingMinutes,
    walkingMinutes: opts.walkingMinutes ?? 0,
    restingMinutes: 0,
    activeMinutes: standingMinutes,
    goalMinutes,
    goalProgressPercent: opts.goalProgressPercent ?? Math.min(100, (standingMinutes / goalMinutes) * 100),
    sessionCount: 1,
    currentStreak: 1,
  };
}

const DEFAULT_SETTINGS = {
  id: 1,
  dailyStandingGoalMinutes: 60,
  sittingAlertMinutes: 45,
  standingMinMinutes: 10,
  standingMaxMinutes: 60,
  reminderIntervalMinutes: 5,
  remindersCount: 3,
  autoDetectWalking: false,
};

// Import TimerPage statically (no PORT/BASE_PATH needed for the component itself)
import TimerPage from "@/pages/TimerPage";

function renderPage() {
  return render(<TimerPage />);
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  localStorage.clear();
  _mockSettings = DEFAULT_SETTINGS;
  _mockTodayStats = undefined;
});

afterEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Scenario 1 — reload after a celebration that already happened today
// ---------------------------------------------------------------------------

describe("TimerPage — reload after today's celebration", () => {
  it("badge is immediately visible (goalAchieved=true from localStorage, celebrating=false)", () => {
    localStorage.setItem(CELEBRATION_KEY, todayStr());
    _mockTodayStats = buildStats(60, 60);

    act(() => {
      renderPage();
    });

    expect(screen.getByRole("button", { name: /replay goal celebration/i })).toBeInTheDocument();
  });

  it("badge appears WITHOUT badge-pop-in animation (skipBadgePopInRef is true on reload)", () => {
    localStorage.setItem(CELEBRATION_KEY, todayStr());
    _mockTodayStats = buildStats(60, 60);

    act(() => {
      renderPage();
    });

    const badge = screen.getByRole("button", { name: /replay goal celebration/i });
    expect(badge.style.animation).not.toContain("badge-pop-in");
  });

  it("goal label shows 'Goal reached!' WITHOUT goal-label-appear class (goalMetOnLoad=true on reload)", () => {
    localStorage.setItem(CELEBRATION_KEY, todayStr());
    _mockTodayStats = buildStats(60, 60);

    act(() => {
      renderPage();
    });

    const label = screen.getByText("Goal reached!");
    expect(label.closest("span")?.className).not.toContain("goal-label-appear");
  });
});

// ---------------------------------------------------------------------------
// Scenario 2 — goal crossed mid-session for the first time today
// ---------------------------------------------------------------------------

describe("TimerPage — mid-session goal crossing", () => {
  it("saves today's date to CELEBRATION_KEY in localStorage when threshold is crossed", () => {
    _mockTodayStats = buildStats(50, 60);

    const { rerender } = renderPage();

    expect(localStorage.getItem(CELEBRATION_KEY)).toBeNull();

    act(() => {
      _mockTodayStats = buildStats(60, 60);
      rerender(<TimerPage />);
    });

    expect(localStorage.getItem(CELEBRATION_KEY)).toBe(todayStr());
  });

  it("goal label immediately shows 'Goal reached!' with goal-label-appear class (goalMetOnLoad=false)", () => {
    _mockTodayStats = buildStats(50, 60);
    const { rerender } = renderPage();

    act(() => {
      _mockTodayStats = buildStats(60, 60);
      rerender(<TimerPage />);
    });

    const label = screen.getByText("Goal reached!");
    expect(label.closest("span")?.className).toContain("goal-label-appear");
  });

  it("badge appears WITH badge-pop-in animation after celebration timeout (skipBadgePopInRef=false)", () => {
    vi.useFakeTimers();
    _mockTodayStats = buildStats(50, 60);

    const { rerender } = renderPage();

    act(() => {
      _mockTodayStats = buildStats(60, 60);
      rerender(<TimerPage />);
    });

    act(() => {
      vi.advanceTimersByTime(2100);
    });

    const badge = screen.getByRole("button", { name: /replay goal celebration/i });
    expect(badge.style.animation).toContain("badge-pop-in");
  });

});

// ---------------------------------------------------------------------------
// Scenario 3 — replaying the celebration via badge tap after reload
// ---------------------------------------------------------------------------

describe("TimerPage — replay celebration after reload", () => {
  it("clicking badge clears skipBadgePopInRef — pop-in animation plays again after replay celebration", () => {
    vi.useFakeTimers();

    localStorage.setItem(CELEBRATION_KEY, todayStr());
    _mockTodayStats = buildStats(60, 60);

    act(() => {
      renderPage();
    });

    const badgeBefore = screen.getByRole("button", { name: /replay goal celebration/i });
    expect(badgeBefore.style.animation).not.toContain("badge-pop-in");

    act(() => {
      fireEvent.click(badgeBefore);
    });

    act(() => {
      vi.advanceTimersByTime(2100);
    });

    const badgeAfter = screen.getByRole("button", { name: /replay goal celebration/i });
    expect(badgeAfter.style.animation).toContain("badge-pop-in");
  });
});

// ---------------------------------------------------------------------------
// Scenario 4 — badge hint wiggle guard on reload
// ---------------------------------------------------------------------------

describe("TimerPage — hint wiggle guard on reload", () => {
  it("hint wiggle does NOT play on reload when BADGE_HINT_KEY equals today", () => {
    localStorage.setItem(CELEBRATION_KEY, todayStr());
    localStorage.setItem(BADGE_HINT_KEY, todayStr());
    _mockTodayStats = buildStats(60, 60);

    act(() => {
      renderPage();
    });

    const badge = screen.getByRole("button", { name: /replay goal celebration/i });
    expect(badge.style.animation).not.toContain("badge-hint-wiggle");
  });

  it("schedules badge hint for first session by persisting BADGE_HINT_KEY in localStorage (before animation ends)", () => {
    // When BADGE_HINT_KEY is absent, showBadgeHint becomes true on the first render,
    // which triggers the scheduling effect: saveBadgeHintDate + hintScheduledRef.current=true.
    // The persistence happens even before the animation completes, so a mid-animation
    // reload still won't replay the wiggle.  The BADGE_HINT_KEY localStorage test below
    // is the primary assertion; the unit tests cover the animation style directly.
    localStorage.setItem(CELEBRATION_KEY, todayStr());
    _mockTodayStats = buildStats(60, 60);

    act(() => {
      renderPage();
    });

    // The scheduling effect ran → localStorage was updated
    expect(localStorage.getItem(BADGE_HINT_KEY)).toBe(todayStr());

    // And the badge is visible (goalAchieved && !celebrating)
    expect(screen.getByRole("button", { name: /replay goal celebration/i })).toBeInTheDocument();
  });

});

// ---------------------------------------------------------------------------
// End-to-end chained scenario — cross goal mid-session → unmount → remount
// This is the primary regression guard for the "no replay on reload" story.
// ---------------------------------------------------------------------------

describe("TimerPage — end-to-end: cross goal then reload", () => {
  it("badge pop-in and goal-label-appear animations are suppressed after reload, but replay via badge click re-enables pop-in", () => {
    vi.useFakeTimers();

    // ── Phase 1: goal crossed mid-session ─────────────────────────────────
    _mockTodayStats = buildStats(50, 60);
    const { rerender, unmount } = renderPage();

    // Trigger threshold crossing
    act(() => {
      _mockTodayStats = buildStats(60, 60);
      rerender(<TimerPage />);
    });

    // Confirm localStorage was written by the crossing
    expect(localStorage.getItem(CELEBRATION_KEY)).toBe(todayStr());

    // Wait for celebration timeout to expire
    act(() => {
      vi.advanceTimersByTime(2100);
    });

    // Badge IS present with pop-in animation (fresh mid-session achievement)
    const freshBadge = screen.getByRole("button", { name: /replay goal celebration/i });
    expect(freshBadge.style.animation).toContain("badge-pop-in");

    // Goal label has appear animation (goalMetOnLoad=false during crossing)
    const freshLabel = screen.getByText("Goal reached!");
    expect(freshLabel.closest("span")?.className).toContain("goal-label-appear");

    // ── Phase 2: simulate page reload (unmount + remount with same localStorage)
    act(() => {
      unmount();
    });

    act(() => {
      renderPage();
    });

    // After reload, badge is visible but WITHOUT pop-in (skipBadgePopInRef=true)
    const reloadBadge = screen.getByRole("button", { name: /replay goal celebration/i });
    expect(reloadBadge.style.animation).not.toContain("badge-pop-in");

    // After reload, goal label is present but WITHOUT appear animation (goalMetOnLoad=true)
    const reloadLabel = screen.getByText("Goal reached!");
    expect(reloadLabel.closest("span")?.className).not.toContain("goal-label-appear");

    // ── Phase 3: replay via badge click re-enables pop-in animation ────────
    act(() => {
      fireEvent.click(reloadBadge);
    });

    act(() => {
      vi.advanceTimersByTime(2100);
    });

    const replayBadge = screen.getByRole("button", { name: /replay goal celebration/i });
    expect(replayBadge.style.animation).toContain("badge-pop-in");
  });
});
