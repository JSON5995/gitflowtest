import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openStorage, type Storage } from "../src/storage.js";

const cleanupPaths: string[] = [];
const storages: Storage[] = [];

afterEach(async () => {
  for (const storage of storages.splice(0)) storage.close();
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("storage", () => {
  it("records one webhook delivery exactly once", () => {
    const storage = openStorage(":memory:");
    storages.push(storage);

    expect(storage.recordWebhook("telegram", "101", "hash-a")).toBe(true);
    expect(storage.recordWebhook("telegram", "101", "hash-a")).toBe(false);
  });

  it("records a webhook receipt and its durable job atomically", () => {
    const storage = openStorage(":memory:");
    storages.push(storage);

    expect(storage.recordWebhookJob("telegram", "101", "hash-a", "telegram", "telegram:101", { updateId: "101" }, 1_000)).toBe(true);
    expect(storage.recordWebhookJob("telegram", "101", "hash-a", "telegram", "telegram:101", { updateId: "101" }, 1_001)).toBe(false);
    expect(storage.claimJob(1_000, 1_000)?.payload).toEqual({ updateId: "101" });
  });

  it("reclaims a job whose lease expired", () => {
    const storage = openStorage(":memory:");
    storages.push(storage);
    storage.enqueueJob("intake", "issue:7", { issue: 7 }, 1_000);

    const first = storage.claimJob(1_000, 30_000);
    expect(first?.idempotencyKey).toBe("issue:7");
    expect(storage.claimJob(30_999, 30_000)).toBeNull();
    expect(storage.claimJob(31_001, 30_000)?.id).toBe(first?.id);
  });

  it("persists queued work across a database reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "gitflow-storage-"));
    cleanupPaths.push(directory);
    const databasePath = join(directory, "flow.db");
    const first = openStorage(databasePath);
    first.enqueueJob("notify", "pr:9:ready", { pr: 9 }, 5_000);
    first.close();

    const reopened = openStorage(databasePath);
    storages.push(reopened);

    expect(reopened.claimJob(5_000, 10_000)?.payload).toEqual({ pr: 9 });
  });

  it("deduplicates outbox messages by idempotency key", () => {
    const storage = openStorage(":memory:");
    storages.push(storage);

    expect(storage.enqueueNotification("ready:repo:9", "-100", null, "Ready", 10)).toBe(true);
    expect(storage.enqueueNotification("ready:repo:9", "-100", null, "Ready again", 11)).toBe(false);
    expect(storage.claimNotification(10, 1_000)?.text).toBe("Ready");
  });

  it("backs off a failed notification and retries it", () => {
    const storage = openStorage(":memory:");
    storages.push(storage);
    storage.enqueueNotification("ready:repo:10", "-100", null, "Ready", 0);
    const notification = storage.claimNotification(0, 1_000);
    expect(notification).not.toBeNull();

    storage.failNotification(notification!.id, "rate limited", 100, {
      maxAttempts: 3,
      jitterMs: 0,
    });

    expect(storage.claimNotification(2_099, 1_000)).toBeNull();
    expect(storage.claimNotification(2_100, 1_000)?.attempts).toBe(1);
  });

  it("backs off a transient failure without losing the payload", () => {
    const storage = openStorage(":memory:");
    storages.push(storage);
    storage.enqueueJob("build", "issue:8", { issue: 8 }, 0);
    const job = storage.claimJob(0, 1_000);
    expect(job).not.toBeNull();

    storage.failJob(job!.id, "rate limited", 100, { maxAttempts: 3, jitterMs: 0 });

    expect(storage.claimJob(2_099, 1_000)).toBeNull();
    expect(storage.claimJob(2_100, 1_000)?.payload).toEqual({ issue: 8 });
  });

  it("reports readiness only while the database is open", () => {
    const storage = openStorage(":memory:");
    expect(storage.isReady()).toBe(true);
    storage.close();
    expect(storage.isReady()).toBe(false);
  });

  it("binds a Telegram topic to one repository", () => {
    const storage = openStorage(":memory:");
    storages.push(storage);

    storage.bindChat("-100", "77", 99, "acme/store", 1_000);

    expect(storage.getChatBinding("-100", "77")).toEqual({
      chatId: "-100",
      topicId: "77",
      installationId: 99,
      repository: "acme/store",
    });
    expect(storage.getChatBinding("-100", null)).toBeNull();
  });

  it("isolates multiple repository bindings in one hosted service", () => {
    const storage = openStorage(":memory:");
    storages.push(storage);

    storage.bindChat("-100", "web", 11, "acme/web", 1_000);
    storage.bindChat("-100", "api", 12, "acme/api", 1_001);
    storage.bindChat("-200", null, 13, "acme/mobile", 1_002);

    expect(storage.getChatBinding("-100", "web")?.repository).toBe("acme/web");
    expect(storage.getChatBinding("-100", "api")?.repository).toBe("acme/api");
    expect(storage.getChatBinding("-200", null)?.repository).toBe("acme/mobile");
  });

  it("collects an open draft and closes it on submission", () => {
    const storage = openStorage(":memory:");
    storages.push(storage);
    const draftId = storage.startDraft("-100", null, "123", 1_000, 86_400_000);
    storage.appendDraftItem(draftId, 7, { kind: "text", text: "Fix checkout" }, 1_001);

    expect(storage.getOpenDraft("-100", null, "123", 1_002)).toMatchObject({
      id: draftId,
      messageIds: [7],
      items: [{ kind: "text", text: "Fix checkout" }],
    });

    storage.closeDraft(draftId, "submitted", "update-9");
    expect(storage.getOpenDraft("-100", null, "123", 1_003)).toBeNull();
    expect(storage.getDraftBySubmission("update-9")).toMatchObject({ id: draftId, messageIds: [7] });
  });

  it("links chat work to an issue and pull request", () => {
    const storage = openStorage(":memory:");
    storages.push(storage);
    storage.linkWork({
      repository: "acme/store",
      issueNumber: 17,
      chatId: "-100",
      topicId: "77",
      pullRequestNumber: null,
      providerJobId: null,
      fixRounds: 0,
      state: "ready",
      headSha: null,
      repairHeadSha: null,
      passedChecks: [],
    }, 1_000);
    const linked = {
      ...storage.getWorkByIssue("acme/store", 17)!,
      pullRequestNumber: 12,
      headSha: "abc",
      repairHeadSha: null,
      passedChecks: ["ci"],
    };
    storage.saveWork(linked, 2_000);

    expect(storage.getWorkByPullRequest("acme/store", 12)).toEqual(linked);
  });

  it("upgrades a v1 work-links table without losing existing records", () => {
    const directory = mkdtempSync(join(tmpdir(), "gitflow-storage-"));
    cleanupPaths.push(directory);
    const databasePath = join(directory, "flow.db");
    const legacy = new Database(databasePath);
    legacy.exec(`
      CREATE TABLE work_links (
        repository TEXT NOT NULL,
        issue_number INTEGER NOT NULL,
        chat_id TEXT NOT NULL,
        topic_id TEXT NOT NULL DEFAULT '',
        pull_request_number INTEGER,
        provider_job_id TEXT,
        fix_rounds INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(repository, issue_number)
      );
      INSERT INTO work_links VALUES ('acme/store', 17, '-100', '', NULL, NULL, 0, 'ready', 1000);
    `);
    legacy.close();

    const storage = openStorage(databasePath);
    storages.push(storage);

    expect(storage.getWorkByIssue("acme/store", 17)).toMatchObject({
      state: "ready",
      headSha: null,
      repairHeadSha: null,
      passedChecks: [],
    });
  });
});
