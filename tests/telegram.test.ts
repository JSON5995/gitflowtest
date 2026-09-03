import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { openStorage, type Storage } from "../src/storage.js";
import {
  parseTelegramUpdate,
  registerTelegramRoutes,
  verifyTelegramSecret,
} from "../src/telegram.js";

const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(resolve("fixtures", name), "utf8")) as Record<string, unknown>;

const servers: ReturnType<typeof Fastify>[] = [];
const storages: Storage[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  storages.splice(0).forEach((storage) => storage.close());
});

describe("Telegram update parsing", () => {
  it("preserves topic and actor identity for text", () => {
    expect(parseTelegramUpdate(fixture("telegram-text.json"))).toEqual({
      updateId: "1001",
      chatId: "-100555",
      topicId: "77",
      userId: "123",
      messageId: 11,
      action: { type: "append", item: { kind: "text", text: "The checkout button does nothing" } },
    });
  });

  it("selects the largest available Telegram photo", () => {
    expect(parseTelegramUpdate(fixture("telegram-photo.json"))?.action).toEqual({
      type: "append",
      item: {
        kind: "photo",
        fileId: "large",
        fileSize: 120000,
        caption: "The broken state",
      },
    });
  });

  it("captures a voice note without interpreting it synchronously", () => {
    expect(parseTelegramUpdate(fixture("telegram-voice.json"))?.action).toEqual({
      type: "append",
      item: {
        kind: "voice",
        fileId: "voice-file",
        fileSize: 42000,
        mimeType: "audio/ogg",
      },
    });
  });

  it("parses control commands without treating them as feedback", () => {
    const update = fixture("telegram-text.json") as { message: { text: string } };
    update.message.text = "/connect acme/store";
    expect(parseTelegramUpdate(update)?.action).toEqual({ type: "connect", repository: "acme/store" });
    update.message.text = "/new";
    expect(parseTelegramUpdate(update)?.action).toEqual({ type: "new" });
    update.message.text = "/ship";
    expect(parseTelegramUpdate(update)?.action).toEqual({ type: "submit" });
  });
});

describe("Telegram webhook", () => {
  it("uses a timing-safe webhook-secret comparison", () => {
    expect(verifyTelegramSecret("right", "right")).toBe(true);
    expect(verifyTelegramSecret("wrong", "right")).toBe(false);
    expect(verifyTelegramSecret(undefined, "right")).toBe(false);
  });

  it("rejects invalid webhook secrets", async () => {
    const storage = openStorage(":memory:");
    storages.push(storage);
    const server = Fastify();
    servers.push(server);
    registerTelegramRoutes(server, { storage, webhookSecret: "right" });

    const response = await server.inject({
      method: "POST",
      url: "/webhooks/telegram",
      headers: { "x-telegram-bot-api-secret-token": "wrong" },
      payload: fixture("telegram-text.json"),
    });

    expect(response.statusCode).toBe(401);
  });

  it("acknowledges a duplicate update without enqueueing twice", async () => {
    const storage = openStorage(":memory:");
    storages.push(storage);
    const server = Fastify();
    servers.push(server);
    registerTelegramRoutes(server, { storage, webhookSecret: "right" });
    const request = {
      method: "POST" as const,
      url: "/webhooks/telegram",
      headers: { "x-telegram-bot-api-secret-token": "right" },
      payload: fixture("telegram-text.json"),
    };

    const first = await server.inject(request);
    const second = await server.inject(request);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    const job = storage.claimJob(Date.now() + 1000, 1000);
    expect(job?.idempotencyKey).toBe("telegram:1001");
    storage.completeJob(job!.id);
    expect(storage.claimJob(Date.now() + 1000, 1000)).toBeNull();
  });
});
