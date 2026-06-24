// Client-side password policy — mirrors the server enforcement in supabase
// config.toml ([auth] minimum_password_length + password_requirements
// "letters_digits"). The server is the real gate; this gives instant UX feedback
// and a clear message before the round-trip. Returns a reason code (i18n'd by the
// caller) or null when the password is acceptable.
export const MIN_PASSWORD_LENGTH = 8;

export type PasswordIssue = "short" | "weak";

export function checkPassword(pw: string): PasswordIssue | null {
  if (pw.length < MIN_PASSWORD_LENGTH) return "short";
  if (!/[a-zA-Z]/.test(pw) || !/[0-9]/.test(pw)) return "weak"; // needs letters AND digits
  return null;
}
