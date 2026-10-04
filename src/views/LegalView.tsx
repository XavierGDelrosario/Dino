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

const UPDATED = "2026-10-04";

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
      <p>DINO is a vocabulary-learning app. This explains what we store, why, and who it's
        shared with.</p>

      <h3>Who we are</h3>
      <p>DINO is operated by Xavier Del Rosario, an individual developer based in British
        Columbia, Canada, who is responsible for the personal information described here. For
        anything in this policy — questions, or a request about your data — email{" "}
        <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>. A postal address is available
        on request.</p>

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
        <li><b>Local storage</b> — your session, UI-language and theme choices, and a short
          cache of browsed headlines are kept in your browser. We set no advertising or
          analytics cookies.</li>
      </ul>
      <p>Our hosting providers also keep ordinary server logs, which include your IP address.</p>

      <h3>Why we use it</h3>
      <ul>
        <li>To provide the service: sign you in, keep your vocabulary, and schedule reviews.</li>
        <li>To enforce free-tier limits and protect the service from abuse.</li>
        <li>To find and fix errors.</li>
        <li>To send account email (sign-up confirmation, password reset). We send no marketing
          email.</li>
        <li>To comply with the law.</li>
      </ul>
      <p>We don't use your data for advertising or profiling, and we don't use it for any other
        purpose without telling you first.</p>

      <h3>Photos, microphone and handwriting</h3>
      <p>In the iOS app, photos, camera images, microphone audio and handwriting are turned into
        text <b>on your device</b> and are never uploaded. Only the resulting text is looked up,
        and only if you ask for it.</p>
      <p>In a web browser, the live transcript uses your browser's built-in speech recognition.
        Some browsers (including Chrome) send the audio to their own servers — Google's, for
        Chrome — to do this. We never receive or store the audio.</p>

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
        <li><b>Wikimedia</b> — the Articles section loads articles from Wikinews directly from
          your device, so Wikimedia sees your IP address and which article you opened.</li>
      </ul>
      <p>We do not sell your data or use third-party advertising trackers. We may disclose
        information where the law requires it.</p>

      <h3>Where it's stored</h3>
      <p>Our database is hosted in Singapore. The other providers above may process data in
        other countries, including the United States and the European Union, so your data may
        leave the country you live in.</p>

      <h3>How long we keep it</h3>
      <ul>
        <li><b>Account data</b> — until you delete your account.</li>
        <li><b>Guest data</b> — until 30 days of inactivity (see “Your choices”).</li>
        <li><b>Usage metering</b> — kept per calendar month.</li>
        <li><b>Error logs</b> — kept for debugging; they are not currently deleted on a fixed
          schedule.</li>
        <li><b>Backups</b> — deleted data may remain in backups for a period afterwards.</li>
      </ul>

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
        <li><b>Access and correction</b> — you can ask what personal data we hold about you,
          and ask us to correct it, delete it, or stop using it, by emailing{" "}
          <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>. We may need to confirm the
          request comes from you. Depending on where you live you may also have the right to
          complain to your local data-protection authority.</li>
      </ul>

      <h3>Children</h3>
      <p>DINO is not intended for children under 13 (or the higher age your country requires
        to consent to data processing). We don't knowingly collect their data; if you believe
        a child has given us personal data, email us and we will delete it.</p>

      <h3>Security</h3>
      <p>Data is encrypted in transit, and database access rules limit each account to its own
        data. No system is perfectly secure; if a breach affects your data we will notify you
        as the law requires.</p>

      <h3>Changes to this policy</h3>
      <p>We'll update the date below when this policy changes, and tell you in the app when a
        change is significant.</p>
    </>
  );
}

