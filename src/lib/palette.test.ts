import { describe, expect, it } from "vitest";
import { TINTS, initialOf, tintFor } from "./palette";

describe("tintFor", () => {
  it("is stable for the same id", () => {
    expect(tintFor("abc-123")).toBe(tintFor("abc-123"));
  });
  it("always returns a known tint", () => {
    for (const id of ["", "a", "550e8400-e29b-41d4-a716-446655440000", "x".repeat(500)]) {
      expect(TINTS).toContain(tintFor(id));
    }
  });
  it("falls back for missing ids", () => {
    expect(tintFor(null)).toBe(TINTS[0]);
  });
  it("spreads ids across more than one tint", () => {
    const seen = new Set(Array.from({ length: 50 }, (_, i) => tintFor(`id-${i}`)));
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe("initialOf", () => {
  it("uppercases the first letter", () => {
    expect(initialOf("  story time")).toBe("S");
  });
  it("handles Hebrew", () => {
    expect(initialOf("סיפורים")).toBe("ס");
  });
  it("falls back for empty titles", () => {
    expect(initialOf("")).toBe("?");
    expect(initialOf(undefined)).toBe("?");
  });
});
