import { describe, expect, it } from "vitest";
import { assignFeatureKey, featureSource } from "../src/lib/grouping";

describe("assignFeatureKey priority order", () => {
  it("prefers Jira key in commit message over PR", () => {
    const key = assignFeatureKey({
      repoOwner: "acme",
      repoName: "backend",
      commitMessage: "PAY-412 implement offline retry",
      prNumber: 77,
      prTitle: "Offline retry",
      branchName: "feat/offline",
      defaultBranch: "main",
    });
    expect(key).toBe("PAY-412");
  });

  it("prefers Jira key found in PR title when commit has none", () => {
    expect(
      assignFeatureKey({
        repoOwner: "acme",
        repoName: "backend",
        commitMessage: "tidy up error handling",
        prTitle: "MOB-9 unify error toasts",
        prNumber: 18,
      }),
    ).toBe("MOB-9");
  });

  it("prefers Jira key in branch name when nothing else has one", () => {
    expect(
      assignFeatureKey({
        repoOwner: "acme",
        repoName: "backend",
        commitMessage: "wip",
        branchName: "feature/WEB-201-cart",
        defaultBranch: "main",
      }),
    ).toBe("WEB-201");
  });

  it("falls back to PR key when no Jira reference", () => {
    expect(
      assignFeatureKey({
        repoOwner: "acme",
        repoName: "backend",
        commitMessage: "fix regression",
        prNumber: 42,
        prTitle: "Fix cart regression",
      }),
    ).toBe("pr:acme/backend:42");
  });

  it("falls back to branch key for commits on a non-default branch with no PR", () => {
    expect(
      assignFeatureKey({
        repoOwner: "acme",
        repoName: "backend",
        commitMessage: "explore caching layer",
        branchName: "spike/cache",
        defaultBranch: "main",
      }),
    ).toBe("branch:acme/backend:spike/cache");
  });

  it("returns null for a direct commit to the default branch with no key", () => {
    expect(
      assignFeatureKey({
        repoOwner: "acme",
        repoName: "backend",
        commitMessage: "bump version",
        branchName: "main",
        defaultBranch: "main",
      }),
    ).toBeNull();
  });

  it("treats 'master' as a default-style branch", () => {
    expect(
      assignFeatureKey({
        repoOwner: "acme",
        repoName: "backend",
        commitMessage: "bump version",
        branchName: "master",
        defaultBranch: "master",
      }),
    ).toBeNull();
  });

  it("does not match lowercase fake keys like bug-12", () => {
    expect(
      assignFeatureKey({
        repoOwner: "acme",
        repoName: "backend",
        commitMessage: "fix bug-12 handling",
        branchName: "main",
        defaultBranch: "main",
      }),
    ).toBeNull();
  });
});

describe("featureSource", () => {
  it("classifies prefixes", () => {
    expect(featureSource("PAY-1")).toBe("jira");
    expect(featureSource("pr:acme/backend:10")).toBe("pr");
    expect(featureSource("branch:acme/backend:feat/x")).toBe("branch");
  });
});
