import { useEffect } from "react";
import { useRegisterSW } from "virtual:pwa-register/react";

export function UpdateBanner() {
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW();

  // Auto-apply SW updates immediately so users never get stuck on stale cached
  // chunks after a new deployment.  The new SW has already pre-cached fresh
  // assets before activating, so reloading is instant and safe.
  useEffect(() => {
    if (needRefresh) {
      updateServiceWorker(true);
    }
  }, [needRefresh, updateServiceWorker]);

  return null;
}
