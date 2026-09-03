import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

export type Job = {
  id: number;
  kind: string;
  idempotencyKey: string;
  payload: unknown;
  attempts: number;
};

export type Notification = {
  id: number;
  idempotencyKey: string;
  chatId: string;
  topicId: string | null;
  text: string;
  attempts: number;
};

type FailureOptions = {
  maxAttempts: number;
  jitterMs?: number;
  permanent?: boolean;
};

export type Storage = {
  recordWebhook(source: string, deliveryId: string, payloadHash: string): boolean;
  enqueueJob(kind: string, idempotencyKey: string, payload: unknown, now?: number): boolean;
  claimJob(now?: number, leaseMs?: number): Job | null;
  completeJob(id: number): void;
  failJob(id: number, error: string, now: number, options: FailureOptions): void;
  enqueueNotification(
    idempotencyKey: string,
    chatId: string,
    topicId: string | null,
    text: string,
    now?: number,
  ): boolean;
  claimNotification(now?: number, leaseMs?: number): Notification | null;
  completeNotification(id: number): void;
  isReady(): boolean;
  close(): void;
};

type JobRow = {
  id: number;
  kind: string;
  idempotency_key: string;
  payload: string;
  attempts: number;
};

type NotificationRow = {
  id: number;
  idempotency_key: string;
  chat_id: string;
  topic_id: string | null;
  text: string;
  attempts: number;
};

const migration = `
CREATE TABLE IF NOT EXISTS chat_bindings (
  chat_id TEXT NOT NULL,
  topic_id TEXT NOT NULL DEFAULT '',
  installation_id INTEGER NOT NULL,
  repository TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (chat_id, topic_id)
);

CREATE TABLE IF NOT EXISTS drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  topic_id TEXT NOT NULL DEFAULT '',
  user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS drafts_one_open
ON drafts(chat_id, topic_id, user_id) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS draft_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  draft_id INTEGER NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  message_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(draft_id, message_id, kind)
);

CREATE TABLE IF NOT EXISTS webhook_receipts (
  source TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  PRIMARY KEY(source, delivery_id)
);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at INTEGER NOT NULL,
  lease_until INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS jobs_due ON jobs(status, available_at, lease_until);

CREATE TABLE IF NOT EXISTS work_links (
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

CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  idempotency_key TEXT NOT NULL UNIQUE,
  chat_id TEXT NOT NULL,
  topic_id TEXT,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at INTEGER NOT NULL,
  lease_until INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS outbox_due ON outbox(status, available_at, lease_until);
`;

export const openStorage = (path: string): Storage => {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const database = new Database(path);
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");
  database.exec(migration);
  let open = true;

  const claimJobTransaction = database.transaction((now: number, leaseMs: number) => {
    const row = database
      .prepare(
        `SELECT id, kind, idempotency_key, payload, attempts
         FROM jobs
         WHERE (status = 'pending' AND available_at <= ?)
            OR (status = 'running' AND lease_until < ?)
         ORDER BY created_at, id
         LIMIT 1`,
      )
      .get(now, now) as JobRow | undefined;
    if (!row) return null;
    database
      .prepare("UPDATE jobs SET status = 'running', lease_until = ?, updated_at = ? WHERE id = ?")
      .run(now + leaseMs, now, row.id);
    return row;
  });

  const claimNotificationTransaction = database.transaction((now: number, leaseMs: number) => {
    const row = database
      .prepare(
        `SELECT id, idempotency_key, chat_id, topic_id, text, attempts
         FROM outbox
         WHERE (status = 'pending' AND available_at <= ?)
            OR (status = 'running' AND lease_until < ?)
         ORDER BY created_at, id
         LIMIT 1`,
      )
      .get(now, now) as NotificationRow | undefined;
    if (!row) return null;
    database
      .prepare("UPDATE outbox SET status = 'running', lease_until = ?, updated_at = ? WHERE id = ?")
      .run(now + leaseMs, now, row.id);
    return row;
  });

  return {
    recordWebhook(source, deliveryId, payloadHash) {
      const result = database
        .prepare(
          "INSERT OR IGNORE INTO webhook_receipts(source, delivery_id, payload_hash, received_at) VALUES (?, ?, ?, ?)",
        )
        .run(source, deliveryId, payloadHash, Date.now());
      return result.changes === 1;
    },

    enqueueJob(kind, idempotencyKey, payload, now = Date.now()) {
      const result = database
        .prepare(
          `INSERT OR IGNORE INTO jobs(kind, idempotency_key, payload, available_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(kind, idempotencyKey, JSON.stringify(payload), now, now, now);
      return result.changes === 1;
    },

    claimJob(now = Date.now(), leaseMs = 30_000) {
      const row = claimJobTransaction.immediate(now, leaseMs) as JobRow | null;
      return row
        ? {
            id: row.id,
            kind: row.kind,
            idempotencyKey: row.idempotency_key,
            payload: JSON.parse(row.payload) as unknown,
            attempts: row.attempts,
          }
        : null;
    },

    completeJob(id) {
      database.prepare("UPDATE jobs SET status = 'complete', lease_until = NULL, updated_at = ? WHERE id = ?").run(Date.now(), id);
    },

    failJob(id, error, now, options) {
      const row = database.prepare("SELECT attempts FROM jobs WHERE id = ?").get(id) as
        | { attempts: number }
        | undefined;
      if (!row) throw new Error(`Unknown job ${id}`);
      const attempts = row.attempts + 1;
      const permanent = options.permanent === true || attempts >= options.maxAttempts;
      const jitter = options.jitterMs ?? Math.floor(Math.random() * 500);
      const availableAt = now + Math.min(3_600_000, 1_000 * 2 ** attempts) + jitter;
      database
        .prepare(
          `UPDATE jobs
           SET status = ?, attempts = ?, available_at = ?, lease_until = NULL, last_error = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(permanent ? "failed" : "pending", attempts, availableAt, error, now, id);
    },

    enqueueNotification(idempotencyKey, chatId, topicId, text, now = Date.now()) {
      const result = database
        .prepare(
          `INSERT OR IGNORE INTO outbox(idempotency_key, chat_id, topic_id, text, available_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(idempotencyKey, chatId, topicId, text, now, now, now);
      return result.changes === 1;
    },

    claimNotification(now = Date.now(), leaseMs = 30_000) {
      const row = claimNotificationTransaction.immediate(now, leaseMs) as NotificationRow | null;
      return row
        ? {
            id: row.id,
            idempotencyKey: row.idempotency_key,
            chatId: row.chat_id,
            topicId: row.topic_id,
            text: row.text,
            attempts: row.attempts,
          }
        : null;
    },

    completeNotification(id) {
      database.prepare("UPDATE outbox SET status = 'complete', lease_until = NULL, updated_at = ? WHERE id = ?").run(Date.now(), id);
    },

    isReady() {
      if (!open) return false;
      return (database.prepare("SELECT 1 AS ok").get() as { ok: number }).ok === 1;
    },

    close() {
      if (!open) return;
      database.close();
      open = false;
    },
  };
};
