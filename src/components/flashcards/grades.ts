// Shared confidence-grade constants for the flashcard + text-quiz grade buttons.
// One definition so the two surfaces can't drift. GRADE_KEY maps each grade to its
// i18n label key (compile-checked as MessageKey).
import type { ReviewGrade } from "../../services/review";
import type { MessageKey } from "../../i18n";

export const GRADES: ReviewGrade[] = [1, 2, 3, 4, 5];

export const GRADE_KEY: Record<ReviewGrade, MessageKey> = {
  1: "review.grade1",
  2: "review.grade2",
  3: "review.grade3",
  4: "review.grade4",
  5: "review.grade5",
};
