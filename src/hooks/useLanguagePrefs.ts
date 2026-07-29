// The user's language pair — the LEARNING language (what they study) and their
// NATIVE one (the language meanings are explained in) — read from the profile, with
// the registry defaults for a fresh guest who has saved no prefs.
//
// Every surface that opens on a direction needs exactly this (Translate, the Lists
// add form, Learn, calibration), and each had grown its own copy of the same
// getUserProfile → `?? DEFAULT_…` → cast → warn effect. One copy means a change to
// the policy (a new pref, a different failure behaviour) lands everywhere at once.
//
// Failure is non-fatal by design: a profile that won't load leaves the defaults in
// place, so the surface still works rather than blocking on a preference.
import { useEffect, useState } from "react";
import { getUserProfile } from "../services/session";
import {
  DEFAULT_LEARNING_LANGUAGE,
  DEFAULT_NATIVE_LANGUAGE,
  type LangCode,
} from "../services/language";

export interface LanguagePrefs {
  /** The language the user is studying. */
  learning: LangCode;
  /** The language they read meanings in. */
  native: LangCode;
}

/**
 * Map a loaded profile (or null) to the language pair, applying the registry
 * defaults for any pref the user hasn't set. The ONE place the `?? DEFAULT → cast`
 * policy lives, so every surface that opens on a direction agrees — including the
 * ones (calibration) that read the profile alongside other columns and can't use
 * the hook verbatim.
 */
export function profileToLangs(
  p: { learningLanguage: string | null; nativeLanguage: string | null } | null,
): LanguagePrefs {
  return {
    learning: (p?.learningLanguage ?? DEFAULT_LEARNING_LANGUAGE) as LangCode,
    native: (p?.nativeLanguage ?? DEFAULT_NATIVE_LANGUAGE) as LangCode,
  };
}

export function useLanguagePrefs(userId: string): LanguagePrefs {
  const [prefs, setPrefs] = useState<LanguagePrefs>({
    learning: DEFAULT_LEARNING_LANGUAGE,
    native: DEFAULT_NATIVE_LANGUAGE,
  });

  useEffect(() => {
    let live = true;
    getUserProfile(userId)
      .then((p) => {
        if (!live) return; // a user switch superseded this load
        setPrefs(profileToLangs(p));
      })
      .catch((e) => console.warn("useLanguagePrefs: failed to load language prefs", e));
    return () => {
      live = false;
    };
  }, [userId]);

  return prefs;
}
