import { Router } from "express";

const router = Router();

/**
 * GET /api/native-oauth-complete
 *
 * Intermediate redirect for the Android Capacitor OAuth flow.
 *
 * Clerk only allows https:// and http:// for actionCompleteRedirectUrl.
 * Custom URI schemes like posture-timer:// are rejected with invalid_url_scheme.
 *
 * Flow:
 *  1. NativeSignIn sets actionCompleteRedirectUrl to this https:// endpoint.
 *  2. After Google OAuth completes, Clerk redirects the Custom Tab here,
 *     appending ?__clerk_ticket=<short-lived token> to the URL.
 *  3. We 302-redirect to posture-timer://oauth-callback?__clerk_ticket=<token>.
 *  4. Android sees the posture-timer:// scheme, fires the appUrlOpen event
 *     in the Capacitor WebView, which extracts the ticket and completes sign-in.
 *
 * This route must be outside requireAuth — the user is not yet authenticated.
 */
router.get("/native-oauth-complete", (req, res) => {
  const ticket = req.query["__clerk_ticket"];
  const deepLink = ticket
    ? `posture-timer://oauth-callback?__clerk_ticket=${encodeURIComponent(String(ticket))}`
    : "posture-timer://oauth-callback";

  res.redirect(302, deepLink);
});

export default router;
