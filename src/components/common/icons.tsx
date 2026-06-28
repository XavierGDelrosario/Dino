// =========================================================
// Generic line-style icons (no emoji) for a consistent set across the app: the
// input-modality toolbar (pencil / mic / stop) and the header menus (globe /
// profile). Feather-style, 24×24, monochrome via currentColor so they inherit the
// button's text colour (incl. the recording-red and hover states). Mark
// aria-hidden — every caller already supplies an aria-label on the button.
// =========================================================
import type { ReactNode } from "react";

function Svg({
  size = 20,
  filled = false,
  children,
}: {
  size?: number;
  filled?: boolean;
  children: ReactNode;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke={filled ? "none" : "currentColor"}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export function PencilIcon({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
    </Svg>
  );
}

export function MicIcon({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
      <path d="M19 10v1a7 7 0 0 1-14 0v-1" />
      <line x1="12" y1="18" x2="12" y2="22" />
      <line x1="8" y1="22" x2="16" y2="22" />
    </Svg>
  );
}

/** Filled square — the conventional "stop recording" glyph. */
export function StopIcon({ size }: { size?: number }) {
  return (
    <Svg size={size} filled>
      <rect x="5" y="5" width="14" height="14" rx="3" />
    </Svg>
  );
}

export function XIcon({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </Svg>
  );
}

export function CameraIcon({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
      <circle cx="12" cy="13" r="4" />
    </Svg>
  );
}
