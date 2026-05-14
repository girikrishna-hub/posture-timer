import { useEffect, useLayoutEffect, useRef, lazy, Suspense } from "react";
import { Switch, Route, Router as WouterRouter, Redirect, useLocation } from "wouter";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { ClerkProvider, Show, ClerkLoaded, ClerkLoading, useClerk, useAuth } from "@clerk/react";
import { publishableKeyFromHost } from "@clerk/react/internal";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TimerProvider, useTimer } from "@/contexts/TimerContext";
import { BladderProvider } from "@/contexts/BladderContext";
import { usePushSubscription } from "@/hooks/usePushSubscription";

// TimerPage is kept eager — it is the first screen authenticated users land on.
// Every other page is lazy-loaded so its JS (and heavy deps like recharts) are
// only fetched when the user actually navigates there.
import TimerPage from "@/pages/TimerPage";

const SettingsPage     = lazy(() => import("@/pages/SettingsPage"));
const DashboardPage    = lazy(() => import("@/pages/DashboardPage"));
const BladderPage      = lazy(() => import("@/pages/BladderPage"));
const BladderStatsPage = lazy(() => import("@/pages/BladderStatsPage"));
const SignInPage        = lazy(() => import("@/pages/SignInPage"));
const SignUpPage        = lazy(() => import("@/pages/SignUpPage"));
const LandingPage       = lazy(() => import("@/pages/LandingPage"));
const NotFound          = lazy(() => import("@/pages/not-found"));

import { BottomNav } from "@/components/BottomNav";
import { UpdateBanner } from "@/components/UpdateBanner";
import { NativeDebugPanel } from "@/components/NativeDebugPanel";

// Side-effect import: registers the Bearer-token getter and API base URL for
// native Capacitor builds at module load time (before any React renders).
import { IS_NATIVE, bindClerkGetToken } from "@/lib/nativeAuth";

/**
 * Wires Clerk's getToken into the customFetch auth-token getter for native
 * (Capacitor Android/iOS) builds.
 *
 * Why useLayoutEffect: TanStack Query schedules its first fetch in useEffect.
 * useLayoutEffect fires synchronously before any useEffect in the same render
 * cycle, so _getToken is guaranteed to be set before the first API call fires.
 * On web (IS_NATIVE = false) this component is a no-op.
 */
function CapacitorAuthBridge() {
  const { getToken } = useAuth();

  useLayoutEffect(() => {
    if (!IS_NATIVE) return;
    bindClerkGetToken(getToken);
    return () => bindClerkGetToken(null);
  }, [getToken]);

  return null;
}

// Thin fallback that matches the app background — avoids white flash
const PageFallback = () => (
  <div className="min-h-screen bg-background" aria-hidden />
);

function PushSubscriptionRegistrar() {
  const { notificationPermission } = useTimer();
  usePushSubscription(notificationPermission);
  return null;
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 30,
      // On native: never retry 401s — the Bearer token either worked or it
      // didn't; retrying immediately won't help and causes log spam.
      // Log 401s clearly so they appear in Android logcat.
      retry: IS_NATIVE
        ? (failureCount, error) => {
            const status = (error as { status?: number })?.status;
            if (status === 401) {
              console.error(
                "[NativeAuth] 401 Unauthorized on API call — " +
                  "token getter may not be ready or getToken() returned null. " +
                  "Check NativeDebugPanel for auth state.",
                error,
              );
              return false; // do NOT retry 401s
            }
            return failureCount < 1;
          }
        : 1,
    },
  },
});

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

const clerkPubKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);

const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL as string | undefined;

function stripBase(path: string): string {
  return basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || "/"
    : path;
}

const clerkAppearance = {
  cssLayerName: "clerk",
  options: {
    logoPlacement: "inside" as const,
    logoLinkUrl: basePath || "/",
    logoImageUrl: `${window.location.origin}${basePath}/logo.svg`,
  },
  variables: {
    colorPrimary: "hsl(133 17% 59%)",
    colorForeground: "hsl(20 14% 4%)",
    colorMutedForeground: "hsl(25 5% 45%)",
    colorDanger: "hsl(0 84% 60%)",
    colorBackground: "hsl(60 9% 98%)",
    colorInput: "hsl(60 5% 90%)",
    colorInputForeground: "hsl(20 14% 4%)",
    colorNeutral: "hsl(60 5% 90%)",
    fontFamily: "Inter, sans-serif",
    borderRadius: "0.75rem",
  },
  elements: {
    rootBox: "w-full flex justify-center",
    cardBox: "bg-white rounded-2xl w-[440px] max-w-full overflow-hidden shadow-sm border border-[hsl(60_5%_90%)]",
    card: "!shadow-none !border-0 !bg-transparent !rounded-none",
    footer: "!shadow-none !border-0 !bg-transparent !rounded-none",
    headerTitle: "text-[hsl(20_14%_4%)] font-bold",
    headerSubtitle: "text-[hsl(25_5%_45%)]",
    socialButtonsBlockButtonText: "text-[hsl(20_14%_4%)]",
    formFieldLabel: "text-[hsl(20_14%_4%)] font-medium",
    footerActionLink: "text-[hsl(133_17%_59%)] hover:text-[hsl(133_17%_49%)]",
    footerActionText: "text-[hsl(25_5%_45%)]",
    dividerText: "text-[hsl(25_5%_45%)]",
    identityPreviewEditButton: "text-[hsl(133_17%_59%)]",
    formFieldSuccessText: "text-[hsl(133_17%_59%)]",
    alertText: "text-[hsl(20_14%_4%)]",
    formButtonPrimary: "bg-[hsl(133_17%_59%)] hover:bg-[hsl(133_17%_49%)] text-white",
    formFieldInput: "border-[hsl(60_5%_90%)] bg-white text-[hsl(20_14%_4%)]",
    dividerLine: "bg-[hsl(60_5%_90%)]",
    socialButtonsBlockButton: "border-[hsl(60_5%_90%)] bg-white hover:bg-[hsl(60_9%_95%)]",
  },
};

