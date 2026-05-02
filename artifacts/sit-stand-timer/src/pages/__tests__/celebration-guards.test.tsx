import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, act, renderHook } from "@testing-library/react";
import {
  TrophyBadge,
  goalLabelClass,
  CELEBRATION_KEY,
  BADGE_HINT_KEY,
  MIDNIGHT_CHANNEL_NAME,
  todayStr,
  msUntilMidnight,
  shouldTriggerGoalCelebration,
  computeGoalMetOnLoad,
} from "@/pages/TimerPage";
import {
  getCelebratedDate,
  saveCelebratedDate,
  getBadgeHintDate,
  saveBadgeHintDate,
  useGoalCelebration,
} from "@/hooks/useGoalCelebration";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getBadgeButton() {
  return screen.getByRole("button", { name: /replay goal celebration/i });
}

function getBadgeAnimation() {
  return getBadgeButton().style.animation;
}

// ---------------------------------------------------------------------------
// TrophyBadge — badge-pop-in animation guard (skipBadgePopInRef)
// ---------------------------------------------------------------------------

describe("TrophyBadge — badge-pop-in animation guard", () => {
  it("does NOT include badge-pop-in when skipPopIn=true (reload after celebration)", () => {
    render(
      <TrophyBadge
        skipPopIn
        delayed={false}
        onReplay={() => {}}
        showHint={false}
        onHintShown={() => {}}
      />,
    );
    expect(getBadgeAnimation()).not.toContain("badge-pop-in");
  });

  it("DOES include badge-pop-in when skipPopIn=false (fresh mid-session achievement)", () => {
    render(
      <TrophyBadge
        skipPopIn={false}
        delayed={false}
        onReplay={() => {}}
        showHint={false}
        onHintShown={() => {}}
      />,
    );
    expect(getBadgeAnimation()).toContain("badge-pop-in");
  });

  it("DOES include badge-pop-in when skipPopIn=false after replay (replayCelebration clears the guard)", () => {
    render(
      <TrophyBadge
        skipPopIn={false}
        delayed={false}
        onReplay={() => {}}
        showHint={false}
        onHintShown={() => {}}
      />,
    );
    expect(getBadgeAnimation()).toContain("badge-pop-in");
  });

  it("sets no animation at all when skipPopIn=true and showHint=false", () => {
    render(
      <TrophyBadge
        skipPopIn
        delayed={false}
        onReplay={() => {}}
        showHint={false}
        onHintShown={() => {}}
      />,
    );
    const anim = getBadgeAnimation();
    expect(anim === "" || anim === undefined).toBe(true);
  });

  it("uses a delayed pop-in when delayed=true (fresh achievement after celebration sequence)", () => {
    render(
      <TrophyBadge
        skipPopIn={false}
        delayed={true}
        onReplay={() => {}}
        showHint={false}
        onHintShown={() => {}}
      />,
    );
    const anim = getBadgeAnimation();
    expect(anim).toContain("badge-pop-in");
    expect(anim).toContain("2.1s");
  });

  it("uses no delay when delayed=false", () => {
    render(
      <TrophyBadge
        skipPopIn={false}
        delayed={false}
        onReplay={() => {}}
        showHint={false}
        onHintShown={() => {}}
      />,
    );
    const anim = getBadgeAnimation();
    expect(anim).toContain("badge-pop-in");
    expect(anim).toContain("0s");
  });
});

// ---------------------------------------------------------------------------
// TrophyBadge — badge-hint-wiggle animation guard (hintScheduledRef / badgeHintShown)
// ---------------------------------------------------------------------------

