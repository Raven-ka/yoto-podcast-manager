// Stable per-podcast card colour (UI only). Hashing the id rather than
// storing a colour means no migration, and a podcast keeps its colour
// across restarts. Class names map to the .tint-* rules in styles.css.
export const TINTS = ["tint-orange", "tint-sky", "tint-yellow", "tint-green", "tint-pink", "tint-purple"] as const;

export function tintFor(id: string | null | undefined): (typeof TINTS)[number] {
  if (!id) return TINTS[0];
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return TINTS[Math.abs(h) % TINTS.length];
}

// First visible character, for artwork placeholders. Array.from keeps
// surrogate pairs intact.
export function initialOf(title: string | null | undefined): string {
  const ch = Array.from((title ?? "").trim())[0];
  return ch ? ch.toUpperCase() : "?";
}
