import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { FeedbackItem } from "./domain.js";
import type { Storage } from "./storage.js";

const FileSchema = z.object({
  file_id: z.string(),
  file_size: z.number().int().nonnegative().optional(),
  mime_type: z.string().optional(),
});

const PhotoSchema = FileSchema.extend({
  width: z.number().int().nonnegative(),
  height: z.number().int().nonnegative(),
});

const MessageSchema = z.object({
  message_id: z.number().int(),
  message_thread_id: z.number().int().optional(),
  from: z.object({ id: z.number().int(), is_bot: z.boolean() }),
  chat: z.object({ id: z.number().int() }),
  text: z.string().optional(),
  caption: z.string().optional(),
  photo: z.array(PhotoSchema).optional(),
  voice: FileSchema.optional(),
  document: FileSchema.optional(),
});

const CallbackSchema = z.object({
  id: z.string(),
  from: z.object({ id: z.number().int(), is_bot: z.boolean() }),
  data: z.string().optional(),
  message: MessageSchema.optional(),
});

const UpdateSchema = z.object({
  update_id: z.number().int(),
  message: MessageSchema.optional(),
  callback_query: CallbackSchema.optional(),
});

export type TelegramAction =
  | { type: "connect"; repository: string }
  | { type: "new" }
  | { type: "append"; item: FeedbackItem }
  | { type: "submit" }
  | { type: "cancel" }
  | { type: "status" };

export type ParsedTelegramUpdate = {
  updateId: string;
  chatId: string;
  topicId: string | null;
  userId: string;
  messageId: number;
  action: TelegramAction;
};

const optionalFileFields = (file: z.infer<typeof FileSchema>) => ({
  ...(file.file_size === undefined ? {} : { fileSize: file.file_size }),
  ...(file.mime_type === undefined ? {} : { mimeType: file.mime_type }),
});

const parseTextAction = (text: string): TelegramAction | null => {
  const normalized = text.trim();
  const connect = normalized.match(/^\/connect(?:@\w+)?\s+([\w.-]+\/[\w.-]+)$/i);
  if (connect?.[1]) return { type: "connect", repository: connect[1] };
  if (/^\/new(?:@\w+)?$/i.test(normalized)) return { type: "new" };
  if (/^\/ship(?:@\w+)?$/i.test(normalized)) return { type: "submit" };
  if (/^\/cancel(?:@\w+)?$/i.test(normalized)) return { type: "cancel" };
  if (/^\/status(?:@\w+)?$/i.test(normalized)) return { type: "status" };
  if (normalized.startsWith("/")) return null;
  return { type: "append", item: { kind: "text", text: normalized } };
};

export const parseTelegramUpdate = (input: unknown): ParsedTelegramUpdate | null => {
  const parsed = UpdateSchema.safeParse(input);
  if (!parsed.success) return null;
  const { update_id: updateId, message, callback_query: callback } = parsed.data;

  if (message && !message.from.is_bot) {
    let action: TelegramAction | null = null;
    if (message.text) action = parseTextAction(message.text);
    else if (message.photo?.length) {
      const photo = message.photo.reduce((largest, candidate) =>
        candidate.width * candidate.height > largest.width * largest.height ? candidate : largest,
      );
      action = {
        type: "append",
        item: {
          kind: "photo",
          fileId: photo.file_id,
          ...optionalFileFields(photo),
          ...(message.caption === undefined ? {} : { caption: message.caption }),
        },
      };
    } else if (message.voice) {
      action = {
        type: "append",
        item: { kind: "voice", fileId: message.voice.file_id, ...optionalFileFields(message.voice) },
      };
    } else if (message.document) {
      action = {
        type: "append",
        item: {
          kind: "document",
          fileId: message.document.file_id,
          ...optionalFileFields(message.document),
          ...(message.caption === undefined ? {} : { caption: message.caption }),
        },
      };
    }
    if (!action) return null;
    return {
      updateId: String(updateId),
      chatId: String(message.chat.id),
      topicId: message.message_thread_id === undefined ? null : String(message.message_thread_id),
      userId: String(message.from.id),
      messageId: message.message_id,
      action,
    };
  }

  if (callback?.message && !callback.from.is_bot && callback.data) {
    const action: TelegramAction | null = callback.data === "flow:submit"
      ? { type: "submit" }
      : callback.data === "flow:cancel"
        ? { type: "cancel" }
        : null;
    if (!action) return null;
    return {
      updateId: String(updateId),
      chatId: String(callback.message.chat.id),
      topicId:
        callback.message.message_thread_id === undefined
          ? null
          : String(callback.message.message_thread_id),
      userId: String(callback.from.id),
      messageId: callback.message.message_id,
      action,
    };
  }

  return null;
};

