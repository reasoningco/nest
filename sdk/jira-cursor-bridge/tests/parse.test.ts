import { describe, it, expect } from "vitest";
import { detectTrigger } from "../src/webhook/parse.ts";

const base = (overrides: Record<string, unknown> = {}) => ({
  webhookEvent: "jira:issue_updated",
  issue: {
    key: "ABC-1",
    fields: { summary: "Do thing", description: "Some text", labels: [] },
  },
  changelog: { items: [] },
  ...overrides,
});

describe("detectTrigger", () => {
  it("fires when label added matches trigger", () => {
    const t = detectTrigger(
      base({
        changelog: {
          items: [
            { field: "labels", fromString: "", toString: "cursor" },
          ],
        },
      }),
      "cursor",
    );
    expect(t).not.toBeNull();
    expect(t?.issueKey).toBe("ABC-1");
    expect(t?.summary).toBe("Do thing");
  });

  it("ignores label-only-removed events", () => {
    const t = detectTrigger(
      base({
        changelog: {
          items: [
            { field: "labels", fromString: "cursor", toString: "" },
          ],
        },
      }),
      "cursor",
    );
    expect(t).toBeNull();
  });

  it("ignores non-issue_updated events", () => {
    const t = detectTrigger(
      base({
        webhookEvent: "jira:issue_created",
        changelog: {
          items: [{ field: "labels", fromString: "", toString: "cursor" }],
        },
      }),
      "cursor",
    );
    expect(t).toBeNull();
  });

  it("fires once when multiple labels added in one event", () => {
    const t = detectTrigger(
      base({
        changelog: {
          items: [
            {
              field: "labels",
              fromString: "",
              toString: "cursor frontend p1",
            },
          ],
        },
      }),
      "cursor",
    );
    expect(t).not.toBeNull();
  });

  it("ignores unrelated label adds", () => {
    const t = detectTrigger(
      base({
        changelog: {
          items: [
            { field: "labels", fromString: "", toString: "frontend" },
          ],
        },
      }),
      "cursor",
    );
    expect(t).toBeNull();
  });

  it("only counts new labels, not pre-existing", () => {
    const t = detectTrigger(
      base({
        changelog: {
          items: [
            {
              field: "labels",
              fromString: "cursor",
              toString: "cursor frontend",
            },
          ],
        },
      }),
      "cursor",
    );
    expect(t).toBeNull();
  });

  it("flattens ADF description to text", () => {
    const t = detectTrigger(
      base({
        issue: {
          key: "ABC-2",
          fields: {
            summary: "S",
            description: {
              type: "doc",
              version: 1,
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "hello world" }],
                },
              ],
            },
            labels: [],
          },
        },
        changelog: {
          items: [{ field: "labels", fromString: "", toString: "cursor" }],
        },
      }),
      "cursor",
    );
    expect(t?.description).toContain("hello world");
  });
});
