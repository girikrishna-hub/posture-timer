import { useEffect, useRef, useCallback, useState } from "react";
import type { TimerMode } from "@/contexts/TimerContext";

const WALKING_MIN_SPEED = 0.5;
const WALKING_MAX_SPEED = 3.5;
const CONFIRM_DURATION_MS = 20_000;
const STOP_DURATION_MS = 30_000;

export type GpsStatus = "idle" | "monitoring" | "walking" | "unavailable";

interface UseWalkingDetectionOptions {
  enabled: boolean;
  currentMode: TimerMode;
  switchMode: (mode: "sitting" | "standing" | "resting" | "walking") => Promise<void>;
}

export function useWalkingDetection({
  enabled,
  currentMode,
  switchMode,
}: UseWalkingDetectionOptions): GpsStatus {
  const [gpsStatus, setGpsStatus] = useState<GpsStatus>("idle");

  const watchIdRef = useRef<number | null>(null);
  const walkingStartRef = useRef<number | null>(null);
  const belowThresholdSinceRef = useRef<number | null>(null);
  const currentModeRef = useRef(currentMode);
  const switchModeRef = useRef(switchMode);

  useEffect(() => { currentModeRef.current = currentMode; }, [currentMode]);
  useEffect(() => { switchModeRef.current = switchMode; }, [switchMode]);

  const handlePosition = useCallback((position: GeolocationPosition) => {
    const speed = position.coords.speed;

    if (speed === null) return;

    const now = Date.now();
    const mode = currentModeRef.current;
    const isWalking = speed >= WALKING_MIN_SPEED && speed <= WALKING_MAX_SPEED;

    if (isWalking) {
      belowThresholdSinceRef.current = null;

      if (mode !== "walking") {
        if (walkingStartRef.current === null) {
          walkingStartRef.current = now;
        } else if (now - walkingStartRef.current >= CONFIRM_DURATION_MS) {
          walkingStartRef.current = null;
          if (mode === "idle" || mode === "sitting") {
            setGpsStatus("walking");
            void switchModeRef.current("walking");
          }
        }
      }
    } else {
      walkingStartRef.current = null;

      if (mode === "walking") {
        if (belowThresholdSinceRef.current === null) {
          belowThresholdSinceRef.current = now;
        } else if (now - belowThresholdSinceRef.current >= STOP_DURATION_MS) {
          belowThresholdSinceRef.current = null;
          setGpsStatus("monitoring");
          void switchModeRef.current("sitting");
        }
      } else {
        setGpsStatus("monitoring");
      }
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      if (watchIdRef.current !== null) {
        navigator.geolocation.clearWatch(watchIdRef.current);
        watchIdRef.current = null;
      }
      setGpsStatus("idle");
      walkingStartRef.current = null;
      belowThresholdSinceRef.current = null;
      return;
    }

    if (!("geolocation" in navigator)) {
      setGpsStatus("unavailable");
      return;
    }

    setGpsStatus("monitoring");

    watchIdRef.current = navigator.geolocation.watchPosition(
      handlePosition,
      (err) => {
        if (err.code === GeolocationPositionError.PERMISSION_DENIED) {
          setGpsStatus("unavailable");
        }
      },
      {
        enableHighAccuracy: true,
        maximumAge: 5000,
        timeout: 15000,
      },
    );

    return () => {
      if (watchIdRef.current !== null) {
        navigator.geolocation.clearWatch(watchIdRef.current);
        watchIdRef.current = null;
      }
    };
  }, [enabled, handlePosition]);

  return gpsStatus;
}
