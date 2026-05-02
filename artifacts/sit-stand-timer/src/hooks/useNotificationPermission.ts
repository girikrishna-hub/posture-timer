import { useEffect, useState } from "react";

/**
 * Returns the live notification permission, updating whenever the browser
 * permission changes (e.g. user grants via prompt or system settings).
 *
 * Uses the Permissions API `permissionchange` event when available, with a
 * graceful no-op fallback on browsers that don't support it.
 */
export function useNotificationPermission(): NotificationPermission {
  const [permission, setPermission] = useState<NotificationPermission>(
    typeof Notification !== "undefined" ? Notification.permission : "default",
  );

  useEffect(() => {
    if (typeof Notification === "undefined") return;
    if (!("permissions" in navigator)) return;

    let permStatus: PermissionStatus | null = null;

    function handleChange() {
      // Always read the authoritative value from Notification.permission
      setPermission(Notification.permission);
    }

    navigator.permissions
      .query({ name: "notifications" as PermissionName })
      .then((status) => {
        permStatus = status;
        // Sync immediately in case permission changed between mount and query
        setPermission(Notification.permission);
        status.addEventListener("change", handleChange);
      })
      .catch(() => {
        // Permissions API unavailable — static initial value is used
      });

    return () => {
      permStatus?.removeEventListener("change", handleChange);
    };
  }, []);

  return permission;
}
