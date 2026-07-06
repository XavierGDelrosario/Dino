// A plain text input wired to a string state, with an optional Enter handler.
// Collapses the repeated `<input className="input" value onChange={(e)=>set(e.target.value)}
// onKeyDown={(e)=>e.key==="Enter"&&submit()} … />` boilerplate (auth + add-word forms).
import type { HTMLAttributes } from "react";

export function InputField({
  value,
  onChange,
  onEnter,
  type = "text",
  className = "input",
  ariaLabel,
  placeholder,
  autoComplete,
  autoFocus,
  disabled,
  inputMode,
}: {
  value: string;
  onChange: (value: string) => void;
  /** Called on Enter — for single-field / submit-on-enter forms. */
  onEnter?: () => void;
  type?: "text" | "email" | "password";
  className?: string;
  ariaLabel?: string;
  placeholder?: string;
  autoComplete?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  inputMode?: HTMLAttributes<HTMLInputElement>["inputMode"];
}) {
  return (
    <input
      className={className}
      type={type}
      value={value}
      aria-label={ariaLabel}
      placeholder={placeholder}
      autoComplete={autoComplete}
      autoFocus={autoFocus}
      disabled={disabled}
      inputMode={inputMode}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onEnter ? (e) => e.key === "Enter" && onEnter() : undefined}
    />
  );
}