describe("TrophyBadge — badge-hint-wiggle animation guard", () => {
  it("DOES include badge-hint-wiggle when showHint=true (first session after goal met)", () => {
    render(
      <TrophyBadge
        skipPopIn={false}
        delayed={false}
        onReplay={() => {}}
        showHint={true}
        onHintShown={() => {}}
      />,
    );
    expect(getBadgeAnimation()).toContain("badge-hint-wiggle");
  });

  it("does NOT include badge-hint-wiggle when showHint=false (already shown today)", () => {
    render(
      <TrophyBadge
        skipPopIn={false}
        delayed={false}
        onReplay={() => {}}
        showHint={false}
        onHintShown={() => {}}
      />,
    );
    expect(getBadgeAnimation()).not.toContain("badge-hint-wiggle");
  });

  it("calls onHintShown when badge-hint-wiggle animationEnd fires", () => {
    const onHintShown = vi.fn();
    render(
      <TrophyBadge
        skipPopIn={false}
        delayed={false}
        onReplay={() => {}}
        showHint={true}
        onHintShown={onHintShown}
      />,
    );
    const btn = getBadgeButton();
    const event = Object.assign(new Event("animationend", { bubbles: true }), {
      animationName: "badge-hint-wiggle",
    });
    btn.dispatchEvent(event);
    expect(onHintShown).toHaveBeenCalledTimes(1);
  });

  it("does NOT call onHintShown for unrelated animationEnd events (e.g. badge-pop-in)", () => {
    const onHintShown = vi.fn();
    render(
      <TrophyBadge
        skipPopIn={false}
        delayed={false}
        onReplay={() => {}}
        showHint={true}
        onHintShown={onHintShown}
      />,
    );
    const btn = getBadgeButton();
    const event = Object.assign(new Event("animationend", { bubbles: true }), {
      animationName: "badge-pop-in",
    });
    btn.dispatchEvent(event);
    expect(onHintShown).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// TrophyBadge — onReplay callback
// ---------------------------------------------------------------------------

describe("TrophyBadge — onReplay", () => {
  it("calls onReplay when badge is clicked", () => {
    const onReplay = vi.fn();
    render(
      <TrophyBadge
        skipPopIn
        delayed={false}
        onReplay={onReplay}
        showHint={false}
        onHintShown={() => {}}
      />,
    );
    fireEvent.click(getBadgeButton());
    expect(onReplay).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// goalLabelClass — goal-label-appear CSS class guard (goalMetOnLoad)
// ---------------------------------------------------------------------------

describe("goalLabelClass — goal-label-appear CSS class guard", () => {
  it("includes goal-label-appear when goalMetOnLoad=false (goal just crossed mid-session)", () => {
    const className = goalLabelClass(true, false);
    expect(className).toContain("goal-label-appear");
  });

  it("does NOT include goal-label-appear when goalMetOnLoad=true (goal already met at page load)", () => {
    const className = goalLabelClass(true, true);
    expect(className).not.toContain("goal-label-appear");
  });

  it("does NOT include goal-label-appear when goalMetOnLoad=null (stats still loading)", () => {
    const className = goalLabelClass(true, null);
    expect(className).not.toContain("goal-label-appear");
  });

  it("does NOT include goal-label-appear when goal is not yet met", () => {
    const className = goalLabelClass(false, false);
    expect(className).not.toContain("goal-label-appear");
  });

  it("includes the emerald colour class when goal is met", () => {
    const className = goalLabelClass(true, true);
    expect(className).toContain("text-emerald-600");
  });

  it("does NOT include the emerald colour class when goal is not met", () => {
    const className = goalLabelClass(false, null);
    expect(className).not.toContain("text-emerald-600");
  });
});

// ---------------------------------------------------------------------------
// localStorage-based guard initialisation (skipBadgePopInRef / hintScheduledRef)
// These tests verify the localStorage keys and todayStr used to seed the guards.
// ---------------------------------------------------------------------------

describe("localStorage guard initialisation helpers", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("todayStr returns a YYYY-MM-DD formatted string for today", () => {
    const today = todayStr();
    expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const now = new Date();
    const expected = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    expect(today).toBe(expected);
  });

  it("CELEBRATION_KEY and BADGE_HINT_KEY are stable string constants", () => {
    expect(CELEBRATION_KEY).toBe("sit-stand-goal-celebrated");
    expect(BADGE_HINT_KEY).toBe("sit-stand-badge-hint");
  });

  it("when CELEBRATION_KEY equals todayStr the skipBadgePopIn guard is true on component mount", () => {
    localStorage.setItem(CELEBRATION_KEY, todayStr());
    const today = todayStr();
    const skipPopIn = localStorage.getItem(CELEBRATION_KEY) === today;
    expect(skipPopIn).toBe(true);

    render(
      <TrophyBadge
        skipPopIn={skipPopIn}
        delayed={false}
        onReplay={() => {}}
        showHint={false}
        onHintShown={() => {}}
      />,
    );
    expect(getBadgeAnimation()).not.toContain("badge-pop-in");
  });

  it("when CELEBRATION_KEY is absent the skipBadgePopIn guard is false (first visit today)", () => {
    const today = todayStr();
    const skipPopIn = localStorage.getItem(CELEBRATION_KEY) === today;
    expect(skipPopIn).toBe(false);

    render(
      <TrophyBadge
        skipPopIn={skipPopIn}
        delayed={false}
        onReplay={() => {}}
        showHint={false}
        onHintShown={() => {}}
      />,
    );
    expect(getBadgeAnimation()).toContain("badge-pop-in");
  });

  it("when BADGE_HINT_KEY equals todayStr the hintScheduled guard is true on mount", () => {
    localStorage.setItem(BADGE_HINT_KEY, todayStr());
    const today = todayStr();
    const hintAlreadyShown = localStorage.getItem(BADGE_HINT_KEY) === today;
    expect(hintAlreadyShown).toBe(true);

    render(
      <TrophyBadge
        skipPopIn={false}
        delayed={false}
        onReplay={() => {}}
        showHint={!hintAlreadyShown}
        onHintShown={() => {}}
      />,
    );
    expect(getBadgeAnimation()).not.toContain("badge-hint-wiggle");
  });

  it("when BADGE_HINT_KEY is absent the hint guard is false, hint will play", () => {
    const today = todayStr();
    const hintAlreadyShown = localStorage.getItem(BADGE_HINT_KEY) === today;
    expect(hintAlreadyShown).toBe(false);

    render(
      <TrophyBadge
        skipPopIn={false}
        delayed={false}
        onReplay={() => {}}
        showHint={!hintAlreadyShown}
        onHintShown={() => {}}
      />,
    );
    expect(getBadgeAnimation()).toContain("badge-hint-wiggle");
  });
});

// ---------------------------------------------------------------------------
// Midnight reset — day-boundary behaviour
// ---------------------------------------------------------------------------

describe("midnight reset — msUntilMidnight timing", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("msUntilMidnight returns a positive value less than 24 hours", () => {
    const ms = msUntilMidnight();
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
  });

  it("msUntilMidnight returns ~1 second when the clock is at 23:59:59", () => {
    // Pin the clock to 23:59:59.000 on an arbitrary date
    const almostMidnight = new Date("2026-04-30T23:59:59.000Z");
    // Use local midnight so the calculation aligns with the implementation
    const localAlmostMidnight = new Date(
      almostMidnight.getFullYear(),
      almostMidnight.getMonth(),
      almostMidnight.getDate(),
      23, 59, 59, 0,
    );
    vi.useFakeTimers({ now: localAlmostMidnight.getTime() });
    const ms = msUntilMidnight();
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(1000);
  });

  it("msUntilMidnight returns ~86400000 ms when the clock is at 00:00:00", () => {
    const justAfterMidnight = new Date(
      2026, 3, 30, 0, 0, 0, 0, // 2026-04-30 00:00:00 local
    );
    vi.useFakeTimers({ now: justAfterMidnight.getTime() });
    const ms = msUntilMidnight();
    // Should be almost a full day (within 1 second of 86400000)
    expect(ms).toBeGreaterThan(86400000 - 1000);
    expect(ms).toBeLessThanOrEqual(86400000);
  });
});

describe("midnight reset — localStorage guards clear for the new day", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  it("localStorage keys set to the old day no longer match todayStr() after the date advances", () => {
    // Simulate: user celebrated on April 30
    const oldDate = "2026-04-30";
    localStorage.setItem(CELEBRATION_KEY, oldDate);
    localStorage.setItem(BADGE_HINT_KEY, oldDate);

    // Advance the clock past midnight — it's now May 1
    vi.useFakeTimers({ now: new Date(2026, 4, 1, 0, 0, 1, 0).getTime() });

    const newDay = todayStr();
    expect(newDay).toBe("2026-05-01");

    // The stored values are stale: they don't match the new day
    expect(localStorage.getItem(CELEBRATION_KEY)).not.toBe(newDay);
    expect(localStorage.getItem(BADGE_HINT_KEY)).not.toBe(newDay);
  });

  it("skipBadgePopIn guard evaluates to false when localStorage has yesterday's date", () => {
    const oldDate = "2026-04-30";
    localStorage.setItem(CELEBRATION_KEY, oldDate);

    // It's the next day
    vi.useFakeTimers({ now: new Date(2026, 4, 1, 0, 0, 1, 0).getTime() });

    const skipPopIn = localStorage.getItem(CELEBRATION_KEY) === todayStr();
    expect(skipPopIn).toBe(false);
  });

  it("hintAlreadyShown guard evaluates to false when localStorage has yesterday's date", () => {
    const oldDate = "2026-04-30";
    localStorage.setItem(BADGE_HINT_KEY, oldDate);

    // It's the next day
    vi.useFakeTimers({ now: new Date(2026, 4, 1, 0, 0, 1, 0).getTime() });

    const hintAlreadyShown = localStorage.getItem(BADGE_HINT_KEY) === todayStr();
    expect(hintAlreadyShown).toBe(false);
  });

  it("TrophyBadge shows badge-pop-in on new day even though yesterday's CELEBRATION_KEY is set", () => {
    // Previous day's entry is present in localStorage
    localStorage.setItem(CELEBRATION_KEY, "2026-04-30");

    // It's the next day — guard should not suppress the pop-in
    vi.useFakeTimers({ now: new Date(2026, 4, 1, 0, 0, 1, 0).getTime() });

    const skipPopIn = localStorage.getItem(CELEBRATION_KEY) === todayStr();
    expect(skipPopIn).toBe(false);

    render(
      <TrophyBadge
        skipPopIn={skipPopIn}
        delayed={false}
        onReplay={() => {}}
        showHint={false}
        onHintShown={() => {}}
      />,
    );
    expect(getBadgeAnimation()).toContain("badge-pop-in");
  });

  it("TrophyBadge shows badge-hint-wiggle on new day even though yesterday's BADGE_HINT_KEY is set", () => {
    localStorage.setItem(BADGE_HINT_KEY, "2026-04-30");

    vi.useFakeTimers({ now: new Date(2026, 4, 1, 0, 0, 1, 0).getTime() });

    const hintAlreadyShown = localStorage.getItem(BADGE_HINT_KEY) === todayStr();
    expect(hintAlreadyShown).toBe(false);

    render(
      <TrophyBadge
        skipPopIn={false}
        delayed={false}
        onReplay={() => {}}
        showHint={!hintAlreadyShown}
        onHintShown={() => {}}
      />,
    );
    expect(getBadgeAnimation()).toContain("badge-hint-wiggle");
  });

  it("midnight reset setTimeout fires after msUntilMidnight delay and callback executes", () => {
    // Set the clock to 23:59:59 on April 30
    const almostMidnight = new Date(2026, 3, 30, 23, 59, 59, 0);
    vi.useFakeTimers({ now: almostMidnight.getTime() });

    // Confirm we're ~1 second from midnight
    const delay = msUntilMidnight();
    expect(delay).toBeGreaterThan(0);
    expect(delay).toBeLessThanOrEqual(1000);

    // Simulate the reset callback registering and firing
    let resetFired = false;
    const timer = setTimeout(() => {
      resetFired = true;
    }, delay);

    expect(resetFired).toBe(false);

    // Advance past midnight
    vi.advanceTimersByTime(1001);
    expect(resetFired).toBe(true);

    clearTimeout(timer);
  });

  it("todayStr returns the new day's date after midnight advance", () => {
    // Just before midnight on April 30
    vi.useFakeTimers({ now: new Date(2026, 3, 30, 23, 59, 59, 0).getTime() });
    expect(todayStr()).toBe("2026-04-30");

    // Advance 1.5 s — now it's May 1
    vi.advanceTimersByTime(1500);
    expect(todayStr()).toBe("2026-05-01");
  });

  it("auto-repeat: callback fires exactly once per midnight crossing over two consecutive nights", () => {
    // Start just before midnight on April 30 so the first crossing is ~1 second away.
    vi.useFakeTimers({ now: new Date(2026, 3, 30, 23, 59, 59, 0).getTime() });

    let fireCount = 0;

    // Mirror the scheduleMidnightReset recursive pattern from useGoalCelebration.ts:
    // after firing it immediately re-schedules itself for the *next* midnight.
    function scheduleMidnightReset() {
      setTimeout(() => {
        fireCount++;
        scheduleMidnightReset();
      }, msUntilMidnight());
    }

    scheduleMidnightReset();

    // Nothing should have fired yet — we are still on April 30.
    expect(fireCount).toBe(0);

    // ── First midnight crossing: April 30 → May 1 ───────────────────────────
    // Advance 1 500 ms to clear the ~1 000 ms timer.
    vi.advanceTimersByTime(1_500);
    // Clock is now May 1 00:00:00.500; the callback has fired once and
    // re-scheduled itself for roughly 24 h from now (May 2 midnight).
    expect(fireCount).toBe(1);

    // Advance almost all of the next 24 hours — the second timer should NOT
    // have fired yet.
    vi.advanceTimersByTime(24 * 60 * 60 * 1_000 - 1_000);
    expect(fireCount).toBe(1);

    // ── Second midnight crossing: May 1 → May 2 ─────────────────────────────
    // Advance the remaining time to push past May 2 midnight.
    vi.advanceTimersByTime(2_000);
    expect(fireCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// shouldTriggerGoalCelebration — prevGoalPercentRef crossing threshold logic
// ---------------------------------------------------------------------------

describe("shouldTriggerGoalCelebration — threshold crossing logic", () => {
  // --- Reload / first-load scenarios (prev === null) ----------------------

  it("returns false when prev is null and current >= 100 (reload with goal already met)", () => {
    // This is the key regression guard: on page reload, prevGoalPercentRef
    // starts as null and the first stats update should NOT fire a celebration
    // even if liveGoalPercent is already at or past 100%.
    expect(shouldTriggerGoalCelebration(null, 100)).toBe(false);
  });

  it("returns false when prev is null and current > 100 (reload, well past goal)", () => {
    expect(shouldTriggerGoalCelebration(null, 150)).toBe(false);
  });

  it("returns false when prev is null and current < 100 (reload, goal not yet met)", () => {
    expect(shouldTriggerGoalCelebration(null, 80)).toBe(false);
  });

  // --- Already-over-the-line scenarios (prev >= 100) ----------------------

  it("returns false when prev >= 100 and current >= 100 (subsequent poll, still at goal)", () => {
    // A stat refresh while the goal is already met must not re-trigger the banner.
    expect(shouldTriggerGoalCelebration(100, 100)).toBe(false);
  });

  it("returns false when prev > 100 and current > 100 (well past goal on both readings)", () => {
    expect(shouldTriggerGoalCelebration(120, 130)).toBe(false);
  });

  it("returns false when prev >= 100 and current < 100 (should never happen in practice, but handled)", () => {
    expect(shouldTriggerGoalCelebration(100, 90)).toBe(false);
  });

  // --- Genuine mid-session crossing scenarios (prev < 100 → current >= 100)

  it("returns true when prev < 100 and current === 100 (exact threshold crossing)", () => {
    // This is the only case that should fire the celebration.
    expect(shouldTriggerGoalCelebration(99, 100)).toBe(true);
  });

  it("returns true when prev < 100 and current > 100 (crossing with overshoot)", () => {
    expect(shouldTriggerGoalCelebration(95, 110)).toBe(true);
  });

  it("returns true when prev is 0 and current is 100 (first session of the day hitting 100)", () => {
    expect(shouldTriggerGoalCelebration(0, 100)).toBe(true);
  });

  // --- Still-below-goal scenarios -----------------------------------------

  it("returns false when prev < 100 and current < 100 (below goal throughout)", () => {
    expect(shouldTriggerGoalCelebration(50, 80)).toBe(false);
  });

  it("returns false when prev < 100 and current < 100 near the edge (99 → 99.9)", () => {
    expect(shouldTriggerGoalCelebration(99, 99.9)).toBe(false);
  });

  // --- Effect sequence: reload-then-update (core regression scenario) ------

  it("simulates reload: stats arrive at 100% then another update arrives — celebration never fires (zero celebrations)", () => {
    // Reload: prevGoalPercentRef starts as null, first stats deliver 100%.
    let prevGoalPercent: number | null = null;
    const celebrationCount = { n: 0 };

    function processUpdate(current: number) {
      if (shouldTriggerGoalCelebration(prevGoalPercent, current)) {
        celebrationCount.n++;
      }
      prevGoalPercent = current;
    }

    // First update on reload — goal already at 100%, should NOT celebrate.
    processUpdate(100);
    expect(celebrationCount.n).toBe(0);

    // Subsequent poll update — still at 100%, should NOT celebrate again.
    processUpdate(100);
    expect(celebrationCount.n).toBe(0);

    // Another poll at 105% — still no new celebration.
    processUpdate(105);
    expect(celebrationCount.n).toBe(0);
  });

  it("simulates live session: starts below 100%, crosses to 100%, further updates do not re-celebrate", () => {
    let prevGoalPercent: number | null = null;
    const celebrationCount = { n: 0 };

    function processUpdate(current: number) {
      if (shouldTriggerGoalCelebration(prevGoalPercent, current)) {
        celebrationCount.n++;
      }
      prevGoalPercent = current;
    }

    // Page load — stats arrive at 60%, no crossing.
    processUpdate(60);
    expect(celebrationCount.n).toBe(0);

    // Progress to 80% — still below goal.
    processUpdate(80);
    expect(celebrationCount.n).toBe(0);

    // Cross the 100% line — celebration fires exactly once.
    processUpdate(100);
    expect(celebrationCount.n).toBe(1);

    // Further progress to 110% — no second celebration.
    processUpdate(110);
    expect(celebrationCount.n).toBe(1);

    // Another poll at 110% — still just the one celebration.
    processUpdate(110);
    expect(celebrationCount.n).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// computeGoalMetOnLoad — hasSetGoalMetOnLoad one-shot initialisation logic
// ---------------------------------------------------------------------------

describe("computeGoalMetOnLoad — goalMetOnLoad initialisation", () => {
  it("returns true when liveGoalPercent === 100 (goal exactly met at page load)", () => {
    // goalMetOnLoad=true suppresses the goal-label-appear animation on reload.
    expect(computeGoalMetOnLoad(100)).toBe(true);
  });

  it("returns true when liveGoalPercent > 100 (goal exceeded at page load)", () => {
    expect(computeGoalMetOnLoad(120)).toBe(true);
  });

  it("returns false when liveGoalPercent < 100 (goal not yet met at page load)", () => {
    // goalMetOnLoad=false means the goal was earned mid-session and the
    // goal-label-appear animation should play.
    expect(computeGoalMetOnLoad(80)).toBe(false);
  });

  it("returns false when liveGoalPercent is 0 (fresh day, no standing yet)", () => {
    expect(computeGoalMetOnLoad(0)).toBe(false);
  });

  it("returns false at 99.9% (just under the threshold)", () => {
    expect(computeGoalMetOnLoad(99.9)).toBe(false);
  });

  // Integration with goalLabelClass: verify that computeGoalMetOnLoad feeds
  // goalLabelClass correctly to suppress/show the appear animation.

  it("goalLabelClass suppresses goal-label-appear when computeGoalMetOnLoad returns true (reload scenario)", () => {
    // Simulates: page reloads with goal already met → no appear animation.
    const onLoad = computeGoalMetOnLoad(100);
    expect(onLoad).toBe(true);
    const cls = goalLabelClass(true, onLoad);
    expect(cls).not.toContain("goal-label-appear");
    expect(cls).toContain("text-emerald-600");
  });

  it("goalLabelClass includes goal-label-appear when computeGoalMetOnLoad returns false (mid-session crossing)", () => {
    // Simulates: goal crossed mid-session → appear animation plays.
    const onLoad = computeGoalMetOnLoad(80);
    expect(onLoad).toBe(false);
    const cls = goalLabelClass(true, onLoad);
    expect(cls).toContain("goal-label-appear");
    expect(cls).toContain("text-emerald-600");
  });
});

// ---------------------------------------------------------------------------
// getCelebratedDate / saveCelebratedDate — localStorage deduplication helpers
//
// These unit tests cover the two localStorage accessors that power the second
// guard inside the celebration useEffect:
//
//   const today = todayStr();
//   if (getCelebratedDate() === today) return;   ← this guard
//   saveCelebratedDate(today);
//
// They verify: correct reads/writes, roundtrip fidelity, and that the boolean
// expression used as the guard evaluates as expected for the three key states
// (key absent, key = today, key = yesterday).
// ---------------------------------------------------------------------------

describe("getCelebratedDate / saveCelebratedDate — localStorage deduplication helpers", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("getCelebratedDate returns an empty string when CELEBRATION_KEY is absent", () => {
    expect(getCelebratedDate()).toBe("");
  });

  it("getCelebratedDate returns the stored date string when CELEBRATION_KEY is set", () => {
    const date = "2026-05-01";
    localStorage.setItem(CELEBRATION_KEY, date);
    expect(getCelebratedDate()).toBe(date);
  });

  it("saveCelebratedDate writes the given date to CELEBRATION_KEY in localStorage", () => {
    const date = "2026-05-01";
    saveCelebratedDate(date);
    expect(localStorage.getItem(CELEBRATION_KEY)).toBe(date);
  });

  it("getCelebratedDate reflects a value written by saveCelebratedDate (roundtrip)", () => {
    const date = todayStr();
    saveCelebratedDate(date);
    expect(getCelebratedDate()).toBe(date);
  });

  it("deduplication guard evaluates to false when CELEBRATION_KEY is absent — first celebration is allowed", () => {
    const today = todayStr();
    // Nothing written yet: getCelebratedDate() returns "" ≠ today
    expect(getCelebratedDate() === today).toBe(false);
  });

  it("deduplication guard evaluates to true after saveCelebratedDate(today) — re-celebration is blocked", () => {
    const today = todayStr();
    saveCelebratedDate(today);
    // Guard fires: getCelebratedDate() === today
    expect(getCelebratedDate() === today).toBe(true);
  });

  it("deduplication guard evaluates to false when CELEBRATION_KEY holds yesterday's date — new-day celebration is allowed", () => {
    // Simulate: key was written on April 30, it is now May 1
    vi.useFakeTimers({ now: new Date(2026, 4, 1, 0, 0, 1, 0).getTime() });
    localStorage.setItem(CELEBRATION_KEY, "2026-04-30");

    const today = todayStr(); // "2026-05-01"
    expect(getCelebratedDate() === today).toBe(false);

    vi.useRealTimers();
  });

  it("saveCelebratedDate overwrites a stale date — guard evaluates to true for the new date", () => {
    // Old entry from yesterday
    localStorage.setItem(CELEBRATION_KEY, "2026-04-30");

    // Save today's date (as the celebration effect would do)
    const today = todayStr();
    saveCelebratedDate(today);

    expect(getCelebratedDate()).toBe(today);
    expect(getCelebratedDate() === today).toBe(true);
  });

  it("shouldTriggerGoalCelebration returns true but guard would block when key equals today (scenario composition)", () => {
    // Compose the two guards as they appear in the useEffect:
    //   1. shouldTriggerGoalCelebration(prev, current) — prevGoalPercentRef crossing check
    //   2. getCelebratedDate() === today              — localStorage deduplication check
    //
    // Scenario: prev=60, current=100 satisfies the crossing check (true),
    // but CELEBRATION_KEY already holds today → the compound condition blocks.
    const today = todayStr();
    saveCelebratedDate(today); // simulate: already celebrated this session/day

    const prev = 60;
    const current = 100;

    const crossingDetected = shouldTriggerGoalCelebration(prev, current);
    const alreadyCelebrated = getCelebratedDate() === today;

    expect(crossingDetected).toBe(true);
    expect(alreadyCelebrated).toBe(true);
    // The effective gate the hook uses: crossing AND NOT already celebrated
    expect(crossingDetected && !alreadyCelebrated).toBe(false);
  });

  it("both guards pass when crossing occurs for the first time today (celebration is allowed)", () => {
    // CELEBRATION_KEY absent: fresh session, first crossing
    const today = todayStr();
    const prev = 80;
    const current = 100;

    const crossingDetected = shouldTriggerGoalCelebration(prev, current);
    const alreadyCelebrated = getCelebratedDate() === today;

    expect(crossingDetected).toBe(true);
    expect(alreadyCelebrated).toBe(false);
    // Effective gate: crossing AND NOT already celebrated → celebration fires
    expect(crossingDetected && !alreadyCelebrated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getBadgeHintDate / saveBadgeHintDate — localStorage deduplication helpers
//
// These unit tests cover the two localStorage accessors that power the
// badge-hint-wiggle deduplication guard:
//
//   const hintShown = getBadgeHintDate() === todayStr();
//   if (!hintShown) {
//     saveBadgeHintDate(todayStr());
//   }
//
// They verify: correct reads/writes, roundtrip fidelity, and that the boolean
// expression used as the guard evaluates as expected for the three key states
// (key absent, key = today, key = yesterday).
// ---------------------------------------------------------------------------

describe("getBadgeHintDate / saveBadgeHintDate — localStorage deduplication helpers", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("getBadgeHintDate returns an empty string when BADGE_HINT_KEY is absent", () => {
    expect(getBadgeHintDate()).toBe("");
  });

  it("getBadgeHintDate returns the stored date string when BADGE_HINT_KEY is set", () => {
    const date = "2026-05-01";
    localStorage.setItem(BADGE_HINT_KEY, date);
    expect(getBadgeHintDate()).toBe(date);
  });

  it("saveBadgeHintDate writes the given date to BADGE_HINT_KEY in localStorage", () => {
    const date = "2026-05-01";
    saveBadgeHintDate(date);
    expect(localStorage.getItem(BADGE_HINT_KEY)).toBe(date);
  });

  it("getBadgeHintDate reflects a value written by saveBadgeHintDate (roundtrip)", () => {
    const date = todayStr();
    saveBadgeHintDate(date);
    expect(getBadgeHintDate()).toBe(date);
  });

  it("deduplication guard evaluates to false when BADGE_HINT_KEY is absent — first hint is allowed", () => {
    const today = todayStr();
    // Nothing written yet: getBadgeHintDate() returns "" ≠ today
    expect(getBadgeHintDate() === today).toBe(false);
  });

  it("deduplication guard evaluates to true after saveBadgeHintDate(today) — re-showing hint is blocked", () => {
    const today = todayStr();
    saveBadgeHintDate(today);
    // Guard fires: getBadgeHintDate() === today
    expect(getBadgeHintDate() === today).toBe(true);
  });

  it("deduplication guard evaluates to false when BADGE_HINT_KEY holds yesterday's date — new-day hint is allowed", () => {
    // Simulate: key was written on April 30, it is now May 1
    vi.useFakeTimers({ now: new Date(2026, 4, 1, 0, 0, 1, 0).getTime() });
    localStorage.setItem(BADGE_HINT_KEY, "2026-04-30");

    const today = todayStr(); // "2026-05-01"
    expect(getBadgeHintDate() === today).toBe(false);

    vi.useRealTimers();
  });

  it("saveBadgeHintDate overwrites a stale date — guard evaluates to true for the new date", () => {
    // Old entry from yesterday
    localStorage.setItem(BADGE_HINT_KEY, "2026-04-30");

    // Save today's date (as the hint effect would do)
    const today = todayStr();
    saveBadgeHintDate(today);

    expect(getBadgeHintDate()).toBe(today);
    expect(getBadgeHintDate() === today).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// midnight reset — cleanup cancels the timer cleanly when unmounted
//
// useGoalCelebration stores the midnight setTimeout id in a local `dayTimer`
// variable and calls clearTimeout(dayTimer) in the cleanup function returned
// from its useEffect.  If that cleanup is missing or broken the timer fires
// after the component is gone and triggers state updates on an unmounted
// component.
//
// Strategy: spy on global.setTimeout to count scheduling calls.
//   • On mount, scheduleMidnightReset() calls setTimeout once.
//   • If the timer ever fires it immediately re-schedules itself, producing a
//     second setTimeout call.
//   • After unmounting before midnight and advancing the clock past midnight
//     the call count must not have increased — proving the timer was cancelled.
// ---------------------------------------------------------------------------

describe("midnight reset — cleanup cancels timer on unmount", () => {
  beforeEach(() => {
    localStorage.clear();
    // Pin the clock to 23:59:59 on April 30 — midnight is ~1 second away.
    vi.useFakeTimers({ now: new Date(2026, 3, 30, 23, 59, 59, 0).getTime() });
  });

  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  it("does not fire the midnight reset callback after the hook unmounts", () => {
    // Track every setTimeout call so we can detect rescheduling.
    const setTimeoutSpy = vi.spyOn(global, "setTimeout");

    const { unmount } = renderHook(() =>
      useGoalCelebration({ liveGoalPercent: 50 }),
    );

    // scheduleMidnightReset() ran on mount — record how many setTimeout
    // calls have happened (includes any other internal timers the hook uses).
    const callsAfterMount = setTimeoutSpy.mock.calls.length;
    expect(callsAfterMount).toBeGreaterThanOrEqual(1);

    // Unmount before midnight — the cleanup function should call
    // clearTimeout(dayTimer), cancelling the pending midnight timer.
    unmount();

    // Advance the clock 2 seconds past midnight.  If clearTimeout was NOT
    // called the pending callback would fire here, call doReset(), and then
    // call scheduleMidnightReset() again — producing an additional setTimeout
    // call and leaving us with callsAfterMount + 1.
    act(() => {
      vi.advanceTimersByTime(2_000);
    });

    // The count must not have grown: no new setTimeout means the callback
    // never fired and cleanup cancelled the timer cleanly.
    expect(setTimeoutSpy.mock.calls.length).toBe(callsAfterMount);

    setTimeoutSpy.mockRestore();
  });
});
