import { createHmac } from "node:crypto";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkPlan } from "../src/domain.js";
import {
  createGitHubGateway,
  registerGitHubRoutes,
  verifyGitHubSignature,
  type GitHubApi,
} from "../src/github.js";
import { openStorage, type Storage } from "../src/storage.js";

const plan: WorkPlan = {
  title: "Improve checkout",
  problem: "Checkout cannot submit an order.",
  evidence: [],
  acceptanceCriteria: ["One order is submitted."],
  nonGoals: [],
  risks: [],
  needsHumanInput: false,
  units: [
    { title: "Repair submit", body: "Fix submit behavior.", canRunInParallel: true },
    { title: "Add regression", body: "Add browser regression coverage.", canRunInParallel: true },
  ],
};

const servers: ReturnType<typeof Fastify>[] = [];
const storages: Storage[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  storages.splice(0).forEach((storage) => storage.close());
});

describe("GitHub gateway", () => {
  it("verifies the exact webhook payload signature", () => {
    const payload = '{"action":"opened"}';
    const signature = `sha256=${createHmac("sha256", "secret").update(payload).digest("hex")}`;

    expect(verifyGitHubSignature(payload, signature, "secret")).toBe(true);
    expect(verifyGitHubSignature(`${payload} `, signature, "secret")).toBe(false);
  });

  it("creates and links independent sub-issues", async () => {
    let nextNumber = 10;
    const calls: Array<{ route: string; parameters: Record<string, unknown> }> = [];
    const api: GitHubApi = {
      request: async (route, parameters) => {
        calls.push({ route, parameters });
        if (route === "GET /repos/{owner}/{repo}/issues") return { data: [] };
        if (route === "GET /repos/{owner}/{repo}/issues/{issue_number}/sub_issues") return { data: [] };
        if (route === "POST /repos/{owner}/{repo}/issues") {
          const number = nextNumber++;
          return { data: { id: number + 1000, number, html_url: `https://github.test/issues/${number}` } };
        }
        return { data: {} };
      },
    };
    const gateway = createGitHubGateway({
      webhookSecret: "secret",
      getInstallationId: async () => 99,
      getApi: async () => api,
    });

    const result = await gateway.createPlannedIssue("acme/store", plan, {
      chatId: "-100",
      topicId: null,
      userId: "123",
      messageIds: [1],
    });

    expect(result).toEqual({ parentNumber: 10, childNumbers: [11, 12] });
    expect(calls.filter((call) => call.route === "POST /repos/{owner}/{repo}/issues")).toHaveLength(3);
    expect(calls.filter((call) => call.route === "POST /repos/{owner}/{repo}/issues/{issue_number}/sub_issues")).toHaveLength(2);
  });

  it("reconciles an already-created request instead of duplicating issues", async () => {
    const calls: Array<{ route: string; parameters: Record<string, unknown> }> = [];
    let listed = false;
    const gateway = createGitHubGateway({
      webhookSecret: "secret",
      getInstallationId: async () => 99,
      getApi: async () => ({
        request: async (route, parameters) => {
          calls.push({ route, parameters });
          if (route === "GET /repos/{owner}/{repo}/issues") {
            if (!listed) {
              listed = true;
              return { data: [] };
            }
            const bodies = calls
              .filter((call) => call.route === "POST /repos/{owner}/{repo}/issues")
              .map((call, index) => ({ id: 1_010 + index, number: 10 + index, html_url: `https://github.test/issues/${10 + index}`, body: call.parameters.body }));
            return { data: bodies };
          }
          if (route === "POST /repos/{owner}/{repo}/issues") {
            const number = 10 + calls.filter((call) => call.route === route).length - 1;
            return { data: { id: 1_000 + number, number, html_url: `https://github.test/issues/${number}` } };
          }
          if (route === "GET /repos/{owner}/{repo}/issues/{issue_number}/sub_issues") return { data: [] };
          return { data: {} };
        },
      }),
    });
    const source = { chatId: "-100", topicId: null, userId: "123", messageIds: [1] };

    await gateway.createPlannedIssue("acme/store", plan, source);
    await gateway.createPlannedIssue("acme/store", plan, source);

    expect(calls.filter((call) => call.route === "POST /repos/{owner}/{repo}/issues")).toHaveLength(3);
  });

  it("keeps non-flow labels when changing state", async () => {
    let updatedLabels: string[] = [];
    const api: GitHubApi = {
      request: async (route, parameters) => {
        if (route === "GET /repos/{owner}/{repo}/issues/{issue_number}") {
          return { data: { labels: [{ name: "bug" }, { name: "flow:ready" }, "customer"] } };
        }
        if (route === "PATCH /repos/{owner}/{repo}/issues/{issue_number}") {
          updatedLabels = parameters.labels as string[];
        }
        return { data: {} };
      },
    };
    const gateway = createGitHubGateway({
      webhookSecret: "secret",
      getInstallationId: async () => 99,
      getApi: async () => api,
    });

    await gateway.setFlowState("acme/store", 10, "working");

    expect(updatedLabels).toEqual(["bug", "customer", "flow:working"]);
  });

  it("dispatches independent review and QA workflows for a pull request", async () => {
    const calls: Array<{ route: string; parameters: Record<string, unknown> }> = [];
    const gateway = createGitHubGateway({
      webhookSecret: "secret",
      getInstallationId: async () => 99,
      getApi: async () => ({
        request: async (route, parameters) => {
          calls.push({ route, parameters });
          if (route === "GET /repos/{owner}/{repo}") return { data: { default_branch: "main" } };
          return { data: {} };
        },
      }),
    });

    await gateway.dispatchQuality("acme/store", 22, "a".repeat(40));

    const dispatches = calls.filter((call) => call.route.includes("/dispatches"));
    expect(dispatches.map((call) => call.parameters.workflow_id)).toEqual([
      "flow-ci.yml",
      "flow-review.yml",
      "flow-qa.yml",
    ]);
    expect(dispatches.every((call) => (call.parameters.inputs as { pr_number: string }).pr_number === "22")).toBe(true);
    expect(dispatches.every((call) => (call.parameters.inputs as { head_sha: string }).head_sha === "a".repeat(40))).toBe(true);
  });

  it("accepts only an active workflow run from the default branch history", async () => {
    const current = "c".repeat(40);
    const dispatched = "b".repeat(40);
    const gateway = createGitHubGateway({
      webhookSecret: "secret",
      getInstallationId: async () => 99,
      getApi: async () => ({
        request: async (route) => {
          if (route === "GET /repos/{owner}/{repo}") return { data: { default_branch: "main" } };
          if (route === "GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}") {
            return { data: { id: 201, path: ".github/workflows/flow-ci.yml", state: "active" } };
          }
          if (route === "GET /repos/{owner}/{repo}/git/ref/heads/{ref}") {
            return { data: { object: { sha: current } } };
          }
          if (route === "GET /repos/{owner}/{repo}/compare/{basehead}") return { data: { status: "ahead" } };
          return { data: {} };
        },
      }),
    });
    const trusted = {
      workflowId: 201,
      path: ".github/workflows/flow-ci.yml",
      headBranch: "main",
      headSha: dispatched,
    };

    expect(await gateway.verifyTrustedWorkflow("acme/store", trusted)).toBe(true);
    expect(await gateway.verifyTrustedWorkflow("acme/store", { ...trusted, headBranch: "attacker" })).toBe(false);
    expect(await gateway.verifyTrustedWorkflow("acme/store", { ...trusted, path: ".github/workflows/other.yml" })).toBe(false);
  });

  it("marks the draft pull request ready for human approval", async () => {
    const calls: Array<{ route: string; parameters: Record<string, unknown> }> = [];
    const gateway = createGitHubGateway({
      webhookSecret: "secret",
      getInstallationId: async () => 99,
      getApi: async () => ({ request: async (route, parameters) => { calls.push({ route, parameters }); return { data: {} }; } }),
    });

    await gateway.markPullRequestReady("acme/store", 22);

    expect(calls[0]?.route).toBe("POST /repos/{owner}/{repo}/pulls/{pull_number}/ready_for_review");
  });

  it("publishes a trusted status check on the pull request head", async () => {
    const calls: Array<{ route: string; parameters: Record<string, unknown> }> = [];
    const gateway = createGitHubGateway({
      webhookSecret: "secret",
      getInstallationId: async () => 99,
      getApi: async () => ({
        request: async (route, parameters) => {
          calls.push({ route, parameters });
          return { data: {} };
        },
      }),
    });

    await gateway.publishCheck("acme/store", {
      name: "qa",
      headSha: "abc",
      conclusion: "success",
      summary: "Flow QA passed.",
      detailsUrl: "https://github.com/acme/store/actions/runs/1",
      externalId: "flow:1",
    });

    expect(calls[0]).toMatchObject({
      route: "POST /repos/{owner}/{repo}/check-runs",
      parameters: { name: "qa", head_sha: "abc", status: "completed", conclusion: "success" },
    });
  });

  it("opens one draft pull request for a completed issue branch", async () => {
    const calls: Array<{ route: string; parameters: Record<string, unknown> }> = [];
    const gateway = createGitHubGateway({
      webhookSecret: "secret",
      getInstallationId: async () => 99,
      getApi: async () => ({
        request: async (route, parameters) => {
          calls.push({ route, parameters });
          if (route === "GET /repos/{owner}/{repo}") return { data: { default_branch: "main" } };
          if (route === "GET /repos/{owner}/{repo}/pulls") return { data: [] };
          if (route === "POST /repos/{owner}/{repo}/pulls") return { data: { number: 22 } };
          return { data: {} };
        },
      }),
    });

    expect(await gateway.openPullRequest("acme/store", 17)).toBe(22);
    expect(calls.find((call) => call.route === "POST /repos/{owner}/{repo}/pulls")?.parameters).toMatchObject({
      head: "flow/17",
      base: "main",
      draft: true,
      body: expect.stringContaining("Closes #17"),
    });
  });
});

describe("GitHub webhook route", () => {
  it("rejects invalid HMAC and deduplicates valid deliveries", async () => {
    const storage = openStorage(":memory:");
    storages.push(storage);
    const server = Fastify();
    servers.push(server);
    await registerGitHubRoutes(server, { storage, webhookSecret: "secret" });
    const payload = JSON.stringify({ action: "opened", repository: { full_name: "acme/store" } });

    const rejected = await server.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-github-delivery": "delivery-1",
        "x-hub-signature-256": "sha256=bad",
      },
      payload,
    });
    expect(rejected.statusCode).toBe(401);

    const signature = `sha256=${createHmac("sha256", "secret").update(payload).digest("hex")}`;
    const request = {
      method: "POST" as const,
      url: "/webhooks/github",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-github-delivery": "delivery-1",
        "x-hub-signature-256": signature,
      },
      payload,
    };
    expect((await server.inject(request)).statusCode).toBe(200);
    expect((await server.inject(request)).statusCode).toBe(200);
    const job = storage.claimJob(Date.now() + 1000, 1000);
    expect(job?.idempotencyKey).toBe("github:delivery-1");
    storage.completeJob(job!.id);
    expect(storage.claimJob(Date.now() + 1000, 1000)).toBeNull();
  });
});
