import { describe, expect, it } from "vitest";
import {
  countedCommitLoc,
  isMergeLikeCommitTitle,
  shouldCountCommitLoc,
} from "../src/lib/commit-loc";

describe("commit LOC counting", () => {
  it("counts normal commit stats", () => {
    expect(
      countedCommitLoc({
        title: "Add shift trade request form",
        metadata: JSON.stringify({ additions: 120, deletions: 8 }),
      }),
    ).toEqual({ additions: 120, deletions: 8 });
  });

  it("ignores merge-like commits", () => {
    const titles = [
      "Merge pull request #106 from reasoningco/vendor-bidding-system",
      "Merge origin/main into migrate/sched",
      "Merge branch 'main' into feature/employee-trade-request",
      "Merge remote-tracking branch 'origin/main' into cody-fixes",
      "merge main into vendor-bidding-system",
      "merge: resolve conflicts with remote, accept remote changes",
    ];

    for (const title of titles) {
      expect(isMergeLikeCommitTitle(title)).toBe(true);
      expect(
        countedCommitLoc({
          title,
          metadata: JSON.stringify({ additions: 35_000, deletions: 900 }),
        }),
      ).toBeNull();
    }
  });

  it("ignores commits known to have multiple parents", () => {
    expect(
      shouldCountCommitLoc({
        title: "Resolve scheduler conflict",
        metadata: { additions: 35_000, deletions: 900, parentCount: 2 },
      }),
    ).toBe(false);
  });

  it("does not reject normal titles that mention merge in prose", () => {
    expect(isMergeLikeCommitTitle("Explain merge flow in docs")).toBe(false);
  });
});
