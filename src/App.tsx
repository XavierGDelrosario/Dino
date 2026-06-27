// App layout + route switch. The session (a guest by default) is always present, so
// there's no login wall — /signin and /signup are optional pages reached from the
// person-icon menu. Header (menu + title) and footer wrap every route; the
// password-recovery flow is a takeover regardless of route.
import { useEffect, useState } from "react";
import { useSession } from "./hooks/useSession";
import { needsTermsAcceptance } from "./services/session";
import { warmJapaneseAnalyzer } from "./services/language";
import { ProfileMenu } from "./components/common/ProfileMenu";
import { LanguageMenu } from "./components/common/LanguageMenu";
import { ResetPasswordView } from "./components/common/ResetPasswordView";
import { TermsGateView } from "./components/common/TermsGateView";
import { HomeView } from "./views/HomeView";
import { AuthPage } from "./views/AuthPage";
import { ProfilePage } from "./views/ProfilePage";
import { DeleteAccountPage } from "./views/DeleteAccountPage";
import { AdminPage } from "./views/AdminPage";
import { LegalView } from "./views/LegalView";
import { useI18n } from "./i18n";
import { useRouter, Link } from "./router";
import "./components/common/common.css";

export function App() {
  const { userId, email, isAnonymous, recovering, clearRecovery, loading, error } = useSession();
  const { t } = useI18n();
  const { path, navigate } = useRouter();

  // Land on home once a sign-in completes while on the sign-in/up pages. The email
  // flows navigate() themselves in AuthPage; this is what carries the NATIVE Google
  // flow home — it finishes asynchronously in the deep-link handler (nativeAuth),
  // which has no router access, so without this the user stays on /signin after a
  // successful Google login. A guest (isAnonymous) on these pages is left alone.
  useEffect(() => {
    if (!recovering && !isAnonymous && (path === "/signin" || path === "/signup")) {
      navigate("/");
    }
  }, [recovering, isAnonymous, path, navigate]);

  // Terms gate: a permanent account that hasn't accepted the current Terms version
  // (Google signup that skipped the checkbox, or anyone after a Terms update) must
  // accept before using the app. Guests are never gated. Fail open on a check error.
  // One header menu open at a time (globe ↔ profile): opening one closes the other.
  const [openMenu, setOpenMenu] = useState<"lang" | "profile" | null>(null);

  const [needsTerms, setNeedsTerms] = useState(false);
  useEffect(() => {
    if (!userId || isAnonymous || recovering) { setNeedsTerms(false); return; }
    let active = true;
    needsTermsAcceptance(userId)
      .then((need) => { if (active) setNeedsTerms(need); })
      .catch(() => { if (active) setNeedsTerms(false); });
    return () => { active = false; };
  }, [userId, isAnonymous, recovering]);

  // Preload kuromoji's dictionary during idle time so the first Japanese analysis
  // (the Translate reader) isn't slowed by the ~12MB load. Best-effort only.
  useEffect(() => {
    const w = window as typeof window & { requestIdleCallback?: (cb: () => void) => void };
    if (w.requestIdleCallback) w.requestIdleCallback(() => warmJapaneseAnalyzer());
    else {
      const id = setTimeout(() => warmJapaneseAnalyzer(), 1500);
      return () => clearTimeout(id);
    }
  }, []);

  return (
    <main className="app">
      <header className="app__header">
        <LanguageMenu
          open={openMenu === "lang"}
          onToggle={() => setOpenMenu((m) => (m === "lang" ? null : "lang"))}
          onClose={() => setOpenMenu(null)}
        />
        {userId && (
          <ProfileMenu
            isAnonymous={isAnonymous}
            email={email}
            open={openMenu === "profile"}
            onToggle={() => setOpenMenu((m) => (m === "profile" ? null : "profile"))}
            onClose={() => setOpenMenu(null)}
          />
        )}
        <Link to="/" className="app__titlelink"><h1 className="app__title">DINO</h1></Link>
      </header>

      {loading && <p className="review__msg">{t("app.startingSession")}</p>}
      {error && (
        <div className="review__msg">
          <p>{t("app.sessionErrorTitle")}</p>
          <pre className="review__error">{error.message}</pre>
        </div>
      )}

      {/* Password-recovery takeover: followed a reset link → set a new password first. */}
      {recovering && <ResetPasswordView onDone={clearRecovery} />}

      {/* Legal docs are ALWAYS reachable — even while the Terms gate is up, the user
          must be able to read what they're accepting (the gate links here in a new tab). */}
      {!recovering && (path === "/privacy" || path === "/terms") && (
        <LegalView doc={path === "/terms" ? "terms" : "privacy"} />
      )}

      {/* Terms-acceptance takeover: account owes acceptance (Google bypass / Terms update).
          Not shown over the legal docs themselves (above). */}
      {userId && !isAnonymous && needsTerms && !recovering && path !== "/privacy" && path !== "/terms" && (
        <TermsGateView onDone={() => setNeedsTerms(false)} />
      )}

      {/* Main app (gated by Terms; legal routes handled above). */}
      {userId && !recovering && !needsTerms && path !== "/privacy" && path !== "/terms" && (
        path === "/signin" ? <AuthPage mode="signin" />
        : path === "/signup" ? <AuthPage mode="signup" />
        : path === "/profile" ? (isAnonymous ? <AuthPage mode="signup" /> : <ProfilePage userId={userId} isAnonymous={isAnonymous} email={email} />)
        : path === "/delete-account" ? (isAnonymous ? <AuthPage mode="signup" /> : <DeleteAccountPage />)
        : path === "/admin" ? <AdminPage />
        : <HomeView userId={userId} />
      )}
    </main>
  );
}