function Terms() {
  return (
    <>
      <h2 className="legal__title">Terms of Service</h2>
      <p>By using DINO you agree to these terms. If you don't agree, don't use the service.</p>

      <h3>The service</h3>
      <p>DINO is a vocabulary-learning app, offered on the web and as an iOS app, for personal,
        non-commercial language learning. It is an early-stage product: features, limits and
        availability may change, be interrupted, or be withdrawn at any time, and we are not
        obliged to keep any particular feature running.</p>
      <p>DINO is currently free. If paid features are introduced, their price and terms will
        be shown to you before you buy.</p>

      <h3>Who can use it</h3>
      <p>You must be at least 13 (or the higher age your country requires to consent to an
        online service). If you are under the age of majority where you live, use DINO only
        with a parent's or guardian's consent.</p>

      <h3>Your account</h3>
      <p>You can use DINO as a guest or create an account. You're responsible for keeping your
        password secure and for activity under your account; tell us promptly if you think
        someone else has access. You can delete your account at any time from your profile.</p>

      <h3>Acceptable use</h3>
      <p>Don't:</p>
      <ul>
        <li>use the service for anything unlawful, or to harass or harm others;</li>
        <li>access it with bots or scripts, scrape it, or extract its content in bulk;</li>
        <li>overload it, or circumvent its usage limits or security — including by creating
          multiple accounts or guest profiles to get around a limit;</li>
        <li>resell the service or use it to build a competing product;</li>
        <li>reverse-engineer it, except where the law allows that regardless of these terms.</li>
      </ul>

      <h3>Your content</h3>
      <p>The words, lists, meanings and notes you add remain yours. You give us permission to
        store and process them only as needed to run the service for you. Don't add content
        that is unlawful or that you have no right to use. If you send us feedback or a word
        report, we may use it to improve DINO without owing you anything.</p>

      <h3>Our content</h3>
      <p>The DINO app, its design and its name belong to its operator. The open data it is
        built on stays under its own licences, described next; nothing in these terms
        restricts rights those licences give you.</p>

      <h3>Dictionary & data attribution</h3>
      <p>Dictionary content is from <b>JMdict</b>, © the Electronic Dictionary Research and
        Development Group (EDRDG), used under the EDRDG licence. Sense data comes from the
        <b> Japanese WordNet</b> (NICT, Francis Bond et al.) and <b>Princeton WordNet</b>, both
        under BSD-style licences. Word-frequency data is derived from <b>wordfreq</b>
        (CC BY-SA 4.0); level data from the <b>CEFR-J</b> wordlist (© Tono Lab, TUFS) and the
        <b>Octanove</b> vocabulary profile (CC BY-SA 4.0). Media articles come from
        <b> Wikinews</b> (CC BY 2.5) and remain the property of their authors. Full licence
        details are in the app footer and in ATTRIBUTION.md.</p>

      <h3>Third-party services and content</h3>
      <p>DINO relies on third parties (hosting, sign-in, machine translation, the App Store,
        Wikimedia). Their own terms apply to their part, and we aren't responsible for their
        outages or changes. Articles are loaded from Wikinews and may change or disappear.</p>
      <p>If you believe something in DINO infringes your rights, email{" "}
        <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> with enough detail for us to
        find it, and we will review it.</p>

      <h3>A learning aid, not a guarantee</h3>
      <p>Meanings, readings, translations, example sentences and difficulty levels are
        dictionary-, machine- or statistically-generated and <b>may be wrong or incomplete</b>.
        Levels (such as JLPT or CEFR bands) are estimates, not official classifications. DINO
        is not a substitute for formal instruction or professional translation; don't rely on
        it for legal, medical or safety-critical communication. We make no promise about
        fluency or exam results.</p>

      <h3>Ending or suspending use</h3>
      <p>You may stop using DINO at any time. We may suspend or end access for an account that
        breaks these terms or puts the service or other users at risk. Guest profiles are
        removed after 30 days of inactivity, as described in the{" "}
        <Link to="/privacy">Privacy Policy</Link>.</p>

      <h3>No warranty</h3>
      <p>DINO is provided <b>“as is”</b> and <b>“as available”</b>, without warranties of any
        kind. We try to keep your data safe, but we don't guarantee it will never be lost —
        keep your own copy of anything you can't afford to lose.</p>

      <h3>Limitation of liability</h3>
      <p>We are not liable for damages arising from your use of, or inability to use, the
        service, <b>except</b> where they are caused by our intentional misconduct or gross
        negligence. Where we are liable because of ordinary negligence, our liability is
        limited to direct and ordinary damages you actually suffered, up to the greater of the
        amount you paid us in the 12 months before the claim or C$100. Nothing in these terms
        limits rights you have under consumer-protection law that cannot be waived.</p>

      <h3>iOS app</h3>
      <p>These terms are between you and DINO's operator, not Apple. Apple is not responsible
        for the app, its content, or its support, and Apple's App Store terms also apply to
        your use of the iOS app.</p>

      <h3>Governing law</h3>
      <p>These terms are governed by the laws of the Province of British Columbia and the
        federal laws of Canada applicable therein. Disputes go to the courts of British
        Columbia, unless the consumer-protection law of the country you live in gives you the right to
        bring them elsewhere. Please contact us first — most problems can be settled by
        email.</p>

      <h3>General</h3>
      <p>If part of these terms is found unenforceable, the rest still applies. Our not
        enforcing a term is not a waiver of it.</p>

      <h3>Changes</h3>
      <p>We may update these terms. We'll change the date below, and when a change is
        significant, accounts are asked to accept the new version in the app. Continued use
        after a change means you accept it.</p>

      <h3>Contact</h3>
      <p>Questions about these terms: <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.</p>
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
