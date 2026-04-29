import { useEffect, useRef, useCallback, useState } from "react";
import type { TimerMode } from "@/contexts/TimerContext";

const WALKING_MIN_SPEED = 0.3;
const WALKING_MAX_SPEED = 3.5;
const CONFIRM_DURATION_MS = 15_000;
const STOP_DURATION_MS = 15_000;

export type GpsStatus = "idle" | "requesting" | "active" | "denied" | "unsupported";

interface UseWalkingDetectionOptions {
  enabled: boolean;
  currentMode: TimerMode;
  switchMode: (mode: "sitting" | "standing" | "resting" | "walking") => Promise<void>;
  endCurrentSession: () => Promise<void>;
}

function deriveSpeed(
  prevPos: GeolocationPosition,
  currPos: GeolocationPosition,
): number | null {
  const dt = (currPos.timestamp - prevPos.timestamp) / 1000;
  if (dt <= 0) return null;

  const R = 6371000;
  const lat1 = (prevPos.coords.latitude * Math.PI) / 180;
  const lat2 = (currPos.coords.latitude * Math.PI) / 180;
  const dLat = lat2 - lat1;
  const dLon =
    ((currPos.coords.longitude - prevPos.coords.longitude) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  const distance = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return distance / dt;
}

export function useWalkingDetection({
  enabled,
  currentMode,
  switchMode,
  endCurrentSession,
}: UseWalkingDetectionOptions): GpsStatus {
  const [gpsStatus, setGpsStatus] = useState<GpsStatus>("idle");

  const watchIdRef = useRef<number | null>(null);
  const walkingStartRef = useRef<number | null>(null);
  const belowThresholdSinceRef = useRef<number | null>(null);
  const prevPositionRef = useRef<GeolocationPosition | null>(null);
  const currentModeRef = useRef(currentMode);
  const switchModeRef = useRef(switchMode);
  const endCurrentSessionRef = useRef(endCurrentSession);

  useEffect(() => { currentModeRef.current = currentMode; }, [currentMode]);
  useEffect(() => { switchModeRef.current = switchMode; }, [switchMode]);
  useEffect(() => { endCurrentSessionRef.current = endCurrentSession; }, [endCurrentSession]);

  const handlePosition = useCallback((position: GeolocationPosition) => {
    let speed = position.coords.speed;

    if (speed === null && prevPositionRef.current !== null) {
      speed = deriveSpeed(prevPositionRef.current, position);
    }
    prevPositionRef.current = position;

    if (speed === null) return;

    const now = Date.now();
    const mode = currentModeRef.current;
    const inWalkingRange = speed >= WALKING_MIN_SPEED && speed <= WALKING_MAX_SPEED;
    const belowMin = speed < WALKING_MIN_SPEED;

    if (inWalkingRange) {
      belowThresholdSinceRef.current = null;

      if (mode !== "walking") {
        if (walkingStartRef.current === null) {
          walkingStartRef.current = now;
        } else if (now - walkingStartRef.current >= CONFIRM_DURATION_MS) {
          walkingStartRef.current = null;
          if (mode === "idle" || mode === "sitting" || mode === "standing") {
            void switchModeRef.current("walking");
          }
        }
      }
    } else {
      walkingStartRef.current = null;

      // Only start stop-debounce when speed is actually below the minimum (not just above max,
      // which likely means the user is in a vehicle — don't end walking for that).
      if (belowMin && mode === "walking") {
        if (belowThresholdSinceRef.current === null) {
          belowThresholdSinceRef.current = now;
        } else if (now - belowThresholdSinceRef.current >= STOP_DURATION_MS) {
          belowThresholdSinceRef.current = null;
          void endCurrentSessionRef.current();
        }
      } else if (!belowMin) {
        // Speed > max (vehicle) — reset stop debounce without ending walking
        belowThresholdSinceRef.current = null;
      }
    }
  }, []);

  const startWatching = useCallback(() => {
    if (watchIdRef.current !== null) return;

    watchIdRef.current = navigator.geolocation.watchPosition(
      handlePosition,
      (err) => {
        if (err.code === GeolocationPositionError.PERMISSION_DENIED) {
          setGpsStatus("denied");
        }
      },
      {
        enableHighAccuracy: true,
        maximumAge: 5000,
        timeout: 15000,
      },
    );
    setGpsStatus("active");
  }, [handlePosition]);

  const stopWatching = useCallback(() => {
    if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    prevPositionRef.current = null;
    walkingStartRef.current = null;
    belowThresholdSinceRef.current = null;
  }, []);

  useEffect(() => {
    if (!enabled) {
      stopWatching();
      setGpsStatus("idle");
      return;
    }

    if (!("geolocation" in navigator)) {
      setGpsStatus("unsupported");
      return;
    }

    setGpsStatus("requesting");

    let permissionResult: PermissionStatus | null = null;

    const handlePermissionChange = () => {
      if (!permissionResult) return;
      if (permissionResult.state === "denied") {
        stopWatching();
        setGpsStatus("denied");
      } else if (permissionResult.state === "granted" && watchIdRef.current === null) {
        startWatching();
      }
    };

    const tryPermissionsApi = async () => {
      if (!("permissions" in navigator)) {
        return false;
      }
      try {
        const result = await navigator.permissions.query({ name: "geolocation" });
        permissionResult = result;
        if (result.state === "denied") {
          setGpsStatus("denied");
          return true;
        }
        if (result.state === "granted") {
          startWatching();
          return true;
        }
        result.addEventListener("change", handlePermissionChange);
        return false;
      } catch {
        return false;
      }
    };

    void (async () => {
      const handled = await tryPermissionsApi();
      if (!handled) {
        navigator.geolocation.getCurrentPosition(
          () => { startWatching(); },
          (err) => {
            if (err.code === GeolocationPositionError.PERMISSION_DENIED) {
              setGpsStatus("denied");
            } else {
              startWatching();
            }
          },
          { timeout: 10000 },
        );
      }
    })();

    return () => {
      stopWatching();
      if (permissionResult) {
        permissionResult.removeEventListener("change", handlePermissionChange);
      }
    };
  }, [enabled, startWatching, stopWatching]);

  return gpsStatus;
}
