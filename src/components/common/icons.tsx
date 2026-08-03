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

/** Back — a bare chevron. The arrow-with-shaft version read as a heavy action
 *  button; navigation should sit quietly at the edge of the bar. */
export function BackIcon({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <polyline points="15 18 9 12 15 6" />
    </Svg>
  );
}

/** Delete / remove. Replaces the wastebasket emoji (U+1F5D1), whose DEFAULT
 *  presentation is TEXT, not emoji — so without a variation selector the browser hunts
 *  for it in a text font, and text fonts don't carry it. It rendered as a "1F5D1" hex
 *  box for a real user. An SVG can't miss. (Guarded by tests/components/no-text-default-emoji.) */
export function TrashIcon({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6M14 11v6" />
      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    </Svg>
  );
}

/** Funnel — the conventional "filter" glyph. */
export function FilterIcon({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
    </Svg>
  );
}

/** Two vertical arrows — a sort-direction toggle (least ⇅ most). */
export function SwapVertIcon({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <polyline points="7 4 7 20" />
      <polyline points="4 7 7 4 10 7" />
      <polyline points="17 20 17 4" />
      <polyline points="14 17 17 20 20 17" />
    </Svg>
  );
}

/** Magnifying glass — the conventional "search" glyph (Lists search bar). */
export function SearchIcon({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <circle cx="11" cy="11" r="7" />
      <line x1="16.5" y1="16.5" x2="21" y2="21" />
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

/** Read aloud (text-to-speech). The waves are separate paths so a "speaking"
 *  state can animate them without touching the cone. */
export function SpeakerIcon({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <path d="M11 5 6 9H2v6h4l5 4z" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7" />
      <path d="M18.5 5.5a9 9 0 0 1 0 13" />
    </Svg>
  );
}

/** History — the clock-with-a-rewind-arrow Google Translate uses for "recent".
 *  The arc deliberately stops short of closing at the upper LEFT, where the arrow
 *  head sits: a full circle plus hands reads as a plain clock (i.e. "time"), and
 *  the break is the whole reason this says "go back to" instead. */
export function HistoryIcon({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      {/* Open arc, counter-clockwise from ~10 o'clock all the way round. */}
      <path d="M3.5 9.5a9 9 0 1 0 2.6-3.9" />
      {/* Rewind arrow head closing the gap. */}
      <polyline points="3 4 3 9.5 8.5 9.5" />
      {/* Hands: 12 and 3, the conventional clock reading. */}
      <polyline points="12 7.5 12 12 15.5 13.8" />
    </Svg>
  );
}
