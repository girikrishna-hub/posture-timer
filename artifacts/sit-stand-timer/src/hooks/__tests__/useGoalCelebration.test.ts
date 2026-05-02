import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  useGoalCelebration,
  CELEBRATION_KEY,
  BADGE_HINT_KEY,
  MIDNIGHT_CHANNEL_NAME,
  getCelebratedDate,
  saveCelebratedDate,
  todayStr,
} from "@/hooks/useGoalCelebration";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("@/utils/audio", () => ({
  playGoalCelebrationTone: vi.fn(),
}));

import { playGoalCelebrationTone } from "@/utils/audio";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderGoalHook(
  liveGoalPercent: number,
  opts: {
    todayStatsLoaded?: boolean;
    onCelebrate?: () => void;
  } = {},
) {
  return renderHook(
    ({ liveGoalPercent, todayStatsLoaded, onCelebrate }) =>
      useGoalCelebration({ liveGoalPercent, todayStatsLoaded, onCelebrate }),
    {
      initialProps: {
        liveGoalPercent,
        todayStatsLoaded: opts.todayStatsLoaded ?? true,
        onCelebrate: opts.onCelebrate,
      },
    },
  );
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});

afterEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// 1. Mid-session goal crossing fires celebration + onCelebrate callback
// ---------------------------------------------------------------------------

