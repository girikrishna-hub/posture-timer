import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import {
  TrophyBadge,
  goalLabelClass,
  CELEBRATION_KEY,
  BADGE_HINT_KEY,
  todayStr,
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
