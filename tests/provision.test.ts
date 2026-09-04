import { describe, expect, it } from "vitest";
import { provisionRepository, verifyInstalledRepositoryKit } from "../src/provision.js";
import type { GitHubApi } from "../src/github.js";

type Call = { route: string; parameters: Record<string, unknown> };

const trustedKit = {
  ".cursor/rules/flow.mdc": "trusted cursor rules\n",
  ".flow/AI_RULES.md": "trusted rules\n",
  ".flow/config.json": "{}\n",
  ".flow/qa.json": "{}\n",
  ".flow/review-schema.json": "{}\n",
  ".github/CODEOWNERS": "# BEGIN Flow AI required human reviewers\n* @acme/platform\n# END Flow AI required human reviewers\n",
  ".github/workflows/flow-build.yml": "trusted build\n",
  ".github/workflows/flow-ci.yml": "trusted ci\n",
  ".github/workflows/flow-qa.yml": "trusted qa\n",
  ".github/workflows/flow-review.yml": "trusted review\n",
  "scripts/check-review.mjs": "trusted check\n",
  "scripts/clarification.mjs": "trusted clarification\n",
  "scripts/parse-cursor-result.mjs": "trusted cursor parser\n",
  "scripts/run-contract.mjs": "trusted contract\n",
  "scripts/run-real-qa.mjs": "trusted real qa\n",
};

const apiFor = (calls: Call[], alreadyInstalled = false): GitHubApi => ({
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
    if (route === "GET /repos/{owner}/{repo}/contents/{path}") {
      if (parameters.path === ".github/workflows/flow-build.yml" && alreadyInstalled) {
        return { data: { type: "file", content: Buffer.from("name: Flow Build\n").toString("base64") } };
      }
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
  it("recognizes a legacy installation only when every trusted repo-kit file matches", async () => {
    const api = (changedPath?: string): GitHubApi => ({
      request: async (route, parameters) => {
        if (route === "GET /repos/{owner}/{repo}") return { data: { default_branch: "main" } };
        if (route === "GET /repos/{owner}/{repo}/contents/{path}") {
          const path = String(parameters.path);
          const content = trustedKit[path as keyof typeof trustedKit];
          if (!content) throw Object.assign(new Error("not found"), { status: 404 });
          return {
            data: {
              type: "file",
              content: Buffer.from(path === changedPath ? `${content}tampered` : content).toString("base64"),
            },
          };
        }
        throw new Error(`Unexpected route: ${route}`);
      },
    });

    await expect(verifyInstalledRepositoryKit({
      repository: "acme/store",
      api: api(),
      files: trustedKit,
      codeowners: ["@acme/platform"],
    }))
      .resolves.toBe(true);
    await expect(verifyInstalledRepositoryKit({
      repository: "acme/store",
      api: api(".github/CODEOWNERS"),
      files: trustedKit,
      codeowners: ["@acme/platform"],
    })).resolves.toBe(false);
  });

  it("opens the setup PR without exposing provider credentials to a pending repository", async () => {
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
      commitSha: "new-commit",
      setupPullRequestUrl: "https://github.test/acme/store/pull/7",
      mergeGateInstalled: false,
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
    expect(calls.some((call) => call.route.includes("/actions/secrets"))).toBe(false);
    expect(calls.some((call) => call.route.includes("/actions/variables"))).toBe(false);
    expect(calls.some((call) => call.route === "PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge")).toBe(false);
    expect(calls.some((call) => call.route.includes("/rulesets"))).toBe(false);
    expect(calls.some((call) => call.route === "PUT /repos/{owner}/{repo}/actions/permissions/workflow")).toBe(false);
  });

  it("leaves the merge gate off until a protected setup pull request is merged", async () => {
    const calls: Call[] = [];
    const result = await provisionRepository({
      repository: "acme/store",
      api: apiFor(calls),
      files: { ".github/workflows/flow-build.yml": "name: build\n" },
      secrets: { OPENAI_API_KEY: "openai-secret" },
      variables: { FLOW_BOT_LOGIN: "flow-ai[bot]" },
      codeowners: ["@acme/platform"],
      checkIntegrationId: 42,
      encryptSecret: async (value) => value,
    });

    expect(result.mergeGateInstalled).toBe(false);
    expect(result.setupPullRequestUrl).toContain("/pull/7");
    expect(calls.some((call) => call.route.includes("/rulesets"))).toBe(false);
    expect(calls.some((call) => call.route.includes("/actions/secrets"))).toBe(false);
  });

  it("opens a fresh human-reviewed setup PR when an installed legacy kit cannot be trusted", async () => {
    const calls: Call[] = [];
    const result = await provisionRepository({
      repository: "acme/store",
      api: apiFor(calls, true),
      files: { ".github/workflows/flow-build.yml": "updated trusted build\n" },
      secrets: { OPENAI_API_KEY: "openai-secret" },
      variables: { FLOW_BOT_LOGIN: "flow-ai[bot]" },
      codeowners: ["@acme/platform"],
      checkIntegrationId: 42,
      activationAuthorized: false,
      encryptSecret: async (value) => value,
    });

    expect(result).toMatchObject({
      mergeGateInstalled: false,
      setupPullRequestUrl: "https://github.test/acme/store/pull/7",
    });
    expect(calls.some((call) => call.route === "POST /repos/{owner}/{repo}/git/trees")).toBe(true);
    expect(calls.some((call) => call.route === "POST /repos/{owner}/{repo}/pulls")).toBe(true);
    expect(calls.some((call) => call.route.includes("/rulesets"))).toBe(false);
    expect(calls.some((call) => call.route.includes("/actions/secrets"))).toBe(false);
  });

  it("installs the merge gate only after the setup workflow exists on the default branch", async () => {
    const calls: Call[] = [];
    const result = await provisionRepository({
      repository: "acme/store",
      api: apiFor(calls, true),
      files: { ".github/workflows/flow-build.yml": "name: build\n" },
      secrets: { OPENAI_API_KEY: "openai-secret" },
      variables: { FLOW_BOT_LOGIN: "flow-ai[bot]" },
      codeowners: ["@acme/platform"],
      checkIntegrationId: 42,
      encryptSecret: async (value) => value,
    });

    expect(result.mergeGateInstalled).toBe(true);
    const ruleset = calls.find((call) => call.route === "POST /repos/{owner}/{repo}/rulesets");
    expect(JSON.stringify(ruleset?.parameters)).toContain("ai-review");
    expect(JSON.stringify(ruleset?.parameters)).toContain('"require_code_owner_review":true');
    const rulesetIndex = calls.findIndex((call) => call.route === "POST /repos/{owner}/{repo}/rulesets");
    const secretIndex = calls.findIndex((call) => call.route === "PUT /repos/{owner}/{repo}/actions/secrets/{secret_name}");
    expect(secretIndex).toBeGreaterThan(rulesetIndex);
    expect(calls.filter((call) => call.route === "PUT /repos/{owner}/{repo}/actions/secrets/{secret_name}"))
      .toHaveLength(1);
    expect(calls.find((call) => call.route === "PUT /repos/{owner}/{repo}/actions/permissions/workflow")?.parameters)
      .toMatchObject({ default_workflow_permissions: "read", can_approve_pull_request_reviews: false });
  });
});