describe("useGoalCelebration — mid-session goal crossing", () => {
  it("sets goalAchieved=true when liveGoalPercent crosses from <100 to >=100", () => {
    const { result, rerender } = renderGoalHook(80);

    expect(result.current.goalAchieved).toBe(false);

    act(() => {
      rerender({ liveGoalPercent: 100, todayStatsLoaded: true });
    });

    expect(result.current.goalAchieved).toBe(true);
  });

  it("sets celebrating=true on threshold crossing and resets to false after 2 s", () => {
    vi.useFakeTimers();

    const { result, rerender } = renderGoalHook(80);

    act(() => {
      rerender({ liveGoalPercent: 100, todayStatsLoaded: true });
    });

    expect(result.current.celebrating).toBe(true);

    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(result.current.celebrating).toBe(false);
  });

  it("invokes onCelebrate callback exactly once on threshold crossing", () => {
    const onCelebrate = vi.fn();
    const { result, rerender } = renderGoalHook(80, { onCelebrate });

    void result.current;

    act(() => {
      rerender({ liveGoalPercent: 100, todayStatsLoaded: true, onCelebrate });
    });

    expect(onCelebrate).toHaveBeenCalledTimes(1);
  });

  it("calls playGoalCelebrationTone on threshold crossing", () => {
    const { result, rerender } = renderGoalHook(80);
    void result.current;

    act(() => {
      rerender({ liveGoalPercent: 100, todayStatsLoaded: true });
    });

    expect(playGoalCelebrationTone).toHaveBeenCalledTimes(1);
  });

  it("saves today's date to CELEBRATION_KEY in localStorage on crossing", () => {
    const { result, rerender } = renderGoalHook(80);
    void result.current;

    expect(localStorage.getItem(CELEBRATION_KEY)).toBeNull();

    act(() => {
      rerender({ liveGoalPercent: 100, todayStatsLoaded: true });
    });

    expect(localStorage.getItem(CELEBRATION_KEY)).toBe(todayStr());
  });

  it("does NOT fire when todayStatsLoaded is false even if liveGoalPercent crosses 100", () => {
    const onCelebrate = vi.fn();
    const { result, rerender } = renderGoalHook(80, {
      todayStatsLoaded: false,
      onCelebrate,
    });
    void result.current;

    act(() => {
      rerender({ liveGoalPercent: 100, todayStatsLoaded: false, onCelebrate });
    });

    expect(onCelebrate).not.toHaveBeenCalled();
    expect(result.current.goalAchieved).toBe(false);
  });

  it("freshAchievementRef is true immediately after crossing", () => {
    const { result, rerender } = renderGoalHook(80);
    void result.current;

    act(() => {
      rerender({ liveGoalPercent: 100, todayStatsLoaded: true });
    });

    expect(result.current.freshAchievementRef.current).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Deduplication guard — getCelebratedDate === today blocks re-celebration
// ---------------------------------------------------------------------------

describe("useGoalCelebration — deduplication guard (getCelebratedDate)", () => {
  it("does NOT celebrate when CELEBRATION_KEY already holds today's date", () => {
    saveCelebratedDate(todayStr());

    const onCelebrate = vi.fn();
    const { result, rerender } = renderGoalHook(80, { onCelebrate });
    void result.current;

    act(() => {
      rerender({ liveGoalPercent: 100, todayStatsLoaded: true, onCelebrate });
    });

    expect(onCelebrate).not.toHaveBeenCalled();
    expect(playGoalCelebrationTone).not.toHaveBeenCalled();
  });

  it("does NOT set celebrating=true when deduplication guard blocks", () => {
    saveCelebratedDate(todayStr());

    const { result, rerender } = renderGoalHook(80);
    void result.current;

    act(() => {
      rerender({ liveGoalPercent: 100, todayStatsLoaded: true });
    });

    expect(result.current.celebrating).toBe(false);
  });

  it("allows celebration on a new day even when an old CELEBRATION_KEY is present", () => {
    // Simulate a stale key from yesterday
    localStorage.setItem(CELEBRATION_KEY, "2026-04-30");
    vi.useFakeTimers({ now: new Date(2026, 4, 1, 10, 0, 0, 0).getTime() });

    const onCelebrate = vi.fn();
    const { result, rerender } = renderGoalHook(80, { onCelebrate });
    void result.current;

    act(() => {
      rerender({ liveGoalPercent: 100, todayStatsLoaded: true, onCelebrate });
    });

    expect(onCelebrate).toHaveBeenCalledTimes(1);
  });

  it("initialises goalAchieved=true from localStorage when CELEBRATION_KEY matches today", () => {
    saveCelebratedDate(todayStr());

    const { result } = renderGoalHook(100);

    expect(result.current.goalAchieved).toBe(true);
  });

  it("getCelebratedDate returns today after a mid-session crossing", () => {
    const { result, rerender } = renderGoalHook(80);
    void result.current;

    act(() => {
      rerender({ liveGoalPercent: 100, todayStatsLoaded: true });
    });

    expect(getCelebratedDate()).toBe(todayStr());
  });
});

// ---------------------------------------------------------------------------
// 3. Badge hint scheduling persists to localStorage before animationEnd
// ---------------------------------------------------------------------------

describe("useGoalCelebration — badge hint scheduling", () => {
  it("showBadgeHint is true when goal is achieved and hint has not been shown today", () => {
    // Use todayStatsLoaded=false to avoid the setGoalMetOnLoad state update that would
    // trigger a re-render: by the time of that re-render hintScheduledRef.current is
    // already true (set by the scheduling effect), which would flip showBadgeHint back
    // to false before we can read it.  We verify showBadgeHint=true on the initial
    // render where all three conditions hold: goalAchieved && !badgeHintShown &&
    // !hintScheduledRef.current.
    saveCelebratedDate(todayStr());

    const { result } = renderGoalHook(100, { todayStatsLoaded: false });

    expect(result.current.goalAchieved).toBe(true);
    expect(result.current.badgeHintShown).toBe(false);
    expect(result.current.showBadgeHint).toBe(true);
  });

  it("persists BADGE_HINT_KEY to localStorage synchronously on first render when hint is due", () => {
    saveCelebratedDate(todayStr());

    renderGoalHook(100);

    // The scheduling effect fires immediately on mount (showBadgeHint=true)
    expect(localStorage.getItem(BADGE_HINT_KEY)).toBe(todayStr());
  });

  it("showBadgeHint is false when BADGE_HINT_KEY already equals today", () => {
    saveCelebratedDate(todayStr());
    localStorage.setItem(BADGE_HINT_KEY, todayStr());

    const { result } = renderGoalHook(100);

    expect(result.current.showBadgeHint).toBe(false);
  });

  it("badgeHintShown starts true when BADGE_HINT_KEY equals today on mount", () => {
    saveCelebratedDate(todayStr());
    localStorage.setItem(BADGE_HINT_KEY, todayStr());

    const { result } = renderGoalHook(100);

    expect(result.current.badgeHintShown).toBe(true);
  });

  it("handleBadgeHintShown sets badgeHintShown=true", () => {
    saveCelebratedDate(todayStr());

    const { result } = renderGoalHook(100);

    act(() => {
      result.current.handleBadgeHintShown();
    });

    expect(result.current.badgeHintShown).toBe(true);
  });

  it("showBadgeHint is false when goal is not achieved", () => {
    const { result } = renderGoalHook(80);

    expect(result.current.goalAchieved).toBe(false);
    expect(result.current.showBadgeHint).toBe(false);
  });

  it("BADGE_HINT_KEY is written to localStorage even before the badge-hint-wiggle animation fires (before animationEnd)", () => {
    // This is the key guard: localStorage is persisted eagerly on the effect
    // so even a mid-animation reload won't replay the hint.
    saveCelebratedDate(todayStr());

    // On mount, showBadgeHint is true → scheduling effect writes the key
    renderGoalHook(100);

    // Without any animationEnd event, the key is already written
    expect(localStorage.getItem(BADGE_HINT_KEY)).toBe(todayStr());
  });
});

// ---------------------------------------------------------------------------
// 4. Midnight reset clears all state
// ---------------------------------------------------------------------------

describe("useGoalCelebration — midnight reset clears all state", () => {
  let mockPostMessage: ReturnType<typeof vi.fn>;
  let capturedOnMessage: ((ev: { data: string }) => void) | null;
  let OriginalBroadcastChannel: typeof BroadcastChannel;

  beforeEach(() => {
    mockPostMessage = vi.fn();
    capturedOnMessage = null;

    OriginalBroadcastChannel = globalThis.BroadcastChannel;
    const MockBroadcastChannel = vi.fn().mockImplementation(() => ({
      postMessage: mockPostMessage,
      close: vi.fn(),
      set onmessage(handler: (ev: { data: string }) => void) {
        capturedOnMessage = handler;
      },
    }));
    vi.stubGlobal("BroadcastChannel", MockBroadcastChannel);
  });

  afterEach(() => {
    vi.stubGlobal("BroadcastChannel", OriginalBroadcastChannel);
  });

  it("resets goalAchieved to false after midnight timeout fires", () => {
    const almostMidnight = new Date(2026, 3, 30, 23, 59, 59, 0);
    vi.useFakeTimers({ now: almostMidnight.getTime() });

    saveCelebratedDate("2026-04-30");

    const { result } = renderGoalHook(100);

    expect(result.current.goalAchieved).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1001);
    });

    expect(result.current.goalAchieved).toBe(false);
  });

  it("resets celebrating to false after midnight timeout fires", () => {
    vi.useFakeTimers({ now: new Date(2026, 3, 30, 23, 59, 59, 0).getTime() });

    const { result, rerender } = renderGoalHook(80);
    void result.current;

    // Fake the celebrating state — we need it after an actual crossing
    // so we mount with stats below goal then cross just before midnight
    // while letting fake timers run.
    // For this test we directly verify the doReset path clears celebrating.
    act(() => {
      rerender({ liveGoalPercent: 100, todayStatsLoaded: true });
    });

    // celebrating=true now
    expect(result.current.celebrating).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1001);
    });

    expect(result.current.celebrating).toBe(false);
  });

  it("resets badgeHintShown to false after midnight timeout fires", () => {
    vi.useFakeTimers({ now: new Date(2026, 3, 30, 23, 59, 59, 0).getTime() });

    localStorage.setItem(CELEBRATION_KEY, "2026-04-30");
    localStorage.setItem(BADGE_HINT_KEY, "2026-04-30");

    const { result } = renderGoalHook(100);

    expect(result.current.badgeHintShown).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1001);
    });

    expect(result.current.badgeHintShown).toBe(false);
  });

  it("resets goalMetOnLoad to null after midnight timeout fires", () => {
    vi.useFakeTimers({ now: new Date(2026, 3, 30, 23, 59, 59, 0).getTime() });

    localStorage.setItem(CELEBRATION_KEY, "2026-04-30");

    const { result } = renderGoalHook(100, { todayStatsLoaded: true });

    expect(result.current.goalMetOnLoad).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1001);
    });

    expect(result.current.goalMetOnLoad).toBeNull();
  });

  it("posts 'midnight-reset' on the BroadcastChannel when the timeout fires", () => {
    vi.useFakeTimers({ now: new Date(2026, 3, 30, 23, 59, 59, 0).getTime() });

    localStorage.setItem(CELEBRATION_KEY, "2026-04-30");

    renderGoalHook(100);

    expect(mockPostMessage).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1001);
    });

    expect(mockPostMessage).toHaveBeenCalledWith("midnight-reset");
    expect(mockPostMessage).toHaveBeenCalledTimes(1);
  });

  it("resets goalAchieved when receiving 'midnight-reset' from another tab via BroadcastChannel", () => {
    vi.useFakeTimers({ now: new Date(2026, 3, 30, 12, 0, 0, 0).getTime() });

    localStorage.setItem(CELEBRATION_KEY, "2026-04-30");

    const { result } = renderGoalHook(100);

    expect(result.current.goalAchieved).toBe(true);
    expect(capturedOnMessage).not.toBeNull();

    act(() => {
      capturedOnMessage!({ data: "midnight-reset" });
    });

    expect(result.current.goalAchieved).toBe(false);
  });

  it("ignores unrecognised BroadcastChannel messages", () => {
    vi.useFakeTimers({ now: new Date(2026, 3, 30, 12, 0, 0, 0).getTime() });

    localStorage.setItem(CELEBRATION_KEY, "2026-04-30");

    const { result } = renderGoalHook(100);

    expect(result.current.goalAchieved).toBe(true);

    act(() => {
      capturedOnMessage!({ data: "some-other-message" });
    });

    expect(result.current.goalAchieved).toBe(true);
  });

  it("MIDNIGHT_CHANNEL_NAME constant equals 'sit-stand-midnight-reset'", () => {
    expect(MIDNIGHT_CHANNEL_NAME).toBe("sit-stand-midnight-reset");
  });
});

