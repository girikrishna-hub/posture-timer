/**
 * Integration tests confirming that soundBanner and autoSwitchBanner in
 * TimerPage are mutually exclusive — showing one immediately hides the other
 * so they never render at the same fixed-top-center position simultaneously.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Module mocks
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
    notificationPermission: "granted",
    requestNotificationPermission: vi.fn(),
  }),
}));

vi.mock("@/utils/audio", () => ({
  playGoalCelebrationTone: vi.fn(),
  isSoundEnabled: () => true,
  setSoundEnabled: vi.fn(),
}));

// Expose onAutoSwitch so tests can fire auto-switch events
let capturedOnAutoSwitch: ((toMode: string, reason: string, fromMode: string) => void) | null = null;

vi.mock("@/hooks/useFitbitDrift", () => ({
  useFitbitDrift: ({ onAutoSwitch }: { onAutoSwitch: (toMode: string, reason: string, fromMode: string) => void }) => {
    capturedOnAutoSwitch = onAutoSwitch;
    return {
      nudge: null,
      confirmNudge: vi.fn(),
      cancelNudge: vi.fn(),
      clearNudge: vi.fn(),
      connected: false,
    };
  },
}));

vi.mock("@workspace/api-client-react", () => ({
  useGetTodayStats: () => ({ data: undefined }),
  useGetSettings: () => ({ data: undefined }),
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

import TimerPage from "@/pages/TimerPage";

function renderPage() {
  return render(<TimerPage />);
}

function triggerAutoSwitch(toMode = "standing", reason = "no movement", fromMode = "sitting") {
  act(() => {
    capturedOnAutoSwitch!(toMode, reason, fromMode);
  });
}

function clickSoundToggle() {
  const btn = screen.getByRole("button", { name: /mute sounds|unmute sounds/i });
  fireEvent.click(btn);
}

function hasSoundBanner() {
  return screen.queryByText(/sound on|sound off/i) !== null;
}

function hasAutoSwitchBanner() {
  return screen.queryByText(/auto-switched to/i) !== null;
}

function assertNeverBothVisible() {
  expect(hasSoundBanner() && hasAutoSwitchBanner()).toBe(false);
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  localStorage.clear();
  capturedOnAutoSwitch = null;
});

afterEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// soundBanner → autoSwitchBanner
// ---------------------------------------------------------------------------

describe("TimerPage — soundBanner and autoSwitchBanner mutual exclusivity", () => {
  it("showing soundBanner removes autoSwitchBanner immediately", () => {
    vi.useFakeTimers();
    act(() => { renderPage(); });

    // Fire an auto-switch event so autoSwitchBanner appears
    triggerAutoSwitch();
    act(() => { vi.advanceTimersByTime(20); });

    expect(hasAutoSwitchBanner()).toBe(true);
    assertNeverBothVisible();

    // Toggle sound — autoSwitchBanner should vanish immediately (hide)
    act(() => { clickSoundToggle(); });

    assertNeverBothVisible();
    expect(hasSoundBanner()).toBe(true);
    expect(hasAutoSwitchBanner()).toBe(false);
  });

  it("showing autoSwitchBanner removes soundBanner immediately", () => {
    vi.useFakeTimers();
    act(() => { renderPage(); });

    // Toggle sound so soundBanner appears
    act(() => { clickSoundToggle(); });
    act(() => { vi.advanceTimersByTime(20); });

    expect(hasSoundBanner()).toBe(true);
    assertNeverBothVisible();

    // Fire auto-switch — soundBanner should vanish immediately (hide)
    triggerAutoSwitch();

    assertNeverBothVisible();
    expect(hasAutoSwitchBanner()).toBe(true);
    expect(hasSoundBanner()).toBe(false);
  });

  it("never shows both banners simultaneously during the full transition window", () => {
    vi.useFakeTimers();
    act(() => { renderPage(); });

    // Show autoSwitchBanner
    triggerAutoSwitch();
    act(() => { vi.advanceTimersByTime(20); });

    expect(hasAutoSwitchBanner()).toBe(true);
    assertNeverBothVisible();

    // Toggle sound — step through the 400 ms window in 50 ms increments
    act(() => { clickSoundToggle(); });

    for (let elapsed = 0; elapsed <= 400; elapsed += 50) {
      act(() => { vi.advanceTimersByTime(50); });
      assertNeverBothVisible();
    }

    expect(hasSoundBanner()).toBe(true);
    expect(hasAutoSwitchBanner()).toBe(false);
  });

  it("never shows both banners simultaneously when auto-switch fires while sound banner is visible", () => {
    vi.useFakeTimers();
    act(() => { renderPage(); });

    // Show soundBanner
    act(() => { clickSoundToggle(); });
    act(() => { vi.advanceTimersByTime(20); });

    expect(hasSoundBanner()).toBe(true);
    assertNeverBothVisible();

    // Fire auto-switch — step through the 400 ms window in 50 ms increments
    triggerAutoSwitch();

    for (let elapsed = 0; elapsed <= 400; elapsed += 50) {
      act(() => { vi.advanceTimersByTime(50); });
      assertNeverBothVisible();
    }

    expect(hasAutoSwitchBanner()).toBe(true);
    expect(hasSoundBanner()).toBe(false);
  });

  it("autoSwitchBanner and soundBanner are never both present at the same time", () => {
    vi.useFakeTimers();
    act(() => { renderPage(); });

    // Initially neither is shown
    assertNeverBothVisible();

    // Show autoSwitchBanner
    triggerAutoSwitch("sitting", "idle too long", "standing");
    act(() => { vi.advanceTimersByTime(20); });
    assertNeverBothVisible();

    // Toggle sound while autoSwitch is active
    act(() => { clickSoundToggle(); });
    assertNeverBothVisible();

    // Toggle sound again
    act(() => { clickSoundToggle(); });
    assertNeverBothVisible();

    // Fire another auto-switch while sound banner showing
    triggerAutoSwitch("standing", "active", "sitting");
    assertNeverBothVisible();
  });
});
