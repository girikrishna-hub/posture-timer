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
import { CELEBRATION_KEY, BADGE_HINT_KEY, MIDNIGHT_CHANNEL_NAME, todayStr } from "@/pages/TimerPage";
import { playGoalCelebrationTone } from "@/utils/audio";

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
  useListSessions: () => ({ data: undefined }),
  getListSessionsQueryKey: () => ["/api/sessions"],
  getVapidPublicKey: vi.fn().mockResolvedValue({ publicKey: "" }),
  subscribePush: vi.fn().mockResolvedValue({ ok: true }),
  unsubscribePush: vi.fn().mockResolvedValue(undefined),
  schedulePush: vi.fn().mockResolvedValue({ ok: true, scheduled: false }),
  cancelPushSchedule: vi.fn().mockResolvedValue({ ok: true }),
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
// Scenario 5 — midnight reset: celebration state clears when clock rolls over
// ---------------------------------------------------------------------------

describe("TimerPage — midnight reset clears daily progress", () => {
  it("goalAchieved resets to false after midnight fires, hiding the badge", () => {
    // Set the clock to 23:59:59 on April 30
    const almostMidnight = new Date(2026, 3, 30, 23, 59, 59, 0);
    vi.useFakeTimers({ now: almostMidnight.getTime() });

    // Seed localStorage: user already celebrated today (April 30)
    localStorage.setItem(CELEBRATION_KEY, "2026-04-30");
    localStorage.setItem(BADGE_HINT_KEY, "2026-04-30");

    // Goal is achieved — badge should be visible
    _mockTodayStats = buildStats(60, 60);

    act(() => {
      renderPage();
    });

    // Before midnight: badge is present (goalAchieved=true from localStorage)
    expect(
      screen.getByRole("button", { name: /replay goal celebration/i }),
    ).toBeInTheDocument();

    // Advance past midnight (~1001 ms): midnight reset fires
    act(() => {
      vi.advanceTimersByTime(1001);
    });

    // After midnight reset: goalAchieved=false → badge is no longer rendered
    expect(
      screen.queryByRole("button", { name: /replay goal celebration/i }),
    ).toBeNull();
  });

  it("after midnight reset, crossing the goal on the new day shows badge WITH pop-in (skipBadgePopInRef cleared)", () => {
    const almostMidnight = new Date(2026, 3, 30, 23, 59, 59, 0);
    vi.useFakeTimers({ now: almostMidnight.getTime() });

    // April 30: goal was achieved and CELEBRATION_KEY stored for that day
    localStorage.setItem(CELEBRATION_KEY, "2026-04-30");

    // Start with stats just below goal on April 30
    _mockTodayStats = buildStats(50, 60);

    const { unmount, rerender } = render(<TimerPage />);

    // Advance past midnight — midnight reset fires, goalAchieved → false
    act(() => {
      vi.advanceTimersByTime(1001);
    });

    // Unmount the April 30 session
    act(() => {
      unmount();
    });

    // It is now May 1
    expect(todayStr()).toBe("2026-05-01");
    // localStorage still has the stale "2026-04-30" key
    expect(localStorage.getItem(CELEBRATION_KEY)).toBe("2026-04-30");

    // Remount on May 1 with stats just below goal so prevGoalPercentRef can cross
    _mockTodayStats = buildStats(50, 60);
    const { rerender: rerenderMay1 } = render(<TimerPage />);

    // Cross the goal on May 1 — this triggers the celebration
    act(() => {
      _mockTodayStats = buildStats(60, 60);
      rerenderMay1(<TimerPage />);
    });

    // Wait for the celebration timeout (2000 ms) to expire → badge becomes visible
    act(() => {
      vi.advanceTimersByTime(2100);
    });

    // Fresh mount on May 1: skipBadgePopInRef is false (ls "2026-04-30" ≠ todayStr "2026-05-01")
    // → badge pop-in animation plays
    const badgeAfter = screen.getByRole("button", { name: /replay goal celebration/i });
    expect(badgeAfter.style.animation).toContain("badge-pop-in");
  });

  it("reloading on the new day after midnight reset schedules badge-hint on first mount (hintScheduledRef initialises false)", () => {
    // Simulate midnight passing: clock advances to May 1, localStorage still has April 30 dates
    vi.useFakeTimers({ now: new Date(2026, 3, 30, 23, 59, 59, 0).getTime() });

    localStorage.setItem(CELEBRATION_KEY, "2026-04-30");
    localStorage.setItem(BADGE_HINT_KEY, "2026-04-30");

    // Mount on April 30 — midnight reset fires
    _mockTodayStats = buildStats(60, 60);
    const { unmount } = render(<TimerPage />);

    act(() => {
      vi.advanceTimersByTime(1001); // cross midnight — now May 1
    });

    act(() => {
      unmount();
    });

    // It is now May 1 — BADGE_HINT_KEY is stale
    expect(todayStr()).toBe("2026-05-01");
    expect(localStorage.getItem(BADGE_HINT_KEY)).toBe("2026-04-30"); // not yet "2026-05-01"

    // User crossed the goal on May 1 (simulated by writing CELEBRATION_KEY for today)
    localStorage.setItem(CELEBRATION_KEY, "2026-05-01");

    // Reload: goalAchieved=true from CELEBRATION_KEY, hintScheduledRef starts false
    // because BADGE_HINT_KEY "2026-04-30" ≠ todayStr() "2026-05-01"
    _mockTodayStats = buildStats(60, 60);
    act(() => {
      render(<TimerPage />);
    });

    // The hint-scheduling effect fires (showBadgeHint was true on first render),
    // writing today's date to BADGE_HINT_KEY — the same observable signal the
    // existing "schedules badge hint" test verifies.
    expect(localStorage.getItem(BADGE_HINT_KEY)).toBe("2026-05-01");

    // Badge is still visible (goal achieved on May 1)
    expect(
      screen.getByRole("button", { name: /replay goal celebration/i }),
    ).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Scenario 6 — cross-tab midnight reset via BroadcastChannel
// ---------------------------------------------------------------------------

describe("TimerPage — cross-tab midnight reset via BroadcastChannel", () => {
  // We track the mock channel instance created when the component mounts so
  // tests can inspect postMessage calls and simulate incoming messages.
  let mockPostMessage: ReturnType<typeof vi.fn>;
  let capturedOnMessage: ((ev: { data: string }) => void) | null;
  let OriginalBroadcastChannel: typeof BroadcastChannel;

  beforeEach(() => {
    mockPostMessage = vi.fn();
    capturedOnMessage = null;

    // Save the real BroadcastChannel (jsdom provides one) and swap it for a
    // controllable mock so we can inspect what the hook sends and deliver
    // synthetic messages from "another tab".
    OriginalBroadcastChannel = globalThis.BroadcastChannel;
    const MockBroadcastChannel = vi.fn().mockImplementation((name: string) => {
      void name;
      const instance = {
        postMessage: mockPostMessage,
        close: vi.fn(),
        set onmessage(handler: (ev: { data: string }) => void) {
          capturedOnMessage = handler;
        },
      };
      return instance;
    });
    vi.stubGlobal("BroadcastChannel", MockBroadcastChannel);
  });

  afterEach(() => {
    vi.stubGlobal("BroadcastChannel", OriginalBroadcastChannel);
    vi.useRealTimers();
    localStorage.clear();
    vi.clearAllMocks();
  });

  it("MIDNIGHT_CHANNEL_NAME constant equals 'sit-stand-midnight-reset'", () => {
    expect(MIDNIGHT_CHANNEL_NAME).toBe("sit-stand-midnight-reset");
  });

  it("posts 'midnight-reset' on the BroadcastChannel when the midnight timeout fires", () => {
    // Set the clock to 23:59:59 on April 30 — ~1 s from midnight.
    vi.useFakeTimers({ now: new Date(2026, 3, 30, 23, 59, 59, 0).getTime() });

    // Goal already achieved so the badge is present before midnight.
    localStorage.setItem(CELEBRATION_KEY, "2026-04-30");
    _mockTodayStats = buildStats(60, 60);

    act(() => { render(<TimerPage />); });

    // Confirm the channel was opened and no message sent yet.
    expect(mockPostMessage).not.toHaveBeenCalled();

    // Advance past midnight — the setTimeout fires in this tab.
    act(() => { vi.advanceTimersByTime(1001); });

    // The hook must broadcast before resetting locally.
    expect(mockPostMessage).toHaveBeenCalledWith("midnight-reset");
    expect(mockPostMessage).toHaveBeenCalledTimes(1);
  });

  it("resets cleanly when it receives a 'midnight-reset' message from another tab", () => {
    // Stay on April 30, goal already achieved — badge is visible.
    vi.useFakeTimers({ now: new Date(2026, 3, 30, 12, 0, 0, 0).getTime() });
    localStorage.setItem(CELEBRATION_KEY, "2026-04-30");
    _mockTodayStats = buildStats(60, 60);

    act(() => { render(<TimerPage />); });

    // Badge is visible before the cross-tab reset.
    expect(
      screen.getByRole("button", { name: /replay goal celebration/i }),
    ).toBeInTheDocument();

    // Confirm the hook registered an onmessage listener.
    expect(capturedOnMessage).not.toBeNull();

    // Simulate the broadcast arriving from another tab.
    act(() => {
      capturedOnMessage!({ data: "midnight-reset" });
    });

    // This tab must now show no badge — goalAchieved reset to false.
    expect(
      screen.queryByRole("button", { name: /replay goal celebration/i }),
    ).toBeNull();
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

// ---------------------------------------------------------------------------
// Scenario 7 — localStorage deduplication guard (getCelebratedDate === today)
//
// These tests exercise the second guard inside the celebration useEffect:
//
//   const today = todayStr();
//   if (getCelebratedDate() === today) return;   ← this guard
//   saveCelebratedDate(today);
//   ...celebration fires...
//
// The guard prevents re-celebration when the goal is crossed mid-session but
// CELEBRATION_KEY already holds today's date (e.g. if another session already
// celebrated earlier today, or if the goal percentage somehow dips back below
// 100% then rises again).
// ---------------------------------------------------------------------------

describe("TimerPage — deduplication guard: CELEBRATION_KEY already equals today blocks re-celebration", () => {
  it("playGoalCelebrationTone is NOT called when CELEBRATION_KEY already equals today before the goal crossing", () => {
    // Arrange: pre-seed localStorage as if an earlier session already celebrated today.
    localStorage.setItem(CELEBRATION_KEY, todayStr());

    // Start with stats below the goal so prevGoalPercentRef can advance from a
    // sub-100 value, making shouldTriggerGoalCelebration return true on crossing.
    _mockTodayStats = buildStats(50, 60);
    const { rerender } = renderPage();

    // Confirm the tone has not fired during initial render.
    expect(playGoalCelebrationTone).not.toHaveBeenCalled();

    // Act: cross the goal — shouldTriggerGoalCelebration(prev<100, 100) = true,
    // but the localStorage guard (getCelebratedDate() === today) must block.
    act(() => {
      _mockTodayStats = buildStats(60, 60);
      rerender(<TimerPage />);
    });

    // Assert: the deduplication guard fired — tone was never played.
    expect(playGoalCelebrationTone).not.toHaveBeenCalled();
  });

  it("CELEBRATION_KEY is NOT overwritten when the dedup guard fires (value stays as originally set)", () => {
    const existingValue = todayStr();
    localStorage.setItem(CELEBRATION_KEY, existingValue);

    _mockTodayStats = buildStats(50, 60);
    const { rerender } = renderPage();

    act(() => {
      _mockTodayStats = buildStats(60, 60);
      rerender(<TimerPage />);
    });

    // The guard short-circuits before saveCelebratedDate — value is unchanged.
    expect(localStorage.getItem(CELEBRATION_KEY)).toBe(existingValue);
  });

  it("no celebration banner (celebrating state) becomes active when dedup guard fires", () => {
    // The celebrating state drives the GoalProgressRing celebration sequence.
    // While we cannot read React state directly, we can verify that the badge
    // does NOT appear with the fresh badge-pop-in timing that only happens
    // after a celebration (i.e. the 2 s setCelebrating → false timeout).
    vi.useFakeTimers();
    localStorage.setItem(CELEBRATION_KEY, todayStr());

    _mockTodayStats = buildStats(50, 60);
    const { rerender } = renderPage();

    act(() => {
      _mockTodayStats = buildStats(60, 60);
      rerender(<TimerPage />);
    });

    // Advance past the celebration timeout — no badge should appear freshly.
    act(() => {
      vi.advanceTimersByTime(2100);
    });

    // The badge IS present (goalAchieved=true from the pre-existing localStorage)
    // but it must NOT carry badge-pop-in (skipBadgePopInRef=true, no fresh celebration).
    const badge = screen.getByRole("button", { name: /replay goal celebration/i });
    expect(badge.style.animation).not.toContain("badge-pop-in");
  });

  it("playGoalCelebrationTone is called exactly once even when stats dip below 100% and then re-cross (genuine dip-and-recross)", () => {
    // Scenario: fresh session, no CELEBRATION_KEY.
    // 1. 50% → 100%: first crossing, celebration fires, CELEBRATION_KEY written.
    // 2. 100% → 80%: prevGoalPercentRef drops to 80 (below goal again).
    // 3. 80% → 100%: shouldTriggerGoalCelebration(80, 100) = true — the
    //    prevGoalPercentRef crossing guard ALONE would NOT prevent re-firing here.
    //    Only the localStorage dedup guard (getCelebratedDate() === today) blocks it.
    _mockTodayStats = buildStats(50, 60);
    const { rerender } = renderPage();

    expect(playGoalCelebrationTone).not.toHaveBeenCalled();

    // Step 1 — first crossing: 50% → 100%, celebration fires once.
    act(() => {
      _mockTodayStats = buildStats(60, 60);
      rerender(<TimerPage />);
    });

    expect(playGoalCelebrationTone).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(CELEBRATION_KEY)).toBe(todayStr());

    // Step 2 — stats dip below goal (e.g. goal minutes changed): prevGoalPercentRef → <100.
    act(() => {
      _mockTodayStats = buildStats(48, 60); // 80% — below goal again
      rerender(<TimerPage />);
    });

    // No new tone call after the dip.
    expect(playGoalCelebrationTone).toHaveBeenCalledTimes(1);

    // Step 3 — genuine re-crossing: prevGoalPercentRef=80 → 100%.
    // shouldTriggerGoalCelebration(80, 100) is true, but localStorage guard blocks.
    act(() => {
      _mockTodayStats = buildStats(60, 60);
      rerender(<TimerPage />);
    });

    // Still exactly one call — the localStorage dedup guard was the decisive blocker.
    expect(playGoalCelebrationTone).toHaveBeenCalledTimes(1);
  });

  it("saveCelebratedDate is called on the first crossing so subsequent renders are blocked by the guard", () => {
    // Start with no key.
    expect(localStorage.getItem(CELEBRATION_KEY)).toBeNull();

    _mockTodayStats = buildStats(50, 60);
    const { rerender } = renderPage();

    // Cross the goal — saveCelebratedDate writes today.
    act(() => {
      _mockTodayStats = buildStats(60, 60);
      rerender(<TimerPage />);
    });

    const savedDate = localStorage.getItem(CELEBRATION_KEY);
    expect(savedDate).toBe(todayStr());

    // A subsequent render with the same 100% stat does not change the value
    // (the guard fires, short-circuiting before any write).
    act(() => {
      _mockTodayStats = buildStats(60, 60);
      rerender(<TimerPage />);
    });

    expect(localStorage.getItem(CELEBRATION_KEY)).toBe(savedDate);
    // Tone was called exactly once across all renders.
    expect(playGoalCelebrationTone).toHaveBeenCalledTimes(1);
  });
});
