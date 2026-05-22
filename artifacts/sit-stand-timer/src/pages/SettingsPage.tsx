import { useState, useEffect, useCallback, useRef } from "react";
import { useBanner } from "@/hooks/useBanner";
import { useTimer } from "@/contexts/TimerContext";
import {
  useGetSettings,
  useUpdateSettings,
  getGetSettingsQueryKey,
  useGetFitbitStatus,
  getGetFitbitStatusQueryKey,
  getFitbitAuthUrl,
  disconnectFitbit,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { useQueryClient } from "@tanstack/react-query";
import { isSoundEnabled, setSoundEnabled } from "@/utils/audio";
import {
  isNativePlatform,
  canScheduleExactAlarms,
  openExactAlarmSettings,
  canUseFullScreenIntent,
  openFullScreenIntentSettings,
  isIgnoringBatteryOptimizations,
  requestIgnoreBatteryOptimizations,
} from "@/utils/nativeNotifications";
import { Capacitor } from "@capacitor/core";
import { AlarmManager, type AlarmDiagnostics } from "@/plugins/alarmManager";

// ── Temporary runtime diagnostics ─────────────────────────────────────────
// The amber permission card was never appearing on a device where Android
// also was NOT listing the app under "Alarms & reminders". That combination
// means either (a) Capacitor.isNativePlatform() is returning false, or
// (b) canScheduleExactAlarms() is incorrectly returning true. The panel
// below shows the raw values so we can tell which one is happening.
// REMOVE this entire block once the permission flow is confirmed working.
type AlarmDiag = {
  isNative: boolean;
  platform: string;
  pluginAvailable: boolean;
  canScheduleRaw: unknown;
  canScheduleError: string | null;
  checkedAt: string;
};

type GeoPermissionStatus = "unknown" | "prompt" | "requesting" | "granted" | "denied" | "unsupported";

function SettingRow({
  label,
  description,
  value,
  min,
  max,
  step,
  unit,
  onChange,
}: {
  label: string;
  description: string;
  value: number | undefined;
  min: number;
  max: number;
  step: number;
  unit: string;
  onChange: (v: number) => void;
}) {
  // Defensive: if upstream state momentarily holds undefined (e.g. server
  // returned a partial settings payload), fall back to `min` so the slider
  // is still usable instead of crashing or rendering as a blank value.
  const safeValue =
    typeof value === "number" && Number.isFinite(value) ? value : min;
  return (
    <div className="space-y-2 pb-6 border-b border-border last:border-0">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-foreground">{label}</p>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
        <span className="text-sm font-semibold tabular-nums text-foreground min-w-[3rem] text-right">
          {safeValue}{unit}
        </span>
      </div>
      <Slider
        min={min}
        max={max}
        step={step}
        value={[safeValue]}
        onValueChange={([v]) => onChange(v)}
        className="w-full"
      />
    </div>
  );
}

export default function SettingsPage() {
  const queryClient = useQueryClient();
  const { data: settings } = useGetSettings({
    query: { queryKey: getGetSettingsQueryKey() },
  });
  const updateMutation = useUpdateSettings();

  const { data: fitbitStatus, refetch: refetchFitbitStatus } = useGetFitbitStatus({
    query: { queryKey: getGetFitbitStatusQueryKey(), refetchInterval: 10_000 },
  });
  const fitbitConnected = fitbitStatus?.connected === true;

  const [localSettings, setLocalSettings] = useState({
    dailyStandingGoalMinutes: 120,
    sittingAlertMinutes: 45,
    standingMinMinutes: 10,
    standingMaxMinutes: 15,
    reminderIntervalMinutes: 1,
    remindersCount: 3,
    autoDetectWalking: false,
  });

  const [soundOn, setSoundOn] = useState(isSoundEnabled);
  const savedBanner = useBanner(3000);
  const [fitbitAssistedEnabled, setFitbitAssistedEnabled] = useState(() => {
    try { return localStorage.getItem("fitbitAssisted") === "true"; } catch { return false; }
  });
  const [fitbitConnecting, setFitbitConnecting] = useState(false);
  const [fitbitDisconnecting, setFitbitDisconnecting] = useState(false);
  const goalBanner = useBanner(5000);
  const { notificationPermission: notifPermission, requestNotificationPermission } = useTimer();
  const [geoPermission, setGeoPermission] = useState<GeoPermissionStatus>(
    "geolocation" in navigator ? "unknown" : "unsupported"
  );

  // ── Exact-alarm permission (Android 12+ only) ───────────────────────────
  const [exactAlarmGranted, setExactAlarmGranted] = useState<boolean | null>(null);
  // ── Full-screen intent permission (Android 14+ only) ────────────────────
  const [fullScreenGranted, setFullScreenGranted] = useState<boolean | null>(null);
  // ── Battery optimisation exemption ──────────────────────────────────────
  const [batteryOptExempt, setBatteryOptExempt] = useState<boolean | null>(null);

  // ── TEMP DIAG: native alarm runtime diagnostics ────────────────────────
  // Pulled from AlarmManagerPlugin.getDiagnostics() — shows whether
  // scheduleAlarm() actually reached the OS and whether the AlarmReceiver
  // ever fired. Refreshed on mount, every 3s, and whenever the tab regains
  // visibility. Remove once notification delivery is confirmed working.
  const [alarmRuntime, setAlarmRuntime] = useState<AlarmDiagnostics | null>(null);
  const [alarmRuntimeError, setAlarmRuntimeError] = useState<string | null>(null);
  const [testAlarmStatus, setTestAlarmStatus] = useState<string>("");

  const refreshAlarmRuntime = useCallback(async () => {
    if (!Capacitor.isNativePlatform()) {
      setAlarmRuntime(null);
      setAlarmRuntimeError("not on native platform");
      return;
    }
    try {
      const d = await AlarmManager.getDiagnostics();
      setAlarmRuntime(d);
      setAlarmRuntimeError(null);
    } catch (e) {
      setAlarmRuntimeError(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    }
  }, []);

  useEffect(() => {
    void refreshAlarmRuntime();
    const t = window.setInterval(() => { void refreshAlarmRuntime(); }, 3000);
    const onVis = () => void refreshAlarmRuntime();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.clearInterval(t);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [refreshAlarmRuntime]);

  const fireTestAlarm = useCallback(async () => {
    setTestAlarmStatus("scheduling…");
    try {
      const res = await AlarmManager.scheduleAlarm({
        id: 9999,
        title: "TEST alarm",
        body: "If you see this, AlarmReceiver fired & notification posted.",
        delayMs: 10_000,
      });
      const r = res as { triggerAt?: number; usedExact?: boolean; error?: string } | void;
      const trig = r?.triggerAt ? new Date(r.triggerAt).toLocaleTimeString() : "?";
      setTestAlarmStatus(
        `scheduled id=9999 trigger=${trig} exact=${String(r?.usedExact ?? "?")} ` +
        `err=${r?.error || "none"} — wait 10s, watch for notification`,
      );
      void refreshAlarmRuntime();
    } catch (e) {
      setTestAlarmStatus(
        `scheduleAlarm THREW: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }, [refreshAlarmRuntime]);

  // ── Permission/plugin-availability diagnostics (existing) ──────────────
  const [alarmDiag, setAlarmDiag] = useState<AlarmDiag>({
    isNative: false,
    platform: "unknown",
    pluginAvailable: false,
    canScheduleRaw: "(not yet checked)",
    canScheduleError: null,
    checkedAt: "",
  });

  useEffect(() => {
    const runDiag = async () => {
      const isNative = Capacitor.isNativePlatform();
      const platform = Capacitor.getPlatform();
      const pluginAvailable = Capacitor.isPluginAvailable("AlarmManager");
      let canScheduleRaw: unknown = "(skipped — not native)";
      let canScheduleError: string | null = null;
      if (isNative) {
        try {
          canScheduleRaw = await AlarmManager.canScheduleExactAlarms();
          const v = (canScheduleRaw as { value?: boolean })?.value;
          if (typeof v === "boolean") setExactAlarmGranted(v);
        } catch (e) {
          canScheduleError = e instanceof Error
            ? `${e.name}: ${e.message}`
            : String(e);
        }
        // Full-screen intent (Android 14+) and battery optimisation
        try {
          const fsi = await AlarmManager.canUseFullScreenIntent();
          setFullScreenGranted(fsi.value);
        } catch { setFullScreenGranted(true); }
        try {
          const batt = await AlarmManager.isIgnoringBatteryOptimizations();
          setBatteryOptExempt(batt.value);
        } catch { setBatteryOptExempt(true); }
      } else {
        setExactAlarmGranted(true);
        setFullScreenGranted(true);
        setBatteryOptExempt(true);
      }
      setAlarmDiag({
        isNative,
        platform,
        pluginAvailable,
        canScheduleRaw,
        canScheduleError,
        checkedAt: new Date().toLocaleTimeString(),
      });
    };
    const onVis = () => void runDiag();
    void runDiag();
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  // Hydrate localSettings from server ONCE on first arrival. Re-syncing on
  // every settings change would silently revert slider drags whenever an
  // unrelated query invalidation triggers a /settings refetch while the
  // user is mid-edit — that's how a user's standing_min=5 drag can snap
  // back to 10 before they click Save, causing the save to submit stale
  // values.
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (settings && !hydratedRef.current) {
      hydratedRef.current = true;
      // Use `?? prev` for every field so a partial server payload (e.g. a
      // field added after the user's row was inserted with NULL) does not
      // wipe out the in-memory defaults and leave the sliders unusable.
      setLocalSettings((prev) => ({
        dailyStandingGoalMinutes:
          settings.dailyStandingGoalMinutes ?? prev.dailyStandingGoalMinutes,
        sittingAlertMinutes:
          settings.sittingAlertMinutes ?? prev.sittingAlertMinutes,
        standingMinMinutes:
          settings.standingMinMinutes ?? prev.standingMinMinutes,
        standingMaxMinutes:
          settings.standingMaxMinutes ?? prev.standingMaxMinutes,
        reminderIntervalMinutes:
          settings.reminderIntervalMinutes ?? prev.reminderIntervalMinutes,
        remindersCount: settings.remindersCount ?? prev.remindersCount,
        autoDetectWalking:
          settings.autoDetectWalking ?? prev.autoDetectWalking,
      }));
    }
  }, [settings]);

  const handleSave = async () => {
    const goalChanged =
      localSettings.dailyStandingGoalMinutes !== settings?.dailyStandingGoalMinutes;

    await updateMutation.mutateAsync({ data: localSettings });

    // Write the reset before invalidation so TimerContext reads fresh state on refetch.
    if (goalChanged) {
      try {
        const d = new Date();
        const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        localStorage.setItem(
          "sit-stand-goal-notif",
          JSON.stringify({ date: today, half: false, full: false })
        );
      } catch { /* ignore */ }

      goalBanner.show();
    }

    await queryClient.invalidateQueries({ queryKey: getGetSettingsQueryKey() });

    savedBanner.show();
  };

  const requestNotifications = requestNotificationPermission;

  const checkGeoPermission = useCallback(async () => {
    if (!("geolocation" in navigator)) {
      setGeoPermission("unsupported");
      return;
    }
    try {
      const result = await navigator.permissions.query({ name: "geolocation" });
      setGeoPermission(result.state as GeoPermissionStatus);
      result.addEventListener("change", () => {
        setGeoPermission(result.state as GeoPermissionStatus);
      });
    } catch {
      setGeoPermission("unknown");
    }
  }, []);

  useEffect(() => {
    void checkGeoPermission();
  }, [checkGeoPermission]);

  const handleToggleWalking = useCallback(async () => {
    const next = !localSettings.autoDetectWalking;
    const updated = { ...localSettings, autoDetectWalking: next };
    setLocalSettings(updated);

    try {
      localStorage.setItem("autoDetectWalking", String(next));
    } catch { /* ignore */ }

    try {
      await updateMutation.mutateAsync({ data: updated });
      await queryClient.invalidateQueries({ queryKey: getGetSettingsQueryKey() });
    } catch {
      // save will be retried via main Save button
    }

    if (next && geoPermission !== "granted") {
      setGeoPermission("requesting");
      navigator.geolocation.getCurrentPosition(
        () => setGeoPermission("granted"),
        (err) => {
          if (err.code === GeolocationPositionError.PERMISSION_DENIED) {
            setGeoPermission("denied");
          } else {
            // timeout or unavailable — permission may still be prompt/unknown
            setGeoPermission("prompt");
          }
        },
        { timeout: 10000 },
      );
    }
  }, [localSettings, geoPermission, updateMutation, queryClient]);

  const handleToggleFitbitAssisted = useCallback(() => {
    setFitbitAssistedEnabled((prev) => {
      const next = !prev;
      try { localStorage.setItem("fitbitAssisted", String(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  const handleConnectFitbit = useCallback(async () => {
    setFitbitConnecting(true);
    try {
      const { url } = await getFitbitAuthUrl();
      window.open(url, "_blank", "noopener,noreferrer,width=600,height=700");
      const poll = setInterval(() => {
        void refetchFitbitStatus().then(({ data }) => {
          if (data?.connected) {
            clearInterval(poll);
            setFitbitConnecting(false);
          }
        });
      }, 3000);
      setTimeout(() => { clearInterval(poll); setFitbitConnecting(false); }, 5 * 60 * 1000);
    } catch {
      setFitbitConnecting(false);
    }
  }, [refetchFitbitStatus]);

  const handleDisconnectFitbit = useCallback(async () => {
    setFitbitDisconnecting(true);
    try {
      await disconnectFitbit();
      await queryClient.invalidateQueries({ queryKey: getGetFitbitStatusQueryKey() });
    } finally {
      setFitbitDisconnecting(false);
    }
  }, [queryClient]);

  const handleToggleSound = useCallback(() => {
    setSoundOn((prev) => {
      const next = !prev;
      setSoundEnabled(next);
      return next;
    });
  }, []);

  const [silentReminders, setSilentReminders] = useState(() => {
    try { return localStorage.getItem("silentReminders") === "true"; } catch { return false; }
  });
  const handleToggleSilentReminders = useCallback(() => {
    setSilentReminders((prev) => {
      const next = !prev;
      try { localStorage.setItem("silentReminders", String(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  const [queueCleared, setQueueCleared] = useState(false);
  const handleClearQueue = useCallback(() => {
    try { localStorage.removeItem("sit-stand-offline-queue"); } catch { /* ignore */ }
    setQueueCleared(true);
    setTimeout(() => setQueueCleared(false), 3000);
  }, []);

  return (
    <div className="min-h-screen bg-background">
      <header className="flex items-center gap-3 px-6 pt-6 pb-4">
        <button
          onClick={() => window.location.href = "/"}
          className="text-muted-foreground hover:text-foreground transition-colors p-2 rounded-lg hover:bg-muted -ml-2"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m15 18-6-6 6-6"/>
          </svg>
        </button>
        <div>
          <h1 className="text-xl font-semibold text-foreground">Settings</h1>
          <p className="text-xs text-muted-foreground">Customize your timer</p>
        </div>
      </header>

      {/* ── TEMP runtime diagnostics — remove once permission flow confirmed ── */}
      <div className="mx-6 mb-4 rounded-2xl border-2 border-fuchsia-400 bg-fuchsia-50 px-4 py-3 font-mono text-[11px] leading-relaxed text-fuchsia-900">
        <div className="mb-1 text-xs font-bold uppercase tracking-wide">
          🔍 Alarm permission diagnostics
        </div>
        <div>Capacitor.isNativePlatform(): <b>{String(alarmDiag.isNative)}</b></div>
        <div>Capacitor.getPlatform(): <b>{alarmDiag.platform}</b></div>
        <div>isPluginAvailable("AlarmManager"): <b>{String(alarmDiag.pluginAvailable)}</b></div>
        <div>
          canScheduleExactAlarms() raw:{" "}
          <b className="break-all">{JSON.stringify(alarmDiag.canScheduleRaw)}</b>
        </div>
        <div>
          plugin call error:{" "}
          <b className="break-all">{alarmDiag.canScheduleError ?? "(none)"}</b>
        </div>
        <div>
          exactAlarmGranted state:{" "}
          <b>{exactAlarmGranted === null ? "null" : String(exactAlarmGranted)}</b>
        </div>
        <div>amber card visible: <b>{String(isNativePlatform() && exactAlarmGranted === false)}</b></div>
        <div className="mt-1 text-fuchsia-600">checked at {alarmDiag.checkedAt || "(pending)"}</div>
        <button
          type="button"
          onClick={() => document.dispatchEvent(new Event("visibilitychange"))}
          className="mt-2 rounded bg-fuchsia-600 px-2 py-1 text-[11px] font-semibold text-white hover:bg-fuchsia-700"
        >
          Re-run check
        </button>
      </div>

      {/* ── TEMP DIAG: alarm runtime panel — remove once delivery confirmed ── */}
      <div className="mx-6 mb-4 rounded-2xl border-2 border-cyan-500 bg-cyan-50 px-4 py-3 font-mono text-[11px] leading-relaxed text-cyan-900">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-xs font-bold uppercase tracking-wide">
            🔔 Alarm runtime (native)
          </span>
          <button
            type="button"
            onClick={() => void refreshAlarmRuntime()}
            className="rounded bg-cyan-600 px-2 py-0.5 text-[10px] font-semibold text-white hover:bg-cyan-700"
          >
            refresh
          </button>
        </div>
        {alarmRuntimeError && (
          <div className="text-red-700">getDiagnostics error: <b>{alarmRuntimeError}</b></div>
        )}
        {alarmRuntime && (() => {
          const now = alarmRuntime.now || Date.now();
          const fmt = (ts: number) =>
            !ts ? "(never)" : `${new Date(ts).toLocaleTimeString()} (${Math.round((now - ts) / 1000)}s ago)`;
          const fmtFuture = (ts: number) => {
            if (!ts) return "(none)";
            const diff = ts - now;
            return `${new Date(ts).toLocaleTimeString()} (in ${Math.round(diff / 1000)}s)`;
          };
          return (
            <>
              <div className="mt-1 font-semibold">scheduling</div>
              <div>schedule count: <b>{alarmRuntime.scheduleCount}</b></div>
              <div>last scheduled id: <b>{alarmRuntime.lastScheduledId}</b> ({alarmRuntime.lastScheduledTitle || "—"})</div>
              <div>last scheduled at: <b>{fmt(alarmRuntime.lastScheduledAt)}</b></div>
              <div>fires at: <b>{fmtFuture(alarmRuntime.lastScheduledTriggerAt)}</b></div>
              <div>used exact: <b>{String(alarmRuntime.lastScheduledUsedExact)}</b> · canExact: <b>{String(alarmRuntime.canScheduleExactAlarms)}</b></div>
              <div>last sched error: <b className="break-all">{alarmRuntime.lastScheduledError || "(none)"}</b></div>
              <div>nextAlarmClock: <b>{fmtFuture(alarmRuntime.nextAlarmClockTriggerAt)}</b> <span className="text-cyan-700">(only shows alarms set as wakeup-clock; informational)</span></div>

              <div className="mt-2 font-semibold">cancellation</div>
              <div>cancel count: <b>{alarmRuntime.cancelCount}</b> · last cancel id: <b>{alarmRuntime.lastCancelId}</b> · at: <b>{fmt(alarmRuntime.lastCancelAt)}</b></div>

              <div className="mt-2 font-semibold">receiver / notification</div>
              <div>receiver fire count: <b>{alarmRuntime.receiverFireCount}</b></div>
              <div>last fire id: <b>{alarmRuntime.lastReceiverFireId}</b> ({alarmRuntime.lastReceiverFireTitle || "—"})</div>
              <div>last fire at: <b>{fmt(alarmRuntime.lastReceiverFireAt)}</b></div>
              <div>notify OK count: <b>{alarmRuntime.notifyCount}</b> · notify FAIL count: <b>{alarmRuntime.notifyFailCount}</b></div>
              <div>last notify error: <b className="break-all">{alarmRuntime.lastNotifyError || "(none)"}</b></div>
            </>
          );
        })()}
        <button
          type="button"
          onClick={() => void fireTestAlarm()}
          className="mt-3 rounded bg-cyan-700 px-3 py-1 text-[11px] font-semibold text-white hover:bg-cyan-800"
        >
          🚨 Fire test alarm in 10s
        </button>
        {testAlarmStatus && (
          <div className="mt-1 break-all text-cyan-800">{testAlarmStatus}</div>
        )}
        <div className="mt-2 text-cyan-700">
          Interpret:
          <ul className="ml-4 list-disc">
            <li>schedule count rising but receiver fire count flat → AlarmManager is dropping alarms (Doze / OEM battery saver / inexact fallback).</li>
            <li>receiver fires but notify FAIL → notification permission revoked or channel issue.</li>
            <li>both counts rising but you hear/see nothing → channel importance, DND, or full-screen-intent restriction.</li>
          </ul>
        </div>
      </div>

      {goalBanner.shown && (
        <div
          role="status"
          aria-live="polite"
          className={[
            "mx-6 mb-2 flex items-start gap-3 rounded-2xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 px-4 py-3",
            "transition-all duration-300 ease-out",
            goalBanner.visible
              ? "opacity-100 translate-y-0"
              : "opacity-0 -translate-y-2",
          ].join(" ")}
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 mt-0.5 text-emerald-600 dark:text-emerald-400">
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
            <polyline points="22 4 12 14.01 9 11.01"/>
          </svg>
          <div className="flex-1">
            <p className="text-sm font-semibold text-emerald-800 dark:text-emerald-200">Goal updated</p>
            <p className="text-xs text-emerald-700 dark:text-emerald-300">Milestone alerts have been reset for today.</p>
          </div>
          <button
            type="button"
            onClick={() => goalBanner.dismiss()}
            aria-label="Dismiss"
            className="shrink-0 ml-1 -mr-1 p-1 rounded-full text-emerald-600 dark:text-emerald-400 hover:bg-emerald-100 dark:hover:bg-emerald-900/50 transition-colors"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"/>
              <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
      )}

      <div className="px-6 pb-24 space-y-0">
        <div className="bg-card border border-border rounded-2xl p-5 space-y-6 mb-4">
          <SettingRow
            label="Daily standing goal"
            description="Minutes of standing you aim for each day"
            value={localSettings.dailyStandingGoalMinutes}
            min={30}
            max={480}
            step={15}
            unit="m"
            onChange={(v) => setLocalSettings((s) => ({ ...s, dailyStandingGoalMinutes: v }))}
          />
          <SettingRow
            label="Sitting alert"
            description="How long to sit before you get a reminder"
            value={localSettings.sittingAlertMinutes}
            min={15}
            max={120}
            step={5}
            unit="m"
            onChange={(v) => setLocalSettings((s) => ({ ...s, sittingAlertMinutes: v }))}
          />
          <SettingRow
            label="Minimum standing time"
            description="When reminders to sit start"
            value={localSettings.standingMinMinutes}
            min={5}
            max={60}
            step={5}
            unit="m"
            onChange={(v) => setLocalSettings((s) => ({ ...s, standingMinMinutes: v }))}
          />
          <SettingRow
            label="Maximum standing time"
            description="Final reminder fires at this point"
            value={localSettings.standingMaxMinutes}
            min={10}
            max={90}
            step={5}
            unit="m"
            onChange={(v) => setLocalSettings((s) => ({ ...s, standingMaxMinutes: v }))}
          />
          <SettingRow
            label="Reminder interval"
            description="Time between consecutive reminders"
            value={localSettings.reminderIntervalMinutes}
            min={1}
            max={5}
            step={1}
            unit="m"
            onChange={(v) => setLocalSettings((s) => ({ ...s, reminderIntervalMinutes: v }))}
          />
          <SettingRow
            label="Reminder count"
            description="How many reminders before you get nudged to switch"
            value={localSettings.remindersCount}
            min={1}
            max={5}
            step={1}
            unit=""
            onChange={(v) => setLocalSettings((s) => ({ ...s, remindersCount: v }))}
          />
        </div>

        <div className="bg-card border border-border rounded-2xl p-5 mb-4 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-foreground">Notifications</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {notifPermission === "granted"
                  ? "Notifications are enabled"
                  : notifPermission === "denied"
                  ? "Notifications are blocked — change in browser settings"
                  : "Enable to get reminders when tab is in background"}
              </p>
            </div>
            {notifPermission !== "granted" && notifPermission !== "denied" && (
              <Button size="sm" variant="outline" onClick={requestNotifications}>
                Enable
              </Button>
            )}
            {notifPermission === "granted" && (
              <span className="text-xs text-emerald-600 dark:text-emerald-400 font-medium">On</span>
            )}
            {notifPermission === "denied" && (
              <span className="text-xs text-destructive font-medium">Blocked</span>
            )}
          </div>

          <div className="border-t border-border pt-4 flex items-start justify-between gap-4">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-foreground">Auto-detect walking</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Uses GPS speed to automatically log walking sessions. No location is stored — only speed is read.
              </p>
              {geoPermission === "unsupported" && (
                <p className="text-xs text-muted-foreground mt-1 italic">GPS not available on this device</p>
              )}
              {(geoPermission === "prompt" || geoPermission === "unknown") && localSettings.autoDetectWalking && (
                <p className="text-xs text-muted-foreground mt-1">Location permission not yet granted — will be asked when monitoring starts</p>
              )}
              {geoPermission === "requesting" && (
                <p className="text-xs text-teal-600 dark:text-teal-400 mt-1">Requesting location permission…</p>
              )}
              {geoPermission === "granted" && localSettings.autoDetectWalking && (
                <p className="text-xs text-emerald-600 dark:text-emerald-400 mt-1">Location permission granted</p>
              )}
              {geoPermission === "denied" && (
                <p className="text-xs text-destructive mt-1">
                  Location blocked — enable in your{" "}
                  <a
                    href="#"
                    className="underline"
                    onClick={(e) => {
                      e.preventDefault();
                      alert("To enable location: open your browser settings → Site permissions → Location → allow this site.");
                    }}
                  >
                    browser settings
                  </a>
                </p>
              )}
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={localSettings.autoDetectWalking}
              disabled={geoPermission === "unsupported"}
              onClick={() => void handleToggleWalking()}
              className={`relative shrink-0 mt-0.5 inline-flex h-6 w-11 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40 ${
                localSettings.autoDetectWalking ? "bg-teal-500" : "bg-muted-foreground/30"
              }`}
            >
              <span
                className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${
                  localSettings.autoDetectWalking ? "translate-x-6" : "translate-x-1"
                }`}
              />
            </button>
          </div>

          <div className="border-t border-border pt-4 flex items-start justify-between gap-4">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-foreground">Sound effects</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Play tones when switching positions, and the celebration fanfare when you hit your daily goal
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={soundOn}
              onClick={handleToggleSound}
              className={`relative shrink-0 mt-0.5 inline-flex h-6 w-11 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                soundOn ? "bg-teal-500" : "bg-muted-foreground/30"
              }`}
            >
              <span
                className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${
                  soundOn ? "translate-x-6" : "translate-x-1"
                }`}
              />
            </button>
          </div>

          <div className="border-t border-border pt-4 flex items-start justify-between gap-4">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-foreground">Silent reminders</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Vibrate only — no sound. Use this in public places or meetings. Notifications still pop up.
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={silentReminders}
              onClick={handleToggleSilentReminders}
              className={`relative shrink-0 mt-0.5 inline-flex h-6 w-11 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                silentReminders ? "bg-orange-500" : "bg-muted-foreground/30"
              }`}
            >
              <span
                className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${
                  silentReminders ? "translate-x-6" : "translate-x-1"
                }`}
              />
            </button>
          </div>
        </div>

        {/* Android exact-alarm permission card — only shown on native when not yet granted */}
        {isNativePlatform() && exactAlarmGranted === false && (
          <div className="bg-amber-50 border border-amber-200 rounded-2xl p-5 mb-4">
            <div className="flex items-start gap-3">
              <span className="text-2xl mt-0.5">⏰</span>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-amber-900">Alarm permission required</p>
                <p className="text-xs text-amber-700 mt-1">
                  Android needs the <strong>Alarms &amp; reminders</strong> permission to fire
                  posture and bladder notifications while the app is closed or the screen is locked.
                  Without it, alarms arrive late or not at all.
                </p>
                <Button
                  size="sm"
                  className="mt-3 bg-amber-500 hover:bg-amber-600 text-white border-0"
                  onClick={() => void openExactAlarmSettings()}
                >
                  Grant permission →
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* ── Full-screen intent permission (Android 14+) ── */}
        {isNativePlatform() && fullScreenGranted === false && (
          <div className="bg-amber-50 border border-amber-200 rounded-2xl p-5 mb-4">
            <div className="flex items-start gap-3">
              <span className="text-2xl mt-0.5">🔔</span>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-amber-900">Full-screen alarm permission required</p>
                <p className="text-xs text-amber-700 mt-1">
                  Android 14 requires the <strong>Allow full-screen notifications</strong> permission
                  so alarms can wake the screen and appear over the lock screen. Without it you will
                  see only a banner when the phone is unlocked, and nothing when it is locked.
                </p>
                <Button
                  size="sm"
                  className="mt-3 bg-amber-500 hover:bg-amber-600 text-white border-0"
                  onClick={() => void openFullScreenIntentSettings()}
                >
                  Grant permission →
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* ── Battery optimisation exemption ── */}
        {isNativePlatform() && batteryOptExempt === false && (
          <div className="bg-orange-50 border border-orange-200 rounded-2xl p-5 mb-4">
            <div className="flex items-start gap-3">
              <span className="text-2xl mt-0.5">🔋</span>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-orange-900">Battery optimisation is on</p>
                <p className="text-xs text-orange-700 mt-1">
                  Samsung's Adaptive Battery may delay or skip alarms when the app is backgrounded.
                  Tap below to exempt the app so alarms fire on time even with the screen off.
                </p>
                <Button
                  size="sm"
                  className="mt-3 bg-orange-500 hover:bg-orange-600 text-white border-0"
                  onClick={() => void requestIgnoreBatteryOptimizations()}
                >
                  Disable battery optimisation →
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* Google Fit Assisted Mode card */}
        <div className="bg-card border border-border rounded-2xl p-5 mb-4 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1">
              <p className="text-sm font-medium text-foreground">Google Fit Assisted Mode</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Uses your Google Fit step data to nudge you when it detects drift from your current mode.
                Manual switches always take priority.
              </p>
            </div>
            <button
              role="switch"
              aria-checked={fitbitAssistedEnabled}
              onClick={handleToggleFitbitAssisted}
              className={`relative shrink-0 mt-0.5 inline-flex h-6 w-11 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                fitbitAssistedEnabled ? "bg-teal-500" : "bg-muted-foreground/30"
              }`}
            >
              <span
                className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${
                  fitbitAssistedEnabled ? "translate-x-6" : "translate-x-1"
                }`}
              />
            </button>
          </div>

          {fitbitAssistedEnabled && (
            <div className="pt-2 border-t border-border space-y-3">
              {fitbitConnected ? (
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                    <div>
                      <p className="text-sm font-medium text-foreground">Google Fit connected</p>
                      <p className="text-xs text-muted-foreground">
                        {fitbitStatus?.connectedAt
                          ? `Since ${new Date(fitbitStatus.connectedAt).toLocaleDateString()}`
                          : "Active"}
                      </p>
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void handleDisconnectFitbit()}
                    disabled={fitbitDisconnecting}
                    className="text-destructive border-destructive/30 hover:bg-destructive/10"
                  >
                    {fitbitDisconnecting ? "Removing…" : "Disconnect"}
                  </Button>
                </div>
              ) : (
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">
                    Connect your Google Fit account to enable step-based drift detection.
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void handleConnectFitbit()}
                    disabled={fitbitConnecting}
                    className="w-full"
                  >
                    {fitbitConnecting ? "Waiting for Google…" : "Connect Google Fit"}
                  </Button>
                </div>
              )}

              <div className="rounded-xl bg-muted/50 p-3 text-xs text-muted-foreground space-y-1">
                <p className="font-medium text-foreground">How it works</p>
                <p>• No movement for 8 min while standing → nudge to sit</p>
                <p>• Activity for 3 min while sitting → nudge to stand</p>
                <p>• Walking pace detected → auto-switches to walking</p>
                <p>• Your manual switches are always respected (lock window)</p>
              </div>
            </div>
          )}
        </div>

        {/* Troubleshooting */}
        <div className="bg-card border border-border rounded-2xl p-5 mb-4">
          <p className="text-sm font-medium text-foreground mb-1">Troubleshooting</p>
          <p className="text-xs text-muted-foreground mb-4">
            If duplicate sessions keep appearing, clearing the offline sync queue stops any pending retries immediately.
          </p>
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={handleClearQueue}
          >
            {queueCleared ? "Sync queue cleared ✓" : "Clear offline sync queue"}
          </Button>
        </div>

        {savedBanner.shown && (
          <div
            role="status"
            aria-live="polite"
            className={[
              "mx-0 mb-2 flex items-center gap-3 rounded-2xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 px-4 py-3",
              "transition-all duration-300 ease-out",
              savedBanner.visible
                ? "opacity-100 translate-y-0"
                : "opacity-0 -translate-y-2",
            ].join(" ")}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-emerald-600 dark:text-emerald-400">
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
              <polyline points="22 4 12 14.01 9 11.01"/>
            </svg>
            <p className="flex-1 text-sm font-semibold text-emerald-800 dark:text-emerald-200">Settings saved!</p>
            <button
              type="button"
              onClick={() => savedBanner.dismiss()}
              aria-label="Dismiss"
              className="shrink-0 ml-1 -mr-1 p-1 rounded-full text-emerald-600 dark:text-emerald-400 hover:bg-emerald-100 dark:hover:bg-emerald-900/50 transition-colors"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"/>
                <line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
        )}

        <Button
          className="w-full h-12 rounded-2xl text-base font-semibold"
          onClick={handleSave}
          disabled={updateMutation.isPending}
        >
          {updateMutation.isPending ? "Saving..." : "Save Settings"}
        </Button>
      </div>
    </div>
  );
}
