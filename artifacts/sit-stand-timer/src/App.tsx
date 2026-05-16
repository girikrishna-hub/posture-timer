import { useEffect, useRef, lazy, Suspense } from "react";
import { Switch, Route, Router as WouterRouter, Redirect, useLocation } from "wouter";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { Show, ClerkLoaded, ClerkLoading, useClerk } from "@clerk/react";
import { publishableKeyFromHost, InternalClerkProvider } from "@clerk/react/internal";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TimerProvider, useTimer } from "@/contexts/TimerContext";
import { BladderProvider } from "@/contexts/BladderContext";
import { usePushSubscription } from "@/hooks/usePushSubscription";

// RuntimeCore — native-first auth subsystem
import { AuthRuntime, ClerkRuntimeBridge, AuthRuntimeOverlay } from "@/runtime/auth";
import { useAuthRuntime, useBootBarrier } from "@/runtime/auth";
import { NativeAuthScreen } from "@/runtime/auth/NativeAuthScreen";

// TimerPage is kept eager — it is the first screen authenticated users land on.
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

import { IS_NATIVE } from "@/lib/nativeAuth";
import {
  NATIVE_CLERK_PUBLISHABLE_KEY,
  NATIVE_CLERK_PROXY_URL,
  NATIVE_CLERK_JS_URL,
} from "@/lib/nativeConfig";

// Boot the AuthRuntime singleton as early as possible (module-level side effect).
// On native this initializes Google Auth plugin, probes capabilities, and attempts
// session restoration before React renders feature UI.
if (IS_NATIVE) {
  AuthRuntime.instance.boot().catch((e) =>
    console.error("[AuthRuntime] Boot error:", e)
  );
}

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
      retry: IS_NATIVE
        ? (failureCount, error) => {
            const status = (error as { status?: number })?.status;
            if (status === 401) {
              console.error(
                "[AuthRuntime] 401 on API call — JWT may be stale or missing",
                error,
              );
              return false;
            }
            return failureCount < 1;
          }
        : 1,
    },
  },
});

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

const clerkPubKey = IS_NATIVE
  ? NATIVE_CLERK_PUBLISHABLE_KEY
  : publishableKeyFromHost(
      window.location.hostname,
      import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
    );

const clerkProxyUrl = IS_NATIVE
  ? NATIVE_CLERK_PROXY_URL
  : (import.meta.env.VITE_CLERK_PROXY_URL as string | undefined);

const clerkJsUrl = IS_NATIVE ? NATIVE_CLERK_JS_URL : undefined;

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
    alertText: "text-[hsl(20_14% 4%)]",
    formButtonPrimary: "bg-[hsl(133_17%_59%)] hover:bg-[hsl(133_17%_49%)] text-white",
    formFieldInput: "border-[hsl(60_5%_90%)] bg-white text-[hsl(20_14%_4%)]",
    dividerLine: "bg-[hsl(60_5%_90%)]",
    socialButtonsBlockButton: "border-[hsl(60_5%_90%)] bg-white hover:bg-[hsl(60_9%_95%)]",
  },
};

// Cache invalidation when user switches (web path only)
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
 * Full app routes — shown once the user is authenticated.
 */
function AppRoutes() {
  return (
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
  );
}

/**
 * Native (Capacitor Android/iOS) app shell — RuntimeCore-driven.
 *
 * Boot sequence:
 *  1. RuntimeBootBarrier blocks until AuthRuntime.boot() resolves
 *  2. ClerkRuntimeBridge wires Clerk hooks into ClerkBridgeAdapter
 *  3. AuthRuntime.store drives the gate: not-restored → loading,
 *     not-authenticated → NativeAuthScreen, authenticated → AppRoutes
 *
 * AuthRuntimeOverlay is always visible for diagnostics during development.
 */
function NativeAppShell() {
  const { isCleared } = useBootBarrier();
  const { isAuthenticated, isRestored } = useAuthRuntime();

  // Always wire Clerk hooks so ClerkBridgeAdapter can use them for
  // token exchange and refresh regardless of sign-in state.
  // ClerkRuntimeBridge is a pure side-effect component (renders null).

  if (!isCleared || !isRestored) {
    return (
      <>
        <ClerkRuntimeBridge />
        <div className="min-h-screen bg-background" aria-hidden />
        <AuthRuntimeOverlay />
      </>
    );
  }

  if (!isAuthenticated) {
    return (
      <>
        <ClerkRuntimeBridge />
        <NativeAuthScreen />
        <AuthRuntimeOverlay />
      </>
    );
  }

  return (
    <>
      <ClerkRuntimeBridge />
      <AppRoutes />
      <AuthRuntimeOverlay />
    </>
  );
}

/**
 * Web app shell — unchanged Clerk-driven flow.
 */
function WebAppShell() {
  return (
    <>
      <ClerkQueryClientCacheInvalidator />

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
                  <AppRoutes />
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

function AppShell() {
  if (IS_NATIVE) return <NativeAppShell />;
  return <WebAppShell />;
}

function ClerkProviderWithRoutes({ children }: { children: React.ReactNode }) {
  const [, setLocation] = useLocation();

  return (
    <InternalClerkProvider
      publishableKey={clerkPubKey ?? ""}
      proxyUrl={clerkProxyUrl}
      __internal_clerkJSUrl={clerkJsUrl}
      appearance={clerkAppearance}
      signInUrl={`${basePath}/sign-in`}
      signUpUrl={`${basePath}/sign-up`}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      {children}
    </InternalClerkProvider>
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
