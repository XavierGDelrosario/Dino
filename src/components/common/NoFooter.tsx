// Marks a STUDY surface — Translate, Review, any quiz — where the legal/credits footer
// (rendered once by the app shell) would only be noise under the work. The shell hides
// its footer while one of these is mounted (`main:has([data-no-footer])` in common.css),
// so a view opts out by rendering this, with no state threaded up through the tabs.
// The footer stays on Lists, Learn and every page, which is where a guest finds the
// Privacy / Terms / Support links.
export function NoFooter() {
  return <span hidden data-no-footer />;
}
