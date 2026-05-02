import { Link } from "wouter";

const CheckIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-primary shrink-0 mt-0.5">
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

const features = [
  {
    title: "Smart posture tracking",
    desc: "Sit, stand, rest, and walk — the timer adapts to your rhythm and nudges you at the right moments.",
  },
  {
    title: "Google Fit assisted mode",
    desc: "Automatically detects walking from your step data and corrects your posture state in real time.",
  },
  {
    title: "Web Push notifications",
    desc: "Get background reminders even when the app isn't open, on any device.",
  },
  {
    title: "Bladder Schedule Mode",
    desc: "Set timed reminders for bladder health — discreet alerts keep you on track all day.",
  },
  {
    title: "Progress dashboard",
    desc: "Weekly charts, daily streaks, and standing-goal progress at a glance.",
  },
  {
    title: "Privacy first",
    desc: "Your data is isolated to your account and never shared.",
  },
];

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-4 border-b border-border">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
          </div>
          <span className="font-semibold text-base">Posture Timer</span>
        </div>
        <Link
          href="/sign-in"
          className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
        >
          Sign in
        </Link>
      </header>

      {/* Hero */}
      <main className="flex-1 flex flex-col items-center justify-center text-center px-6 py-16 gap-8">
        <div className="flex flex-col items-center gap-4 max-w-md">
          <div className="w-20 h-20 rounded-2xl bg-primary/10 flex items-center justify-center">
            <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="hsl(133 17% 59%)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
          </div>
          <h1 className="text-3xl font-bold tracking-tight leading-tight">
            Your posture,<br />on your terms.
          </h1>
          <p className="text-muted-foreground text-base leading-relaxed">
            A smart sit/stand timer that tracks your posture, reminds you to move,
            and connects with Google Fit — all synced to your account.
          </p>
        </div>

        <div className="flex flex-col sm:flex-row gap-3 w-full max-w-xs">
          <Link
            href="/sign-up"
            className="flex-1 bg-primary text-white font-semibold py-3 px-6 rounded-xl text-center text-sm hover:bg-primary/90 transition-colors"
          >
            Get started free
          </Link>
          <Link
            href="/sign-in"
            className="flex-1 bg-secondary text-foreground font-semibold py-3 px-6 rounded-xl text-center text-sm hover:bg-secondary/80 transition-colors"
          >
            Sign in
          </Link>
        </div>
      </main>

      {/* Features */}
      <section className="px-6 pb-16 max-w-lg mx-auto w-full">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-5 text-center">
          Everything you need
        </h2>
        <ul className="grid gap-4">
          {features.map((f) => (
            <li key={f.title} className="flex items-start gap-3">
              <CheckIcon />
              <div>
                <p className="text-sm font-semibold">{f.title}</p>
                <p className="text-sm text-muted-foreground leading-snug">{f.desc}</p>
              </div>
            </li>
          ))}
        </ul>
      </section>

      {/* Footer */}
      <footer className="border-t border-border px-6 py-4 text-center text-xs text-muted-foreground">
        Posture Timer — stay active, stay healthy.
      </footer>
    </div>
  );
}
