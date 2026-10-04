// The current Terms-of-Service / Privacy-Policy version. Bump this (use the
// publication date) whenever the legal docs in LegalView change. Accounts whose
// stored `terms_version` is behind this value agreed to an older version and can
// be re-prompted to accept. Recorded on signup via session.recordTermsAgreement.
//
// Versions are ISO dates, so they ORDER as strings — and the comparison must be an
// ordering, never equality. Clients on different builds coexist (an installed iOS app
// lags the web deploy), each with its own CURRENT_TERMS_VERSION; with `!==` the older
// build read the newer stamp as "not accepted", re-prompted, and wrote its OLDER
// version back, which made the newer build prompt again — a loop between a phone and
// a browser on the same account (seen on prod, 2026-10-05).
export const CURRENT_TERMS_VERSION = "2026-10-05";

/** Has `accepted` (a stored terms_version, or none) fallen behind this build's terms? */
export function termsOutdated(accepted: string | null | undefined): boolean {
  return !accepted || accepted < CURRENT_TERMS_VERSION;
}
