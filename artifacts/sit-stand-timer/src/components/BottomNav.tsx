import { Link, useRoute } from "wouter";
import { useClerk, useUser } from "@clerk/react";

const TimerIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10" />
    <polyline points="12 6 12 12 16 14" />
  </svg>
);

const ChartIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="18" y1="20" x2="18" y2="10" />
    <line x1="12" y1="20" x2="12" y2="4" />
    <line x1="6" y1="20" x2="6" y2="14" />
  </svg>
);

const BladderIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 2C8 2 5 6 5 10c0 5 4 10 7 12 3-2 7-7 7-12 0-4-3-8-7-8z" />
    <circle cx="12" cy="10" r="2" fill="currentColor" stroke="none" />
  </svg>
);

const UserIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="8" r="4" />
    <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" />
  </svg>
);

export function BottomNav() {
  const [onTimer]     = useRoute("/");
  const [onDashboard] = useRoute("/dashboard");
  const [onBladder]   = useRoute("/bladder");
  const [onBladderStats] = useRoute("/bladder/stats");
  const { signOut }   = useClerk();
  const { user }      = useUser();

  const initials = user?.firstName?.charAt(0)?.toUpperCase() ?? user?.emailAddresses?.[0]?.emailAddress?.charAt(0)?.toUpperCase() ?? "U";
  const avatarUrl = user?.imageUrl;

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 bg-background border-t border-border flex">
      <Link
        href="/"
        className={`flex-1 flex flex-col items-center justify-center py-3 gap-1 text-xs font-medium transition-colors ${
          onTimer ? "text-primary" : "text-muted-foreground hover:text-foreground"
        }`}
      >
        <TimerIcon />
        <span>Timer</span>
      </Link>
      <Link
        href="/dashboard"
        className={`flex-1 flex flex-col items-center justify-center py-3 gap-1 text-xs font-medium transition-colors ${
          onDashboard ? "text-primary" : "text-muted-foreground hover:text-foreground"
        }`}
      >
        <ChartIcon />
        <span>Dashboard</span>
      </Link>
      <Link
        href="/bladder"
        className={`flex-1 flex flex-col items-center justify-center py-3 gap-1 text-xs font-medium transition-colors ${
          onBladder || onBladderStats ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground hover:text-foreground"
        }`}
      >
        <BladderIcon />
        <span>Bladder</span>
      </Link>
      <button
        onClick={() => void signOut({ redirectUrl: "/" })}
        className="flex-1 flex flex-col items-center justify-center py-3 gap-1 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
        title="Sign out"
      >
        {avatarUrl ? (
          <img
            src={avatarUrl}
            alt={initials}
            className="w-[22px] h-[22px] rounded-full object-cover"
          />
        ) : (
          <div className="w-[22px] h-[22px] rounded-full bg-primary/20 flex items-center justify-center text-[10px] font-bold text-primary">
            {initials}
          </div>
        )}
        <span>Sign out</span>
      </button>
    </nav>
  );
}
