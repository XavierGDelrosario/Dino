// Privacy Policy + Terms of Service + Support pages (/privacy, /terms, /support).
// The first two are DRAFTS reflecting the app's ACTUAL data flows — not legal advice;
// have counsel review before publishing. Kept in English (canonical) for v1; the
// chrome around them is localized.
//
// /support exists because the App Store REQUIRES a reachable support URL on the
// listing, and review checks it loads and is about this app. It is a page, not a
// mailto: — Apple rejects a bare mail link.
import { useI18n } from "../i18n";
import { Link } from "../router";
import "../components/common/common.css";

const UPDATED = "2026-08-12";

/** Where support mail goes. The Brevo-validated sender for now; moves to
 *  support@<domain> when the custom domain lands (docs/TODO.md). */
export const SUPPORT_EMAIL = "dinolanguagestudy@gmail.com";

export function LegalView({ doc }: { doc: "privacy" | "terms" | "support" }) {
  const { t } = useI18n();
  return (
    <section className="legal">
      {doc !== "support" && (
        <p className="legal__draft">
          Draft — provided as-is for a POC and not legal advice; review with counsel
          before publishing.
        </p>
      )}
      {doc === "privacy" ? <Privacy /> : doc === "terms" ? <Terms /> : <Support />}
      <p className="legal__updated">Last updated: {UPDATED}</p>
      <Link to="/" className="account__link">{t("profile.back")}</Link>
    </section>
  );
}

function Privacy() {
  return (
    <>
      <h2 className="legal__title">Privacy Policy</h2>
      <p>DINO is a vocabulary-learning app. This explains what we store and who it's shared with.</p>

      <h3>What we store</h3>
      <ul>
        <li><b>Your vocabulary</b> — the words, lists, meanings, and review history you create,
          plus any articles you star and any word reports you send us.</li>
        <li><b>Account info</b> — if you create an account, your email address (passwords are
          stored only as salted hashes by our auth provider; we never see them).</li>
        <li><b>Guest data</b> — without an account you use an anonymous guest profile with a
          random id, not linked to your identity. This data is kept <b>on our servers</b>, not
          only in your browser (see “Your choices”).</li>
        <li><b>Usage metering</b> — counts of characters translated, to enforce free-tier limits.</li>
        <li><b>Error logs</b> — when something fails we record the error and a short, truncated
          copy of the input that triggered it, so we can fix it. That excerpt can contain
          whatever text you were translating at the time.</li>
        <li><b>Local storage</b> — your session and UI-language choice are kept in your browser.</li>
      </ul>
      <p>Our hosting providers also keep ordinary server logs, which include your IP address.</p>

      <h3>Processed on your device</h3>
      <p>Photos, camera images, microphone audio and handwriting are turned into text
        <b>on your device</b> and are never uploaded. Only the resulting text is looked up, and
        only if you ask for it.</p>

      <h3>Who it's shared with</h3>
      <ul>
        <li><b>Supabase</b> — our authentication and database provider, stores the above.</li>
        <li><b>Cloudflare</b> — serves the app; processes your IP address and request logs.</li>
        <li><b>Google Cloud Translation</b> — when a word or paragraph isn't in our dictionary, the
          text you translate is sent to Google to translate it. Don't enter sensitive personal
          information you don't want processed by a third party.</li>
        <li><b>Brevo</b> — sends account email (sign-up confirmation, password reset); receives
          your email address.</li>
        <li><b>Google and Apple</b> — only if you choose to sign in with them.</li>
        <li><b>Wikimedia</b> — the Media tab loads articles from Wikinews directly from your
          device, so Wikimedia sees your IP address and which article you opened.</li>
      </ul>
      <p>We do not sell your data or use third-party advertising trackers.</p>

      <h3>Your choices</h3>
      <ul>
        <li>Delete your account and its data at any time (this erases your words, lists, and
          review history). We keep a dated record that a deletion happened, so we can show the
          request was honoured; it does not contain your vocabulary.</li>
        <li><b>Guest profiles are deleted after 30 days of inactivity</b>, along with any words,
          lists and review history they hold. Clearing your browser removes your access to a
          guest profile but not the data itself, and afterwards we have no way to tell the
          profile was yours — the 30-day sweep is what removes it. Create an account if you
          want your vocabulary to persist.</li>
      </ul>
    </>
  );
}

function Terms() {
  return (
    <>
      <h2 className="legal__title">Terms of Service</h2>
      <p>By using DINO you agree to these terms.</p>

      <h3>The service</h3>
      <p>DINO is provided <b>“as is”</b>, without warranties of any kind, for personal,
        non-commercial language learning. It is an early-stage product and may change or be
        unavailable at any time.</p>

      <h3>Your account</h3>
      <p>You're responsible for keeping your password secure and for activity under your account.
        Don't use the service for unlawful purposes, abuse, or to attempt to overload or
        circumvent its limits.</p>

      <h3>Dictionary & data attribution</h3>
      <p>Dictionary content is from <b>JMdict</b>, © the Electronic Dictionary Research and
        Development Group (EDRDG), used under the EDRDG licence. Sense data comes from the
        <b> Japanese WordNet</b> (NICT, Francis Bond et al.) and <b>Princeton WordNet</b>, both
        under BSD-style licences. Word-frequency data is derived from <b>wordfreq</b>
        (CC BY-SA 4.0); level data from the <b>CEFR-J</b> wordlist (© Tono Lab, TUFS) and the
        <b>Octanove</b> vocabulary profile (CC BY-SA 4.0). Media articles come from
        <b> Wikinews</b> (CC BY 2.5) and remain the property of their authors. Full licence
        details are in the app footer and in ATTRIBUTION.md.</p>

      <h3>Limitation of liability</h3>
      <p>To the extent permitted by law, DINO and its authors are not liable for any damages
        arising from use of the service. Translations are machine- and dictionary-generated and
        may be inaccurate.</p>

      <h3>Changes</h3>
      <p>We may update these terms; continued use after a change means you accept it.</p>
    </>
  );
}

/**
 * Support page. Deliberately short and concrete: what the app is, how to reach a
 * human, and the two things a stuck user most often needs (their data, and getting
 * rid of it). Everything here is true of the app as built — no promised features.
 */
function Support() {
  return (
    <>
      <h2 className="legal__title">Support</h2>
      <p>
        DINO is a vocabulary app for learning Japanese and English: translate a word or a
        passage, save what you want to keep, and review it later with flashcards.
      </p>

      <h3>Contact us</h3>
      <p>
        Email <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> and we will get back to
        you. It helps to include what you were doing, the word or text involved, and whether
        you were on the web or the iOS app.
      </p>

      <h3>Common questions</h3>
      <ul>
        <li>
          <b>Do I need an account?</b> No. You can use DINO straight away as a guest. Creating
          an account keeps everything you have already saved — the same profile is upgraded,
          nothing is lost.
        </li>
        <li>
          <b>I forgot my password.</b> Use the “Forgot password?” link on the sign-in page. If
          the email does not arrive, check your spam folder and then write to us.
        </li>
        <li>
          <b>A word is wrong or missing.</b> Tell us the word and what you expected. Our
          dictionary is JMdict, which covers a great deal but not everything; some rarer words
          fall back to machine translation and can be less precise.
        </li>
        <li>
          <b>How do I delete my account?</b> Profile → Delete account. This permanently removes
          your saved words, lists, review history and your login. It cannot be undone.
        </li>
        <li>
          <b>What happens to my data?</b> See the <Link to="/privacy">Privacy Policy</Link>.
        </li>
      </ul>
    </>
  );
}
