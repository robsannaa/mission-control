/**
 * BrandMark — the Mission Control logo (the "Aperture" mark).
 *
 * Three pinwheeling blades: a claw closing, an orchestrator spinning up.
 * Monochrome by design — it draws in `currentColor`, so it inherits the
 * surrounding text colour and inverts cleanly between light and dark with no
 * separate assets. Size it with a className (`h-5 w-5`), colour it with text
 * utilities (`text-foreground`).
 *
 * Single source of truth for the in-app logo (sidebar, onboarding, welcome).
 * The static favicon / PWA icon mirror this shape in src/app/icon.svg and
 * public/icons/icon-192.svg — keep those in sync if the geometry changes.
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 64 64"
      fill="none"
      className={className}
      role="img"
      aria-label="Mission Control"
    >
      <g fill="none" stroke="currentColor" strokeWidth="6" strokeLinecap="round">
        <path d="M32 13 A19 19 0 0 1 48.5 22.5" />
        <path d="M32 13 A19 19 0 0 1 48.5 22.5" transform="rotate(120 32 32)" />
        <path d="M32 13 A19 19 0 0 1 48.5 22.5" transform="rotate(240 32 32)" />
      </g>
    </svg>
  );
}
