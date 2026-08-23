// Per-field text-direction handling (SPEC.md §10).
// Hebrew metadata renders RTL without flipping the app chrome:
// render user content with dir={detectDirection(text)} or dir="auto".

const RTL_CHARS = /[֐-׿؀-ۿ܀-ݏࢠ-ࣿיִ-﷿ﹰ-﻿]/;

export function detectDirection(text: string | undefined | null): "rtl" | "ltr" {
  if (!text) return "ltr";
  // First strongly-directional character wins (matches dir="auto" semantics).
  for (const ch of text) {
    if (RTL_CHARS.test(ch)) return "rtl";
    if (/[A-Za-z]/.test(ch)) return "ltr";
  }
  return "ltr";
}
