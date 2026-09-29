// Edrion publisher branding (approved assets in src/assets/brand/, recoloured
// to fill="currentColor" so they follow the theme's text colour in dark mode).
// Inlined rather than <img> because an <img> can't inherit currentColor.
import wordmark from "../assets/brand/edrion-wordmark.svg?raw";
import lockup from "../assets/brand/edrion-lockup.svg?raw";

export function EdrionWordmark({ className }: { className?: string }) {
  return (
    <span
      className={"brand-svg " + (className ?? "")}
      role="img"
      aria-label="Edrion"
      dangerouslySetInnerHTML={{ __html: wordmark }}
    />
  );
}

export function EdrionLockup({ className }: { className?: string }) {
  return (
    <span
      className={"brand-svg " + (className ?? "")}
      role="img"
      aria-label="Edrion"
      dangerouslySetInnerHTML={{ __html: lockup }}
    />
  );
}