export const verifyTelegramSecret = (received: string | undefined, expected: string): boolean => {
  if (!received) return false;
  const actualBuffer = Buffer.from(received);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
};

export type TelegramRouteDependencies = {
  storage: Pick<Storage, "recordWebhook" | "enqueueJob">;
  webhookSecret: string;
};

export const registerTelegramRoutes = (
  server: FastifyInstance,
  dependencies: TelegramRouteDependencies,
): void => {
  server.post("/webhooks/telegram", async (request, reply) => {
    const header = request.headers["x-telegram-bot-api-secret-token"];
    const received = Array.isArray(header) ? header[0] : header;
    if (!verifyTelegramSecret(received, dependencies.webhookSecret)) {
      return reply.code(401).send({ ok: false });
    }

    const update = parseTelegramUpdate(request.body);
    if (!update) return reply.code(200).send({ ok: true, ignored: true });
    const serialized = JSON.stringify(request.body);
    const hash = createHash("sha256").update(serialized).digest("hex");
    if (!dependencies.storage.recordWebhook("telegram", update.updateId, hash)) {
      return reply.code(200).send({ ok: true, duplicate: true });
    }

    dependencies.storage.enqueueJob(
      "telegram",
      `telegram:${update.updateId}`,
      update,
    );
    return reply.code(200).send({ ok: true });
  });
};

type TelegramClientOptions = {
  token: string;
  fetch?: typeof fetch;
};

const TelegramResponseSchema = z.object({
  ok: z.literal(true),
  result: z.unknown(),
});

export type TelegramClient = {
  downloadFile(fileId: string): Promise<{ bytes: Buffer; mimeType: string }>;
  sendMessage(chatId: string, topicId: string | null, text: string): Promise<void>;
  setWebhook(url: string, secretToken: string): Promise<void>;
};

export const createTelegramClient = (options: TelegramClientOptions): TelegramClient => {
  const request = options.fetch ?? fetch;
  const apiBase = `https://api.telegram.org/bot${options.token}`;

  const call = async (method: string, body: unknown): Promise<unknown> => {
    const response = await request(`${apiBase}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Telegram ${method} failed with ${response.status}`);
    return TelegramResponseSchema.parse(await response.json()).result;
  };

  return {
    async downloadFile(fileId) {
      const result = z
        .object({ file_path: z.string(), file_size: z.number().int().nonnegative().optional() })
        .parse(await call("getFile", { file_id: fileId }));
      if (result.file_size !== undefined && result.file_size > 20 * 1024 * 1024) {
        throw new Error("Telegram Bot API attachments must be 20 MB or smaller");
      }
      const response = await request(
        `https://api.telegram.org/file/bot${options.token}/${result.file_path}`,
      );
      if (!response.ok) throw new Error(`Telegram file download failed with ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.byteLength > 20 * 1024 * 1024) {
        throw new Error("Telegram Bot API attachments must be 20 MB or smaller");
      }
      return {
        bytes,
        mimeType: response.headers.get("content-type") ?? "application/octet-stream",
      };
    },

    async sendMessage(chatId, topicId, text) {
      await call("sendMessage", {
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        ...(topicId === null ? {} : { message_thread_id: Number(topicId) }),
      });
    },

    async setWebhook(url, secretToken) {
      await call("setWebhook", {
        url,
        secret_token: secretToken,
        allowed_updates: ["message", "callback_query"],
        drop_pending_updates: false,
      });
    },
  };
};
