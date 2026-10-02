// User copy for sign-in COLLISIONS. One email = one account = one method, so every
// message here points the user back to the method their account was created with.
import type { TFn } from "../i18n";
import type { SignInMethod } from "../services/session";
import type { OAuthProvider, OAuthReturnError } from "../services/oauthReturn";

export const PROVIDER: Record<OAuthProvider, string> = { google: "Google", apple: "Apple" };

/** "Google", "Google or Apple", "Google or your email and password". */
export function formatMethods(t: TFn, methods: SignInMethod[]): string {
  return methods.map((m) => t(`auth.method.${m}`)).join(t("auth.methodOr"));
}

/** Copy for a failed OAuth return, or null when there's nothing to say (the user
 *  cancelled at the provider — they know). `identity_already_exists` on a SIGN-UP
 *  never gets here: the auth page answers it by signing in instead (see AuthPage). */
export function oauthErrorCopy(t: TFn, err: OAuthReturnError): string | null {
  const provider = PROVIDER[err.intent?.provider ?? "google"];
  switch (err.code) {
    case "access_denied":
      return null;
    case "identity_already_exists":
      return t("auth.identityTaken", { provider });
    case "manual_linking_disabled":
      return t("auth.linkUnavailable", { provider });
    // The one-method rule (migration 20260782) raising inside GoTrue — e.g. Google on
    // an email that a password account holds. GoTrue reports only a generic
    // server_error, so the copy can't name the method; it points back to it.
    case "server_error":
    case "unexpected_failure":
      return t("auth.oauthDenied", { provider });
    default:
      return t("auth.oauthFailed", { provider });
  }
}
