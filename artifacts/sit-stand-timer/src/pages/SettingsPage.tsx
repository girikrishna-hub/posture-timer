import { useState, useEffect } from "react";
import { useGetSettings, useUpdateSettings, getGetSettingsQueryKey } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { useQueryClient } from "@tanstack/react-query";

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
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="space-y-2 pb-6 border-b border-border last:border-0">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-foreground">{label}</p>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
        <span className="text-sm font-semibold tabular-nums text-foreground min-w-[3rem] text-right">
          {value}{unit}
        </span>
      </div>
      <Slider
        min={min}
        max={max}
        step={step}
        value={[value]}
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

  const [localSettings, setLocalSettings] = useState({
    dailyStandingGoalMinutes: 120,
    sittingAlertMinutes: 45,
    standingMinMinutes: 10,
    standingMaxMinutes: 15,
    reminderIntervalMinutes: 1,
    remindersCount: 3,
    autoDetectWalking: false,
  });

  const [saved, setSaved] = useState(false);
  const [notifPermission, setNotifPermission] = useState<NotificationPermission>(
    typeof Notification !== "undefined" ? Notification.permission : "default"
  );

  useEffect(() => {
    if (settings) {
      setLocalSettings({
        dailyStandingGoalMinutes: settings.dailyStandingGoalMinutes,
        sittingAlertMinutes: settings.sittingAlertMinutes,
        standingMinMinutes: settings.standingMinMinutes,
        standingMaxMinutes: settings.standingMaxMinutes,
        reminderIntervalMinutes: settings.reminderIntervalMinutes,
        remindersCount: settings.remindersCount,
        autoDetectWalking: settings.autoDetectWalking,
      });
    }
  }, [settings]);

  const handleSave = async () => {
    await updateMutation.mutateAsync({ data: localSettings });
    await queryClient.invalidateQueries({ queryKey: getGetSettingsQueryKey() });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const requestNotifications = async () => {
    if (typeof Notification !== "undefined") {
      const permission = await Notification.requestPermission();
      setNotifPermission(permission);
    }
  };

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

      <div className="px-6 pb-8 space-y-0">
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
            <div>
              <p className="text-sm font-medium text-foreground">Auto-detect walking</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Uses GPS speed to automatically log walking sessions (0.5–3.5 m/s). No location is stored — only speed is read.
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={localSettings.autoDetectWalking}
              onClick={() =>
                setLocalSettings((s) => ({ ...s, autoDetectWalking: !s.autoDetectWalking }))
              }
              className={`relative shrink-0 mt-0.5 inline-flex h-6 w-11 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
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
        </div>

        <Button
          className="w-full h-12 rounded-2xl text-base font-semibold"
          onClick={handleSave}
          disabled={updateMutation.isPending}
        >
          {saved ? "Saved" : updateMutation.isPending ? "Saving..." : "Save Settings"}
        </Button>
      </div>
    </div>
  );
}