// ---------------------------------------------------------------------------
// 5. goalMetOnLoad initialises once when todayStatsLoaded flips true
// ---------------------------------------------------------------------------

describe("useGoalCelebration — goalMetOnLoad one-shot initialisation", () => {
  it("goalMetOnLoad starts as null before todayStatsLoaded is true", () => {
    const { result } = renderGoalHook(80, { todayStatsLoaded: false });

    expect(result.current.goalMetOnLoad).toBeNull();
  });

  it("goalMetOnLoad is set to false when todayStatsLoaded flips true and goal is not yet met", () => {
    const { result, rerender } = renderGoalHook(80, { todayStatsLoaded: false });

    expect(result.current.goalMetOnLoad).toBeNull();

    act(() => {
      rerender({ liveGoalPercent: 80, todayStatsLoaded: true });
    });

    expect(result.current.goalMetOnLoad).toBe(false);
  });

  it("goalMetOnLoad is set to true when todayStatsLoaded flips true and goal is already met", () => {
    const { result, rerender } = renderGoalHook(100, { todayStatsLoaded: false });

    expect(result.current.goalMetOnLoad).toBeNull();

    act(() => {
      rerender({ liveGoalPercent: 100, todayStatsLoaded: true });
    });

    expect(result.current.goalMetOnLoad).toBe(true);
  });

  it("goalMetOnLoad is set immediately when todayStatsLoaded=true from the start", () => {
    const { result } = renderGoalHook(60, { todayStatsLoaded: true });

    expect(result.current.goalMetOnLoad).toBe(false);
  });

  it("goalMetOnLoad is only set once — subsequent liveGoalPercent changes do not update it", () => {
    const { result, rerender } = renderGoalHook(80, { todayStatsLoaded: true });

    expect(result.current.goalMetOnLoad).toBe(false);

    act(() => {
      rerender({ liveGoalPercent: 100, todayStatsLoaded: true });
    });

    // goalMetOnLoad should remain false — it was set once at the point when
    // todayStatsLoaded first became true (goal was at 80% then).
    expect(result.current.goalMetOnLoad).toBe(false);
  });

  it("goalMetOnLoad ignores subsequent todayStatsLoaded=true renders (one-shot guard)", () => {
    const { result, rerender } = renderGoalHook(80, { todayStatsLoaded: false });

    act(() => {
      rerender({ liveGoalPercent: 80, todayStatsLoaded: true });
    });

    expect(result.current.goalMetOnLoad).toBe(false);

    // Re-render with todayStatsLoaded=false then true again — hasSetGoalMetOnLoad
    // ref prevents a second write.
    act(() => {
      rerender({ liveGoalPercent: 100, todayStatsLoaded: true });
    });

    // Still false — captured the first moment todayStatsLoaded was true.
    expect(result.current.goalMetOnLoad).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. skipBadgePopInRef initialisation from localStorage
// ---------------------------------------------------------------------------

describe("useGoalCelebration — skipBadgePopInRef initialisation", () => {
  it("skipBadgePopInRef.current is false when CELEBRATION_KEY is absent", () => {
    const { result } = renderGoalHook(80);

    expect(result.current.skipBadgePopInRef.current).toBe(false);
  });

  it("skipBadgePopInRef.current is true when CELEBRATION_KEY matches today on mount", () => {
    saveCelebratedDate(todayStr());

    const { result } = renderGoalHook(100);

    expect(result.current.skipBadgePopInRef.current).toBe(true);
  });

  it("skipBadgePopInRef.current is false when CELEBRATION_KEY holds a past date", () => {
    localStorage.setItem(CELEBRATION_KEY, "2026-04-30");
    vi.useFakeTimers({ now: new Date(2026, 4, 1, 10, 0, 0, 0).getTime() });

    const { result } = renderGoalHook(100);

    expect(result.current.skipBadgePopInRef.current).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 7. replayCelebration — re-triggers effects without writing localStorage
// ---------------------------------------------------------------------------

describe("useGoalCelebration — replayCelebration", () => {
  it("sets celebrating=true when called while goalAchieved=true and not already celebrating", () => {
    vi.useFakeTimers();

    saveCelebratedDate(todayStr());
    const { result } = renderGoalHook(100);

    expect(result.current.goalAchieved).toBe(true);
    expect(result.current.celebrating).toBe(false);

    act(() => {
      result.current.replayCelebration();
    });

    expect(result.current.celebrating).toBe(true);
  });

  it("plays celebration tone on replay", () => {
    vi.useFakeTimers();

    saveCelebratedDate(todayStr());
    const { result } = renderGoalHook(100);

    act(() => {
      result.current.replayCelebration();
    });

    expect(playGoalCelebrationTone).toHaveBeenCalledTimes(1);
  });

  it("does nothing when goalAchieved=false", () => {
    const { result } = renderGoalHook(80);

    act(() => {
      result.current.replayCelebration();
    });

    expect(result.current.celebrating).toBe(false);
    expect(playGoalCelebrationTone).not.toHaveBeenCalled();
  });

  it("clears skipBadgePopInRef on replay", () => {
    vi.useFakeTimers();

    saveCelebratedDate(todayStr());
    const { result } = renderGoalHook(100);

    expect(result.current.skipBadgePopInRef.current).toBe(true);

    act(() => {
      result.current.replayCelebration();
    });

    expect(result.current.skipBadgePopInRef.current).toBe(false);
  });

  it("celebrating resets to false after 2 s on replay", () => {
    vi.useFakeTimers();

    saveCelebratedDate(todayStr());
    const { result } = renderGoalHook(100);

    act(() => {
      result.current.replayCelebration();
    });

    expect(result.current.celebrating).toBe(true);

    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(result.current.celebrating).toBe(false);
  });
});
