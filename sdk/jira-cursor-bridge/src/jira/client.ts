export interface JiraClient {
  postComment(issueKey: string, text: string): Promise<void>;
  getLabels(issueKey: string): Promise<string[]>;
}

interface JiraClientOpts {
  baseUrl: string;
  email: string;
  apiToken: string;
  fetchImpl?: typeof fetch;
}

function adfParagraph(text: string) {
  return {
    body: {
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text }],
        },
      ],
    },
  };
}

export function createJiraClient(opts: JiraClientOpts): JiraClient {
  const f = opts.fetchImpl ?? fetch;
  const auth =
    "Basic " +
    Buffer.from(`${opts.email}:${opts.apiToken}`, "utf8").toString("base64");
  const base = opts.baseUrl.replace(/\/+$/, "");

  return {
    async postComment(issueKey, text) {
      const res = await f(`${base}/rest/api/3/issue/${issueKey}/comment`, {
        method: "POST",
        headers: {
          authorization: auth,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(adfParagraph(text)),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Jira comment failed: ${res.status} ${body.slice(0, 200)}`);
      }
    },

    async getLabels(issueKey) {
      const res = await f(
        `${base}/rest/api/3/issue/${issueKey}?fields=labels`,
        {
          headers: { authorization: auth, accept: "application/json" },
        },
      );
      if (!res.ok) {
        throw new Error(`Jira getIssue failed: ${res.status}`);
      }
      const data: any = await res.json();
      return Array.isArray(data?.fields?.labels) ? data.fields.labels : [];
    },
  };
}
