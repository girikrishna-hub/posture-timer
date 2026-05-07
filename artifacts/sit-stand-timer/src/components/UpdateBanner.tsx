import { useRegisterSW } from "virtual:pwa-register/react";

export function UpdateBanner() {
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW();

  if (!needRefresh) return null;

  return (
    <div className="fixed bottom-20 inset-x-0 z-50 flex justify-center px-4 pointer-events-none">
      <div className="pointer-events-auto flex items-center gap-3 bg-foreground text-background rounded-2xl px-4 py-3 shadow-lg text-sm font-medium max-w-sm w-full">
        <span className="flex-1">New version available</span>
        <button
          onClick={() => updateServiceWorker(true)}
          className="shrink-0 bg-background text-foreground rounded-xl px-3 py-1.5 text-xs font-semibold hover:opacity-80 transition-opacity"
        >
          Refresh
        </button>
      </div>
    </div>
  );
}
