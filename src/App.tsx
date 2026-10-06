// App layout + route switch. The session (a guest by default) is always present, so
// there's no login wall — /signin and /signup are optional pages reached from the
// person-icon menu. Header (menu + title) and footer wrap every route; the
// password-recovery flow is a takeover regardless of route.
import { useEffect, useRef, useState } from "react";
import { useSession } from "./hooks/useSession";
import { completeGoogleSignIn, needsTermsAcceptance } from "./services/session";
import { hasGoogleReturn, recordGoogleFailure, takeGoogleReturn } from "./services/googleIdentity";
import { warmJapaneseAnalyzer } from "./services/language";
import { Capacitor } from "@capacitor/core";
import { watchForReconnect } from "./services/offline/sync";
import { watchOfflineDeck } from "./services/review";
import { watchDailyWordWidget } from "./services/widget/dailyWord";
import { ProfileMenu } from "./components/common/ProfileMenu";
import { LanguageMenu } from "./components/common/LanguageMenu";
import { ResetPasswordView } from "./components/common/ResetPasswordView";
import { TermsGateView } from "./components/common/TermsGateView";
import { ErrorText } from "./components/common/ErrorText";
import { SplashScreen } from "./components/common/Loading";
import { AttributionFooter } from "./components/common/AttributionFooter";
import { StreakBadge } from "./components/common/StreakBadge";
import { RowLimitNotice } from "./components/common/RowLimitNotice";
import { useReminderSync } from "./hooks/useReminderSync";
import { useStreak } from "./hooks/useStreak";
import { HomeView } from "./views/HomeView";
import { AuthPage } from "./views/AuthPage";
import { ProfilePage } from "./views/ProfilePage";
import { HistoryPage } from "./views/HistoryPage";
import { DeleteAccountPage } from "./views/DeleteAccountPage";
import { AdminPage } from "./views/AdminPage";
import { GoalsPage } from "./views/GoalsPage";
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

  // Google has just returned with an ID token (services/googleIdentity). Finish the
  // sign-in HERE, behind the splash, so the user goes from Google straight to the app
  // instead of watching the sign-in form reload and then leave. It needs the booted
  // session (a sign-up links the current guest), hence the wait for `userId`. A refusal
  // is handed to the auth page — the URL was already put back on it — to explain.
  const [finishingGoogle, setFinishingGoogle] = useState(hasGoogleReturn);
  const googleStarted = useRef(false);
  useEffect(() => {
    if (!userId || googleStarted.current) return;
    const back = takeGoogleReturn();
    if (!back) return;
    googleStarted.current = true;
    void completeGoogleSignIn(back)
      .then((failed) => {
        if (failed) recordGoogleFailure(failed);
        else navigate("/");
      })
      .finally(() => setFinishingGoogle(false));
  }, [userId, navigate]);

  // A recovery takeover only makes sense for an ACCOUNT. `recovering` is seeded from
  // the URL, so a mangled or crafted link could raise it over a guest, whose password
  // can never be set — a form with no way out. Drop it.
  useEffect(() => {
    if (recovering && userId && isAnonymous) clearRecovery();
  }, [recovering, userId, isAnonymous, clearRecovery]);

  // Terms gate: a permanent account that hasn't accepted the current Terms version
  // (Google signup that skipped the checkbox, or anyone after a Terms update) must
  // accept before using the app. Guests are never gated. Fail open on a check error.
  // One header menu open at a time (globe ↔ profile): opening one closes the other.
  const [openMenu, setOpenMenu] = useState<"lang" | "profile" | null>(null);

  // Replay any grades taken offline. Runs once a session exists (the writes are
  // RLS-scoped, so there is nothing to send without one) and again on every reconnect.
  // Best-effort by construction: a failed drain leaves the queue intact for next time.
  useEffect(() => {
    if (!userId) return;
    return watchForReconnect();
  }, [userId]);

  // Keep a deep review deck on the device so Review still deals cards with no network.
  // The APP only: offline study is a native use case, and on the web this would be an
  // extra ranked query on every page load for a deck nobody opens.
  useEffect(() => {
    if (!userId || !Capacitor.isNativePlatform()) return;
    return watchOfflineDeck(userId);
  }, [userId]);

  // Hand the home-screen widgets their daily words (services/widget). Inert on the web.
  useEffect(() => {
    if (!userId) return;
    return watchDailyWordWidget(userId);
  }, [userId]);

  const [needsTerms, setNeedsTerms] = useState(false);
  useEffect(() => {
    if (!userId || isAnonymous || recovering) { setNeedsTerms(false); return; }
    let active = true;
    needsTermsAcceptance(userId)
      .then((need) => { if (active) setNeedsTerms(need); })
      .catch(() => { if (active) setNeedsTerms(false); });
    return () => { active = false; };
  }, [userId, isAnonymous, recovering]);

  // Reminders (services/reminders): re-schedule the coming week whenever today's
  // activity flips, so the first save or grade of the day cancels today's nag.
  const { streaks } = useStreak(userId ?? "");
  useReminderSync(userId ? (streaks?.studiedToday ?? null) : null);

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

  // Startup: nothing but the mascot + dots until the session exists — the header's
  // menus have nothing to act on yet, and this picks up exactly where index.html's
  // pre-bundle splash left off.
  if (loading || (finishingGoogle && !error)) return <SplashScreen />;

  return (
    // The app is a phone-width column everywhere EXCEPT /admin: that's an ops
    // surface of dense multi-column tables (user buckets, timestamps, emails) that
    // can't fit 540px, and squeezing them there is what made rows spill out of the
    // panels. Widen the column for that one route; every other view is unchanged.
    <main className={`app${path === "/admin" ? " app--wide" : ""}`}>
      <header className="app__header">
        {userId && <StreakBadge userId={userId} />}
        {/* The top-bar controls, as ONE row: language · account. They used
            to position themselves individually (right: 0, right: 2.6rem), which meant
            every new one had to know the width of the ones beside it — and the account
            icon is conditional, so the arithmetic was wrong before the session loaded. */}
        <div className="app__menus">
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
        </div>
        <Link to="/" className="app__titlelink"><h1 className="app__title">DINO</h1></Link>
      </header>

      {error && (
        <div className="review__msg">
          <p>{t("app.sessionErrorTitle")}</p>
          <ErrorText message={error.message} />
        </div>
      )}

      {/* A refused save (per-user row cap): the account prompt for a guest. Shown here so
          it lands on whichever surface the save came from. */}
      {userId && !recovering && <RowLimitNotice userId={userId} isAnonymous={isAnonymous} />}

      {/* Password-recovery takeover: followed a reset link → set a new password first. */}
      {recovering && <ResetPasswordView onDone={clearRecovery} onCancel={clearRecovery} />}

      {/* Legal docs are ALWAYS reachable — even while the Terms gate is up, the user
          must be able to read what they're accepting (the gate links here in a new tab). */}
      {!recovering && (path === "/privacy" || path === "/terms" || path === "/support") && (
        <LegalView doc={path === "/terms" ? "terms" : path === "/support" ? "support" : "privacy"} />
      )}

      {/* Terms-acceptance takeover: account owes acceptance (Google bypass / Terms update).
          Not shown over the legal docs themselves (above). */}
      {userId && !isAnonymous && needsTerms && !recovering && path !== "/privacy" && path !== "/terms" && path !== "/support" && (
        <TermsGateView onDone={() => setNeedsTerms(false)} />
      )}

      {/* Main app (gated by Terms; legal routes handled above). */}
      {userId && !recovering && !needsTerms && path !== "/privacy" && path !== "/terms" && path !== "/support" && (
        path === "/signin" ? <AuthPage mode="signin" />
        : path === "/signup" ? <AuthPage mode="signup" />
        : path === "/profile" ? (isAnonymous ? <AuthPage mode="signup" /> : <ProfilePage userId={userId} isAnonymous={isAnonymous} email={email} />)
        : path === "/history" ? (isAnonymous ? <AuthPage mode="signup" /> : <HistoryPage userId={userId} />)
        : path === "/delete-account" ? (isAnonymous ? <AuthPage mode="signup" /> : <DeleteAccountPage />)
        : path === "/admin" ? <AdminPage />
        : path === "/goals" ? <GoalsPage userId={userId} />
        : <HomeView key={userId} userId={userId} />
      )}

      {/* Legal links + data-source credits for EVERYONE — they used to sit only on the
          Profile page, which a guest (the default visitor) can't reach. Hidden by CSS on
          the study surfaces (Translate, Review, quizzes — see NoFooter); a guest finds
          them on Lists, Learn and the sign-in page. */}
      <AttributionFooter />
    </main>
  );
}
