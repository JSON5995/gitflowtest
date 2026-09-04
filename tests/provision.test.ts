import { describe, expect, it } from "vitest";
import { provisionRepository } from "../src/provision.js";
import type { GitHubApi } from "../src/github.js";

type Call = { route: string; parameters: Record<string, unknown> };

const apiFor = (calls: Call[], mergeSetup = true): GitHubApi => ({
  request: async (route, parameters) => {
    calls.push({ route, parameters });
    if (route === "GET /repos/{owner}/{repo}") return { data: { default_branch: "main" } };
    if (route === "GET /repos/{owner}/{repo}/git/ref/heads/{ref}") return { data: { object: { sha: "base-sha" } } };
    if (route === "GET /repos/{owner}/{repo}/git/commits/{commit_sha}") return { data: { tree: { sha: "base-tree" } } };
    if (route === "POST /repos/{owner}/{repo}/git/trees") return { data: { sha: "new-tree" } };
    if (route === "POST /repos/{owner}/{repo}/git/commits") return { data: { sha: "new-commit" } };
    if (route === "GET /repos/{owner}/{repo}/pulls") return { data: [] };
    if (route === "POST /repos/{owner}/{repo}/pulls") {
      return { data: { number: 7, html_url: "https://github.test/acme/store/pull/7" } };
    }
    if (route === "PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge") {
      return { data: mergeSetup ? { merged: true, sha: "merge-commit" } : { merged: false } };
    }
    if (route === "GET /repos/{owner}/{repo}/contents/{path}") {
      if (parameters.path === "AGENTS.md") {
        return { data: { type: "file", content: Buffer.from("# Existing rules\n").toString("base64") } };
      }
      throw Object.assign(new Error("not found"), { status: 404 });
    }
    if (route === "GET /repos/{owner}/{repo}/actions/secrets/public-key") {
      return { data: { key: "public-key", key_id: "key-1" } };
    }
    if (route === "PATCH /repos/{owner}/{repo}/actions/variables/{name}") {
      throw Object.assign(new Error("not found"), { status: 404 });
    }
    if (route === "POST /repos/{owner}/{repo}/labels") {
      if (parameters.name === "flow:ready") throw Object.assign(new Error("exists"), { status: 422 });
      return { data: {} };
    }
    if (route === "GET /repos/{owner}/{repo}/rulesets") return { data: [] };
    return { data: {} };
  },
});

describe("repository provisioning", () => {
  it("atomically installs the kit, credentials, labels, and merge gate", async () => {
    const calls: Call[] = [];
    const result = await provisionRepository({
      repository: "acme/store",
      api: apiFor(calls),
      files: {
        "AGENTS.md": "# Agent instructions\n\nRead and follow `.flow/AI_RULES.md`.\n",
        ".flow/config.json": "{}\n",
        ".github/CODEOWNERS": "# BEGIN Flow AI required human reviewers\n* {{FLOW_CODEOWNERS}}\n# END Flow AI required human reviewers\n",
        ".github/workflows/flow-build.yml": "name: build\n",
      },
      secrets: { OPENAI_API_KEY: "openai-secret", ANTHROPIC_API_KEY: "anthropic-secret" },
      variables: { FLOW_BUILDER: "codex", FLOW_BOT_LOGIN: "flow-ai[bot]" },
      codeowners: ["@acme/platform"],
      checkIntegrationId: 42,
      encryptSecret: async (value, key) => `encrypted:${key}:${value.length}`,
    });

    expect(result).toEqual({
      defaultBranch: "main",
      commitSha: "merge-commit",
      setupPullRequestUrl: "https://github.test/acme/store/pull/7",
      mergeGateInstalled: true,
    });
    const tree = calls.find((call) => call.route === "POST /repos/{owner}/{repo}/git/trees");
    const entries = tree?.parameters.tree as Array<{ path: string; content: string }>;
    expect(entries.find((entry) => entry.path === "AGENTS.md")?.content).toContain("# Existing rules");
    expect(entries.find((entry) => entry.path === "AGENTS.md")?.content).toContain(".flow/AI_RULES.md");
    expect(entries.find((entry) => entry.path === ".github/CODEOWNERS")?.content).toContain("* @acme/platform");
    expect(entries.find((entry) => entry.path === ".github/CODEOWNERS")?.content).not.toContain("{{FLOW_CODEOWNERS}}");
    expect(calls.find((call) => call.route === "POST /repos/{owner}/{repo}/git/refs")?.parameters).toMatchObject({
      ref: "refs/heads/flow/setup",
      sha: "new-commit",
    });
    expect(calls.some((call) => call.route === "PATCH /repos/{owner}/{repo}/git/refs/heads/{ref}" && call.parameters.ref === "main")).toBe(false);
    const secretCalls = calls.filter((call) => call.route === "PUT /repos/{owner}/{repo}/actions/secrets/{secret_name}");
    expect(secretCalls).toHaveLength(2);
    expect(secretCalls.map((call) => call.parameters.encrypted_value)).not.toContain("openai-secret");
    expect(calls.filter((call) => call.route === "POST /repos/{owner}/{repo}/actions/variables")).toHaveLength(2);
    const ruleset = calls.find((call) => call.route === "POST /repos/{owner}/{repo}/rulesets");
    expect(JSON.stringify(ruleset?.parameters)).toContain("ai-review");
    expect(JSON.stringify(ruleset?.parameters)).toContain("required_approving_review_count");
    expect(JSON.stringify(ruleset?.parameters)).toContain('"require_code_owner_review":true');
    expect(JSON.stringify(ruleset?.parameters)).toContain('"integration_id":42');
    expect(calls.find((call) => call.route === "PUT /repos/{owner}/{repo}/actions/permissions/workflow")?.parameters)
      .toMatchObject({ default_workflow_permissions: "read", can_approve_pull_request_reviews: false });
  });

  it("leaves the merge gate off until a protected setup pull request is merged", async () => {
    const calls: Call[] = [];
    const result = await provisionRepository({
      repository: "acme/store",
      api: apiFor(calls, false),
      files: { ".github/workflows/flow-build.yml": "name: build\n" },
      secrets: {},
      variables: {},
      codeowners: ["@acme/platform"],
      checkIntegrationId: 42,
      encryptSecret: async (value) => value,
    });

    expect(result.mergeGateInstalled).toBe(false);
    expect(result.setupPullRequestUrl).toContain("/pull/7");
    expect(calls.some((call) => call.route.includes("/rulesets"))).toBe(false);
  });
});
