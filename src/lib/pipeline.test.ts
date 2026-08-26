import { describe, expect, it } from "vitest";
import { decideSyncAction } from "./pipeline";

// SPEC.md §5: "never blindly overwrite" — a card's content that changed
// outside this app must be caught before any write, not silently clobbered.
describe("decideSyncAction", () => {
  const base = { desiredHash: "desired", confirmedHash: "old-desired" };

  it("does nothing when the local desired state hasn't changed", () => {
    expect(
      decideSyncAction({
        desiredHash: "same",
        confirmedHash: "same",
        remoteBaselineHash: "whatever",
        remoteHash: "different-entirely",
      }),
    ).toBe("noop");
  });

  it("writes straight through on a card that's never been written before", () => {
    expect(
      decideSyncAction({ ...base, remoteBaselineHash: null, remoteHash: undefined }),
    ).toBe("write");
  });

  it("writes when the remote is unchanged since our last confirmed write", () => {
    expect(
      decideSyncAction({ ...base, remoteBaselineHash: "baseline", remoteHash: "baseline" }),
    ).toBe("write");
  });

  it("flags a conflict when the remote drifted from our last confirmed baseline", () => {
    expect(
      decideSyncAction({ ...base, remoteBaselineHash: "baseline", remoteHash: "edited-in-yoto-app" }),
    ).toBe("conflict");
  });

  it("adopts silently (no conflict) when there's no prior baseline to compare against", () => {
    // e.g. a card that existed before this feature shipped (pre-migration).
    expect(
      decideSyncAction({ ...base, remoteBaselineHash: null, remoteHash: "whatever-is-live" }),
    ).toBe("write");
  });

  it("flags card-missing when a previously-written card is gone remotely (404)", () => {
    expect(
      decideSyncAction({ ...base, remoteBaselineHash: "baseline", remoteHash: null }),
    ).toBe("card-missing");
  });
});
