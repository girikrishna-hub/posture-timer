import { useState, useRef, useCallback, useEffect } from "react";

/**
 * Manages the two-phase slide-in / fade-out animation for transient banners.
 *
 * Usage:
 *   const banner = useBanner(5000);
 *   banner.show();          // trigger
 *   banner.dismiss();       // early close
 *
 *   {banner.shown && (
 *     <div className={[
 *       "transition-all duration-300 ease-out",
 *       banner.visible ? "opacity-100 translate-y-0" : "opacity-0 -translate-y-2",
 *     ].join(" ")}>...</div>
 *   )}
 *
 * For banners with dynamic messages, pass the message through show():
 *   const banner = useBanner<string>(5000);
 *   banner.show("Settings saved!");
 *   // banner.message === "Settings saved!"
 */
export function useBanner<T = undefined>(duration = 5000) {
  const [shown, setShown] = useState(false);
  const [visible, setVisible] = useState(false);
  const [message, setMessage] = useState<T | undefined>(undefined);

  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const visibleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      if (visibleTimerRef.current) clearTimeout(visibleTimerRef.current);
    };
  }, []);

  const hide = useCallback(() => {
    if (hideTimerRef.current) { clearTimeout(hideTimerRef.current); hideTimerRef.current = null; }
    if (visibleTimerRef.current) { clearTimeout(visibleTimerRef.current); visibleTimerRef.current = null; }
    setVisible(false);
    setShown(false);
    setMessage(undefined);
  }, []);

  const dismiss = useCallback(() => {
    if (hideTimerRef.current) { clearTimeout(hideTimerRef.current); hideTimerRef.current = null; }
    if (visibleTimerRef.current) { clearTimeout(visibleTimerRef.current); }
    setVisible(false);
    visibleTimerRef.current = setTimeout(() => {
      setShown(false);
      setMessage(undefined);
      visibleTimerRef.current = null;
    }, 350);
  }, []);

  const show = useCallback((msg?: T) => {
    if (hideTimerRef.current) { clearTimeout(hideTimerRef.current); hideTimerRef.current = null; }
    if (visibleTimerRef.current) { clearTimeout(visibleTimerRef.current); visibleTimerRef.current = null; }
    if (msg !== undefined) setMessage(msg);
    setShown(true);
    setVisible(false);
    visibleTimerRef.current = setTimeout(() => {
      setVisible(true);
      visibleTimerRef.current = null;
    }, 16);
    hideTimerRef.current = setTimeout(() => {
      hideTimerRef.current = null;
      dismiss();
    }, duration);
  }, [duration, dismiss]);

  return { show, dismiss, hide, shown, visible, message };
}
