# App Store submission — paste sheet

Everything below is **App Store Connect console work**, not code: there is no App
Store Connect key in this repo (only Supabase / Cloudflare / Google / SMTP), and the
app record has to exist there first. So this is written to be pasted field by field.

Two things are **declarations you are making**, not facts about the code — the
privacy labels (§2) and the age rating (§3). The reasoning for each is in §7; read
that once, then paste.

Character limits are noted where Apple enforces them; the values below are inside them.

---

## 1. App information

| Field | Paste |
|---|---|
| Name (≤30) | `DINO — Japanese Vocabulary` |
| Subtitle (≤30) | `Translate, save, review words` |
| Primary category | `Education` |
| Secondary category | `Reference` |
| Support URL | `https://<domain>/support` |
| Privacy Policy URL | `https://<domain>/privacy` |
| Marketing URL | *(leave blank)* |
| Copyright | `2026 <your legal name or company>` |

`<domain>` is `dino-86y.pages.dev` today; swap once the custom domain lands
(`docs/TODO.md`). Both pages exist and are footer-linked.

**Keywords** (≤100 chars, commas, no spaces — this is 95):

```
japanese,english,vocabulary,jlpt,kanji,furigana,flashcards,srs,dictionary,translate,study,words
```

**Promotional text** (≤170):

```
Look up a word or a whole passage, save what you want to keep, and review it later. Readings, meanings and JLPT levels from a full Japanese dictionary.
```

**Description:**

```
DINO turns the Japanese you actually read into vocabulary you actually remember.

Translate a word or paste a whole passage. Every word is broken out with its reading
and meaning, coloured by how well you know it, so you can see at a glance what is new
and what is coming back. Tap any word to save it.

WHAT YOU GET
• A full Japanese dictionary — readings, multiple meanings, and the right sense for
  the word in front of you, not just the first one.
• Word-by-word reading of anything you paste, with furigana.
• Sentence translation on demand, so you only ask for English where you need it.
• Spaced-repetition review that schedules words by how well you actually recall them.
• Lists for organising what you save, with search, filters and a level breakdown.
• JLPT and CEFR level labels where the data has them.
• Camera and handwriting input for words you can see but cannot type.

ENGLISH LEARNERS TOO
DINO works in both directions. Set your learning language to English and the same
tools work on English text, with Japanese explanations.

NO ACCOUNT NEEDED
Start using it immediately. If you later create an account, everything you already
saved carries over — nothing is lost.
```

**What's New (first release):**

```
First release.
```

## 2. App Privacy

Must match `ios/App/App/PrivacyInfo.xcprivacy` — Apple compares them, and a mismatch
is a rejection. Change one, change the other.

**Does this app collect data? → Yes**

Add exactly two data types:

| Data type | Linked to the user | Used for tracking | Purpose |
|---|---|---|---|
| Contact Info → Email Address | **Yes** | **No** | App Functionality |
| User Content → Other User Content | **Yes** | **No** | App Functionality |

Everything else: **not collected**.

## 3. Age rating questionnaire

| Question | Answer |
|---|---|
| Cartoon or Fantasy Violence | None |
| Realistic Violence | None |
| Prolonged Graphic or Sadistic Realistic Violence | None |
| Profanity or Crude Humor | **Infrequent/Mild** |
| Mature/Suggestive Themes | None |
| Horror/Fear Themes | None |
| Medical/Treatment Information | None |
| Alcohol, Tobacco, or Drug Use or References | None |
| Simulated Gambling | None |
| Sexual Content or Nudity | None |
| Graphic Sexual Content and Nudity | None |
| Unrestricted Web Access | **No** |
| Gambling and Contests | None |
| User-Generated Content | **No** |

## 4. Export compliance

Already answered in code — `ITSAppUsesNonExemptEncryption = false` in `Info.plist`,
so Xcode stops asking on every upload. DINO's only cryptography is standard HTTPS/TLS,
which is exempt. Nothing to fill in.

## 5. Review notes (paste into "Notes")

```
No sign-in is required to review the app: it opens directly into a working guest
profile, so you can translate a word and save it immediately.

To try the main flow: on the Translate tab, paste or type Japanese text (for example
猫が好きです。) and press Translate. Each word becomes tappable — tap one to see its
meanings and save it. Saved words appear under Lists and can be reviewed as
flashcards under Review.

Account deletion is available in-app at Profile → Delete account. It permanently
removes the account, its saved data and the login itself.

Dictionary content comes from JMdict (EDRDG), a complete Japanese-English dictionary;
looking up a vulgar word will return its definition, which is why the age rating
declares mild profanity.
```

## 6. Before you submit

- [ ] Enable **Sign in with Apple** in Supabase (Services ID + .p8-signed secret,
      `config.toml [auth.external.apple]`). Mandatory because Google sign-in is
      offered — `linkApple`/`signInWithApple` are already implemented.
- [ ] Custom domain, so the support/privacy URLs and auth email are not on
      `pages.dev`.
- [ ] Screenshots — **6.9" iPhone `1320 × 2868`** (also accepted: 1290 × 2796, 1260 × 2736).
      Apple scales that one set down for every smaller iPhone, so it is the only iPhone
      slot to fill. The old "6.7" **and** 5.5"" pair is retired — 5.5" (iPhone 8 Plus)
      is gone. sRGB PNG/JPEG, **no alpha**, 1–10 per tier. Separately: a 1024px icon,
      also no alpha and no pre-rounded corners.
      - ⚠️ A phone screenshot only passes if the phone IS a Pro Max. A 6.1" iPhone
        captures at 1179 × 2556 and App Store Connect refuses it. Otherwise capture the
        same build from the Simulator: `xcrun simctl io booted screenshot shot.png`.
      - ‼️ **The target is `TARGETED_DEVICE_FAMILY = "1,2"` — iPhone AND iPad.** That
        obliges a 13" iPad set (`2064 × 2752`) too, and review will run the app on an
        iPad. Nobody has ever run DINO on one. Decide before submitting: produce the
        iPad shots and test the layout, or set the family to `"1"` and ship
        iPhone-only for v1 (the lower-risk call).
      - Screenshot the analysis / word-table views rather than a screen of Wikinews
        prose: that text is CC BY 2.5, and attribution follows it into marketing.
- [ ] Signing certificate + provisioning profile, then a TestFlight build.
- [ ] **Run the live listener on a real device.** It compiles and is unit-covered but
      nobody has spoken at a phone yet — if it does not hold up, cut the feature from
      the build rather than shipping it broken.

## 7. Why those answers

- **Email** is collected only when a user chooses an account; a guest never provides
  one. **Other User Content** is the saved vocabulary and review history — the product.
- **Tracking is No everywhere**: no ad SDK, no data broker, no identifier joined with
  third-party data.
- **Not collected, deliberately**: microphone audio, photos and handwriting are
  processed on device and never uploaded; text sent for translation is not stored
  (`persist: false`).
- **Profanity → Infrequent/Mild** because JMdict is a complete dictionary and will
  define vulgar words on request. Understating this is the sort of thing that
  surfaces awkwardly later.
- **Unrestricted Web Access → No**, verified in code: external links are plain
  `target="_blank"` anchors and Capacitor hands off-host navigation to the *system*
  browser; the only in-app browser use is a fixed OAuth provider URL. **If articles
  ever open in an embedded web view this becomes Yes and forces 17+.**
- **User-Generated Content → No**: saved words are private to the account; nothing is
  shared between users.
- Re-check §2 whenever a feature starts sending something new — the planned LLM
  features would add a collected type.
