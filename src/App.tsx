// App layout + route switch. The session (a guest by default) is always present, so
// there's no login wall — /signin and /signup are optional pages reached from the
// person-icon menu. Header (menu + title) and footer wrap every route; the
// password-recovery flow is a takeover regardless of route.
import { useEffect } from "react";
import { useSession } from "./hooks/useSession";
import { warmJapaneseAnalyzer } from "./services/language";
import { AttributionFooter } from "./components/common/AttributionFooter";
import { ProfileMenu } from "./components/common/ProfileMenu";
import { ResetPasswordView } from "./components/common/ResetPasswordView";
import { HomeView } from "./views/HomeView";
import { AuthPage } from "./views/AuthPage";
import { ProfilePage } from "./views/ProfilePage";
import { LegalView } from "./views/LegalView";
import { useI18n } from "./i18n";
import { useRouter, Link } from "./router";
import "./components/common/common.css";

export function App() {
  const { userId, email, isAnonymous, recovering, clearRecovery, loading, error } = useSession();
  const { t } = useI18n();
  const { path } = useRouter();

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
        {userId && <ProfileMenu isAnonymous={isAnonymous} email={email} />}
        <Link to="/" className="app__titlelink"><h1 className="app__title">DINO 大脳</h1></Link>
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

      {userId && !recovering && (
        path === "/signin" ? <AuthPage mode="signin" />
        : path === "/signup" ? <AuthPage mode="signup" />
        : path === "/profile" ? <ProfilePage userId={userId} isAnonymous={isAnonymous} email={email} />
        : path === "/privacy" ? <LegalView doc="privacy" />
        : path === "/terms" ? <LegalView doc="terms" />
        : <HomeView userId={userId} />
      )}

      <AttributionFooter />
    </main>
  );
}
