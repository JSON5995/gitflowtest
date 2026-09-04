import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { registerGitHubRoutes, type GitHubGateway, type PublishedCheck } from "../src/github.js";
import { processTelegramUpdate } from "../src/orchestrator.js";
import { buildServer } from "../src/server.js";
import { openStorage, type Storage } from "../src/storage.js";
import { registerTelegramRoutes, type ParsedTelegramUpdate, type TelegramClient } from "../src/telegram.js";
import { processNextJob, sendNextNotification } from "../src/worker.js";

const storages: Storage[] = [];
const servers: Array<ReturnType<typeof buildServer>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  storages.splice(0).forEach((storage) => storage.close());
});

describe("end-to-end delivery", () => {
  it("turns Telegram feedback into checked work ready for human approval", async () => {
    const headSha = "a".repeat(40);
    const storage = openStorage(":memory:");
    storages.push(storage);
    const notifications: string[] = [];
    const builds: number[] = [];
    const qualityRuns: number[] = [];
    const checks: PublishedCheck[] = [];
    const telegram: TelegramClient = {
      downloadFile: async () => ({ bytes: Buffer.alloc(0), mimeType: "application/octet-stream" }),
      sendMessage: async (_chat, _topic, text) => { notifications.push(text); },
      setWebhook: async () => undefined,
    };
    const github: GitHubGateway = {
      verifyWebhook: () => true,
      hasRepositoryAccess: async () => ({ installationId: 99 }),
      createPlannedIssue: async () => ({ parentNumber: 17, childNumbers: [] }),
      setFlowState: async () => undefined,
      dispatchBuild: async (_repository, issue) => { builds.push(issue); },
      dispatchQuality: async (_repository, pullRequest) => { qualityRuns.push(pullRequest); },
      verifyTrustedWorkflow: async () => true,
      publishCheck: async (_repository, check) => { checks.push(check); },
      openPullRequest: async () => 22,
      markPullRequestReady: async () => undefined,
      closeIssue: async () => undefined,
    };
    const worker = {
      storage,
      github,
      botLogin: "flow-ai[bot]",
      builder: "codex" as const,
      maxFixRounds: 2,
      onError: (error: Error) => { throw error; },
      processTelegram: async (input: unknown) => processTelegramUpdate(input as ParsedTelegramUpdate, {
        storage,
        adminIds: ["123"],
        telegram,
        transcribe: async () => "",
        analyzeVideo: async () => ({ transcript: "", images: [] }),
        model: { createPlan: async () => ({
          title: "Repair checkout",
          problem: "Checkout cannot submit an order.",
          evidence: [],
          acceptanceCriteria: ["One order is submitted."],
          nonGoals: [],
          risks: [],
          needsHumanInput: false,
          units: [{ title: "Repair checkout", body: "Fix it.", canRunInParallel: false }],
        }) },
        github,
      }),
    };
    const server = buildServer({ isReady: storage.isReady });
    servers.push(server);
    registerTelegramRoutes(server, { storage, webhookSecret: "telegram-secret", allowedUserIds: ["123"] });
    await registerGitHubRoutes(server, { storage, webhookSecret: "github-secret" });

    const sendTelegram = async (updateId: number, messageId: number, text: string): Promise<void> => {
      const response = await server.inject({
        method: "POST",
        url: "/webhooks/telegram",
        headers: { "x-telegram-bot-api-secret-token": "telegram-secret" },
        payload: {
          update_id: updateId,
          message: { message_id: messageId, from: { id: 123, is_bot: false }, chat: { id: -100 }, text },
        },
      });
      expect(response.statusCode).toBe(200);
      while (await processNextJob(worker, Date.now() + 1_000)) {
        // Drain all durable work created by this update.
      }
      while (await sendNextNotification(storage, telegram, Date.now() + 1_000)) {
        // Drain the durable outbox.
      }
    };

    await sendTelegram(1, 1, "/connect acme/store");
    await sendTelegram(2, 2, "Checkout is broken after pressing Pay");
    await sendTelegram(3, 3, "/ship");

    expect(builds).toEqual([17]);
    expect(storage.getWorkByIssue("acme/store", 17)?.state).toBe("working");
    expect(notifications.join("\n")).toContain("GitHub issue #17");

    const sendGitHub = async (delivery: string, event: string, payload: unknown): Promise<void> => {
      const raw = JSON.stringify(payload);
      const signature = `sha256=${createHmac("sha256", "github-secret").update(raw).digest("hex")}`;
      const response = await server.inject({
        method: "POST",
        url: "/webhooks/github",
        headers: {
          "content-type": "application/json",
          "x-github-delivery": delivery,
          "x-github-event": event,
          "x-hub-signature-256": signature,
        },
        payload: raw,
      });
      expect(response.statusCode).toBe(200);
      await processNextJob(worker, Date.now() + 1_000);
    };

    await sendGitHub("pr-1", "pull_request", {
      action: "opened",
      repository: { full_name: "acme/store", default_branch: "main" },
      pull_request: {
        number: 22,
        body: "Closes #17",
        merged: false,
        user: { login: "flow-ai[bot]" },
        base: { ref: "main" },
        head: { sha: headSha, ref: "flow/17", repo: { full_name: "acme/store" } },
      },
    });
    expect(qualityRuns).toEqual([22]);

    for (const [index, name] of ["Flow CI", "AI Review", "Flow QA"].entries()) {
      const paths: Record<string, string> = {
        "Flow CI": ".github/workflows/flow-ci.yml",
        "AI Review": ".github/workflows/flow-review.yml",
        "Flow QA": ".github/workflows/flow-qa.yml",
      };
      await sendGitHub(`run-${index}`, "workflow_run", {
        action: "completed",
        repository: { full_name: "acme/store" },
        workflow_run: {
          id: 100 + index,
          workflow_id: 200 + index,
          name,
          path: paths[name],
          event: "workflow_dispatch",
          actor: { login: "flow-ai[bot]" },
          triggering_actor: { login: "flow-ai[bot]" },
          head_branch: "main",
          head_sha: "c".repeat(40),
          run_attempt: 1,
          display_title: `${name} · PR #22 · SHA ${headSha}`,
          conclusion: "success",
          html_url: `https://github.com/acme/store/actions/runs/${100 + index}`,
        },
      });
    }

    expect(checks.map((check) => check.name)).toEqual(["ci", "ai-review", "qa"]);
    expect(storage.getWorkByIssue("acme/store", 17)?.state).toBe("human");
  });
});
