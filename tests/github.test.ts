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
    expect(calls.filter((call) => call.route.includes("sub_issues"))).toHaveLength(2);
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