function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  const qc = useQueryClient();
  const prevUserIdRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const unsubscribe = addListener(({ user }) => {
      const userId = user?.id ?? null;
      if (prevUserIdRef.current !== undefined && prevUserIdRef.current !== userId) {
        qc.clear();
      }
      prevUserIdRef.current = userId;
    });
    return unsubscribe;
  }, [addListener, qc]);

  return null;
}

/**
 * Native (Capacitor Android/iOS) app shell — DEBUG MODE.
 *
 * Bypasses all Clerk loading/auth-gating so we can see whether the white
 * screen comes from Clerk initialization, route gating, or something else.
 * NativeDebugPanel overlays the real auth state so the exact failure point
 * is visible.
 *
 * TODO: remove this branch once the root cause is confirmed and fixed.
 */
function NativeAppShell() {
  return (
    <>
      <ClerkQueryClientCacheInvalidator />
      <CapacitorAuthBridge />

      {/* Render the full app immediately — no auth gate, no loading wait */}
      <TimerProvider>
        <PushSubscriptionRegistrar />
        <BladderProvider>
          <Suspense fallback={<PageFallback />}>
            <Switch>
              <Route path="/" component={TimerPage} />
              <Route path="/settings" component={SettingsPage} />
              <Route path="/dashboard" component={DashboardPage} />
              <Route path="/bladder/stats" component={BladderStatsPage} />
              <Route path="/bladder" component={BladderPage} />
              <Route component={NotFound} />
            </Switch>
          </Suspense>
          <BottomNav />
        </BladderProvider>
      </TimerProvider>

      {/* Diagnostic overlay — shows Clerk state, token result, API base URL */}
      <NativeDebugPanel />
    </>
  );
}

function AppShell() {
  // ── DEBUG: bypass auth gates on native to isolate startup failure ──────────
  if (IS_NATIVE) return <NativeAppShell />;
  // ──────────────────────────────────────────────────────────────────────────

  return (
    <>
      <ClerkQueryClientCacheInvalidator />
      {/* On native Capacitor builds: binds Clerk's getToken into the
          customFetch Bearer-token getter before any API useEffect fires. */}
      <CapacitorAuthBridge />

      {/* Sign-in / sign-up routes are outside the auth gate so Clerk can
          render them before the session is established. */}
      <Suspense fallback={<PageFallback />}>
        <Switch>
          <Route path="/sign-in/*?" component={SignInPage} />
          <Route path="/sign-up/*?" component={SignUpPage} />
          <Route>
            <>
              <ClerkLoading>
                <div className="min-h-screen bg-background" />
              </ClerkLoading>

              <ClerkLoaded>
                <Show when="signed-in">
                  <TimerProvider>
                    <PushSubscriptionRegistrar />
                    <BladderProvider>
                      <Suspense fallback={<PageFallback />}>
                        <Switch>
                          <Route path="/" component={TimerPage} />
                          <Route path="/settings" component={SettingsPage} />
                          <Route path="/dashboard" component={DashboardPage} />
                          <Route path="/bladder/stats" component={BladderStatsPage} />
                          <Route path="/bladder" component={BladderPage} />
                          <Route component={NotFound} />
                        </Switch>
                      </Suspense>
                      <BottomNav />
                    </BladderProvider>
                  </TimerProvider>
                </Show>

                <Show when="signed-out">
                  <Suspense fallback={<PageFallback />}>
                    <Switch>
                      <Route path="/" component={LandingPage} />
                      <Route>
                        <Redirect to="/" />
                      </Route>
                    </Switch>
                  </Suspense>
                </Show>
              </ClerkLoaded>
            </>
          </Route>
        </Switch>
      </Suspense>
    </>
  );
}

function ClerkProviderWithRoutes({ children }: { children: React.ReactNode }) {
  const [, setLocation] = useLocation();

  return (
    <ClerkProvider
      publishableKey={clerkPubKey ?? ""}
      proxyUrl={clerkProxyUrl}
      appearance={clerkAppearance}
      signInUrl={`${basePath}/sign-in`}
      signUpUrl={`${basePath}/sign-up`}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      {children}
    </ClerkProvider>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={basePath}>
          <ClerkProviderWithRoutes>
            <AppShell />
          </ClerkProviderWithRoutes>
        </WouterRouter>
        <Toaster />
        <UpdateBanner />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
