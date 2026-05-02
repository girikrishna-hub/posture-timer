/**
 * Integration tests for the CSV export success banner in DashboardPage's SessionsTab.
 *
 * These tests render the real DashboardPage with mocked dependencies, navigate to
 * the Sessions tab, and verify that a successful export shows the green
 * "CSV exported successfully." banner, that the dismiss button works, and that
 * the banner auto-dismisses after 4 seconds.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

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

vi.mock("html2canvas", () => ({ default: vi.fn() }));

vi.mock("@workspace/api-client-react", () => ({
  useGetTodayStats: () => ({ data: undefined }),
  useGetMetricsSummary: () => ({ data: undefined, isLoading: false }),
  useGetDailyMetrics: () => ({ data: undefined, isLoading: false }),
  useListSessions: () => ({ data: { sessions: [], total: 0 }, isLoading: false }),
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

import DashboardPage from "@/pages/DashboardPage";

function renderPage() {
  return render(<DashboardPage />);
}

function navigateToSessionsTab() {
  const sessionsTab = screen.getByRole("button", { name: /^sessions$/i });
  fireEvent.click(sessionsTab);
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  localStorage.clear();

  // Mock URL.createObjectURL / revokeObjectURL (not available in JSDOM)
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: vi.fn(() => "blob:mock-url"),
    revokeObjectURL: vi.fn(),
  });

  // Prevent the anchor click from triggering navigation
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
});

afterEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Helpers for mocking fetch
// ---------------------------------------------------------------------------

function mockFetchSuccess() {
  const blob = new Blob(["date,mode\n2026-05-01,sitting"], { type: "text/csv" });
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(blob),
    }),
  );
}

function mockFetchFailure() {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: false,
      blob: () => Promise.resolve(new Blob()),
    }),
  );
}

// ---------------------------------------------------------------------------
// Scenario: successful export shows the success banner
// ---------------------------------------------------------------------------

describe("DashboardPage — CSV export success banner", () => {
  it("shows the 'CSV exported successfully.' banner after a successful export", async () => {
    mockFetchSuccess();

    act(() => { renderPage(); });
    act(() => { navigateToSessionsTab(); });

    // Banner should not be present before export
    expect(screen.queryByText(/CSV exported successfully/i)).toBeNull();

    // Click "Export CSV"
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /export csv/i }));
    });

    // Success banner should now be visible
    const bannerText = screen.getByText(/CSV exported successfully\./i);
    expect(bannerText).toBeInTheDocument();
    // Confirm it is the green (emerald) success banner, not an error banner
    const bannerContainer = bannerText.closest("div");
    expect(bannerContainer?.className).toMatch(/emerald/);
  });

  it("the success banner has a dismiss button that removes it when clicked", async () => {
    vi.useFakeTimers();
    mockFetchSuccess();

    act(() => { renderPage(); });
    act(() => { navigateToSessionsTab(); });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /export csv/i }));
    });

    // Banner is present
    expect(screen.getByText(/CSV exported successfully\./i)).toBeInTheDocument();

    // Click the dismiss button
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    });

    // After the 350 ms fade-out transition the banner unmounts
    act(() => {
      vi.advanceTimersByTime(400);
    });

    expect(screen.queryByText(/CSV exported successfully\./i)).toBeNull();
  });

  it("the success banner auto-dismisses after 4 seconds", async () => {
    vi.useFakeTimers();
    mockFetchSuccess();

    act(() => { renderPage(); });
    act(() => { navigateToSessionsTab(); });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /export csv/i }));
    });

    // Banner is visible
    expect(screen.getByText(/CSV exported successfully\./i)).toBeInTheDocument();

    // Advance past the 4 000 ms auto-dismiss duration + 350 ms fade-out
    act(() => {
      vi.advanceTimersByTime(4000 + 400);
    });

    expect(screen.queryByText(/CSV exported successfully\./i)).toBeNull();
  });

  it("does NOT show the success banner when the export fails", async () => {
    mockFetchFailure();

    act(() => { renderPage(); });
    act(() => { navigateToSessionsTab(); });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /export csv/i }));
    });

    expect(screen.queryByText(/CSV exported successfully/i)).toBeNull();
    // The error banner should appear instead
    expect(screen.getByText(/export failed/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Scenario: failed export shows the error banner
// ---------------------------------------------------------------------------

describe("DashboardPage — CSV export error banner", () => {
  it("shows the 'Export failed. Please try again.' banner when the fetch fails", async () => {
    mockFetchFailure();

    act(() => { renderPage(); });
    act(() => { navigateToSessionsTab(); });

    // Banner should not be present before export
    expect(screen.queryByText(/export failed/i)).toBeNull();

    // Click "Export CSV"
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /export csv/i }));
    });

    // Error banner should now be visible
    const bannerText = screen.getByText(/Export failed\. Please try again\./i);
    expect(bannerText).toBeInTheDocument();
    // Confirm it is the red error banner, not the success banner
    const bannerContainer = bannerText.closest("div");
    expect(bannerContainer?.className).toMatch(/red/);
  });

  it("the error banner has a dismiss button that removes it when clicked", async () => {
    vi.useFakeTimers();
    mockFetchFailure();

    act(() => { renderPage(); });
    act(() => { navigateToSessionsTab(); });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /export csv/i }));
    });

    // Banner is present
    expect(screen.getByText(/Export failed\. Please try again\./i)).toBeInTheDocument();

    // Click the dismiss button
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    });

    // After the 350 ms fade-out transition the banner unmounts
    act(() => {
      vi.advanceTimersByTime(400);
    });

    expect(screen.queryByText(/Export failed\. Please try again\./i)).toBeNull();
  });

  it("the error banner auto-dismisses after 5 seconds", async () => {
    vi.useFakeTimers();
    mockFetchFailure();

    act(() => { renderPage(); });
    act(() => { navigateToSessionsTab(); });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /export csv/i }));
    });

    // Banner is visible
    expect(screen.getByText(/Export failed\. Please try again\./i)).toBeInTheDocument();

    // Advance past the 5 000 ms auto-dismiss duration + 350 ms fade-out
    act(() => {
      vi.advanceTimersByTime(5000 + 400);
    });

    expect(screen.queryByText(/Export failed\. Please try again\./i)).toBeNull();
  });
});
