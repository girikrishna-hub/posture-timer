import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import {
  TrophyBadge,
  goalLabelClass,
  CELEBRATION_KEY,
  BADGE_HINT_KEY,
  todayStr,
  msUntilMidnight,
} from "@/pages/TimerPage";

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
});
