import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { FeedbackItem, FlowState, Provider, WorkPlan } from "./domain.js";
import { randomUUID } from "node:crypto";
import type {
  BudgetDenialReason,
  ModelCandidate,
  ProviderFailureCategory,
  RouterEvent,
  RouterPolicy,
  RoutingTask,
  TokenUsage,
  UsageReservationRequest,
  UsageSettlement,
} from "./provider-router.js";

export type Job = {
  id: number;
  kind: string;
  idempotencyKey: string;
  payload: unknown;
  attempts: number;
  reclaimed: boolean;
};

export type JobInput = {
  kind: string;
  idempotencyKey: string;
  payload: unknown;
  availableAt?: number;
};

export type Notification = {
  id: number;
  idempotencyKey: string;
  chatId: string;
  topicId: string | null;
  text: string;
  attempts: number;
};

export type ChatBinding = {
  chatId: string;
  topicId: string | null;
  installationId: number;
  repository: string;
};

export type Draft = {
  id: number;
  chatId: string;
  topicId: string | null;
  userId: string;
  messageIds: number[];
  items: FeedbackItem[];
};

export type SubmissionPlan = { repository: string; plan: WorkPlan };

export type WorkBlockReason = "clarification" | "route" | "quality";

export type WorkRecord = {
  repository: string;
  issueNumber: number;
  chatId: string;
  topicId: string | null;
  pullRequestNumber: number | null;
  providerJobId: string | null;
  fixRounds: number;
  state: FlowState;
  headSha: string | null;
  repairHeadSha: string | null;
  passedChecks: string[];
  blockReason?: WorkBlockReason | null;
  clarificationId?: string | null;
};

export type AdminWorkItem = {
  repository: string;
  state: FlowState;
  issueNumber: number;
  issueUrl: string | null;
  pullRequestNumber: number | null;
  pullRequestUrl: string | null;
  fixRounds: number;
  updatedAt: string;
};

export type AdminApprovalItem = Omit<AdminWorkItem, "state" | "fixRounds">;

export type AdminSummary = {
  generatedAt: string;
  storageReady: boolean;
  repositories: Array<{ repository: string; context: string; boundAt: string }>;
  jobStates: Record<"pending" | "running" | "complete" | "failed", number>;
  workStates: Record<FlowState, number>;
  recentWork: AdminWorkItem[];
  recentFailures: Array<{
    source: "job" | "notification";
    kind: string;
    attempts: number;
    failedAt: string;
  }>;
  awaitingApproval: AdminApprovalItem[];
};

export type ProviderCredentialRecord = {
  sealed: string;
  verifiedAt: string;
  updatedAt: string;
};

export type DiscoveredModelRole = "build" | "review" | "qa";

export type ProviderModelOption = {
  id: string;
  name: string;
  roles: DiscoveredModelRole[];
};

export type ProviderModelCatalog = {
  provider: Provider;
  supportsDiscovery: boolean;
  models: ProviderModelOption[];
  refreshedAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
};

export type RoutingSettings = {
  candidates: ModelCandidate[];
  policy: RouterPolicy;
};

export type ManagedRepository = {
  repository: string;
  installationId: number;
  codeowners: string[];
  setupPullRequestUrl: string | null;
  mergeGateInstalled: boolean;
  status: "pending" | "active";
  updatedAt: string;
};

export type ManagedRepositoryInput = Omit<ManagedRepository, "status">;

export type UsageReservation = {
  id: string;
  jobId: string;
  candidate: ModelCandidate;
  attempt: number;
  estimatedUsage: TokenUsage;
  estimatedCostMicros: number;
  status: "reserved" | "settled" | "released";
};

export type StoredRoutingAttempt = {
  routeId: string;
  task: RoutingTask;
  candidate: ModelCandidate;
  attempt: number;
  reservationId: string;
  status: "reserved" | "complete" | "failed";
  failureCategory: ProviderFailureCategory | null;
  createdAt: string;
  updatedAt: string;
};

export type RoutingAttemptFinalization = {
  routeId: string;
  status: "complete" | "failed";
  failureCategory: ProviderFailureCategory | null;
  settlement: UsageSettlement | null;
  event: RouterEvent;
};

export type RoutingSummary = {
  month: string;
  reservedTokens: number;
  settledTokens: number;
  reservedCostMicros: number;
  settledCostMicros: number;
  recentEvents: RouterEvent[];
};

type FailureOptions = {
  maxAttempts: number;
  jitterMs?: number;
  permanent?: boolean;
};

export type Storage = {
  recordWebhook(source: string, deliveryId: string, payloadHash: string): boolean;
  recordWebhookJob(
    source: string,
    deliveryId: string,
    payloadHash: string,
    kind: string,
    idempotencyKey: string,
    payload: unknown,
    now?: number,
  ): boolean;
  enqueueJob(kind: string, idempotencyKey: string, payload: unknown, now?: number): boolean;
  saveWorkAndEnqueueJobs(work: WorkRecord, jobs: JobInput[], now?: number): void;
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
  failNotification(id: number, error: string, now: number, options: FailureOptions): void;
  bindChat(
    chatId: string,
    topicId: string | null,
    installationId: number,
    repository: string,
    now?: number,
  ): void;
  getChatBinding(chatId: string, topicId: string | null): ChatBinding | null;
  startDraft(
    chatId: string,
    topicId: string | null,
    userId: string,
    now?: number,
    ttlMs?: number,
  ): number;
  appendDraftItem(draftId: number, messageId: number, item: FeedbackItem, now?: number): boolean;
  getOpenDraft(chatId: string, topicId: string | null, userId: string, now?: number): Draft | null;
  getDraftBySubmission(submissionId: string): Draft | null;
  saveSubmissionPlan(draftId: number, submissionId: string, repository: string, plan: WorkPlan): void;
  getSubmissionPlan(draftId: number): SubmissionPlan | null;
  closeDraft(id: number, status: "submitted" | "cancelled" | "expired", submissionId?: string): void;
  linkWork(work: WorkRecord, now?: number): void;
  saveWork(work: WorkRecord, now?: number): void;
  getWorkByIssue(repository: string, issueNumber: number): WorkRecord | null;
  getWorkByPullRequest(repository: string, pullRequestNumber: number): WorkRecord | null;
  resumeBlockedWork(
    repository: string,
    issueNumber: number,
    reason: WorkBlockReason,
    jobKind: string,
    idempotencyKey: string,
    payload: unknown,
    now?: number,
  ): boolean;
  getAdminSummary(now?: number): AdminSummary;
  setProviderCredential(provider: Provider, credential: ProviderCredentialRecord): void;
  getProviderCredential(provider: Provider): ProviderCredentialRecord | null;
  setProviderModelCatalog(catalog: ProviderModelCatalog, now?: number): void;
  getProviderModelCatalog(provider: Provider): ProviderModelCatalog | null;
  setRoutingSettings(settings: RoutingSettings, now?: number): void;
  getRoutingSettings(): RoutingSettings | null;
  saveManagedRepository(repository: ManagedRepositoryInput): void;
  getManagedRepository(repository: string): ManagedRepository | null;
  listManagedRepositories(): ManagedRepository[];
  reserveUsage(
    request: UsageReservationRequest,
    now?: Date,
  ): Promise<{ ok: true; reservationId: string } | { ok: false; reason: BudgetDenialReason }>;
  settleUsage(settlement: UsageSettlement, now?: Date): Promise<boolean>;
  releaseUsage(reservationId: string, now?: Date): Promise<void>;
  getUsageReservation(reservationId: string): UsageReservation | null;
  saveRoutingAttempt(attempt: StoredRoutingAttempt): void;
  getRoutingAttempt(routeId: string): StoredRoutingAttempt | null;
  listRoutingAttempts(jobId: string): StoredRoutingAttempt[];
  finalizeRoutingAttempt(finalization: RoutingAttemptFinalization, now?: Date): Promise<boolean>;
  appendRoutingEvent(event: RouterEvent): void;
  getRoutingSummary(now?: Date): RoutingSummary;
  isReady(): boolean;
  close(): void;
};

type JobRow = {
  id: number;
  kind: string;
  idempotency_key: string;
  payload: string;
  attempts: number;
  status: "pending" | "running";
};

type NotificationRow = {
  id: number;
  idempotency_key: string;
  chat_id: string;
  topic_id: string | null;
  text: string;
  attempts: number;
};

type BindingRow = {
  chat_id: string;
  topic_id: string;
  installation_id: number;
  repository: string;
};

type DraftRow = {
  id: number;
  chat_id: string;
  topic_id: string;
  user_id: string;
};

type DraftItemRow = {
  message_id: number;
  payload: string;
};

type WorkRow = {
  repository: string;
  issue_number: number;
  chat_id: string;
  topic_id: string;
  pull_request_number: number | null;
  provider_job_id: string | null;
  fix_rounds: number;
  state: FlowState;
  head_sha: string | null;
  repair_head_sha: string | null;
  passed_checks: string;
  block_reason: WorkBlockReason | null;
  clarification_id: string | null;
};

type AdminWorkRow = {
  repository: string;
  issue_number: number;
  pull_request_number: number | null;
  fix_rounds: number;
  state: FlowState;
  updated_at: number;
};

const githubRepositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const githubWorkUrl = (
  repository: string,
  kind: "issues" | "pull",
  number: number | null,
): string | null =>
  number !== null && githubRepositoryPattern.test(repository)
    ? `https://github.com/${repository}/${kind}/${number}`
    : null;

const maskTelegramIdentifier = (value: string): string => {
  const normalized = value.replace(/\W/g, "");
  return normalized.length > 4 ? `…${normalized.slice(-4)}` : "…";
};

const toIsoDate = (timestamp: number): string => new Date(timestamp).toISOString();

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
  submission_id TEXT,
  repository TEXT,
  plan_json TEXT,
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
  head_sha TEXT,
  repair_head_sha TEXT,
  passed_checks TEXT NOT NULL DEFAULT '[]',
  block_reason TEXT,
  clarification_id TEXT,
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

CREATE TABLE IF NOT EXISTS provider_credentials (
  provider TEXT PRIMARY KEY,
  sealed_credential TEXT NOT NULL,
  verified_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS control_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS managed_repositories (
  repository TEXT PRIMARY KEY,
  installation_id INTEGER NOT NULL,
  codeowners TEXT NOT NULL,
  setup_pull_request_url TEXT,
  merge_gate_installed INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_reservations (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  month TEXT NOT NULL,
  candidate_json TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  estimated_input_tokens INTEGER NOT NULL,
  estimated_output_tokens INTEGER NOT NULL,
  estimated_cost_micros INTEGER NOT NULL,
  actual_input_tokens INTEGER,
  actual_output_tokens INTEGER,
  actual_cost_micros INTEGER,
  status TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS usage_reservations_month ON usage_reservations(month, status, expires_at);
CREATE INDEX IF NOT EXISTS usage_reservations_job ON usage_reservations(job_id, status);

CREATE TABLE IF NOT EXISTS routing_attempts (
  route_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  role TEXT NOT NULL,
  task_json TEXT NOT NULL,
  candidate_json TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  reservation_id TEXT NOT NULL REFERENCES usage_reservations(id),
  status TEXT NOT NULL,
  failure_category TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS routing_attempts_job ON routing_attempts(job_id, created_at);

CREATE TABLE IF NOT EXISTS routing_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  state TEXT NOT NULL,
  event_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS routing_events_recent ON routing_events(occurred_at DESC, id DESC);
`;

export const openStorage = (path: string): Storage => {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const database = new Database(path);
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");
  database.exec(migration);
  const workColumns = new Set(
    (database.pragma("table_info(work_links)") as Array<{ name: string }>).map((column) => column.name),
  );
  if (!workColumns.has("head_sha")) database.exec("ALTER TABLE work_links ADD COLUMN head_sha TEXT");
  if (!workColumns.has("repair_head_sha")) database.exec("ALTER TABLE work_links ADD COLUMN repair_head_sha TEXT");
  if (!workColumns.has("passed_checks")) {
    database.exec("ALTER TABLE work_links ADD COLUMN passed_checks TEXT NOT NULL DEFAULT '[]'");
  }
  if (!workColumns.has("block_reason")) database.exec("ALTER TABLE work_links ADD COLUMN block_reason TEXT");
  if (!workColumns.has("clarification_id")) database.exec("ALTER TABLE work_links ADD COLUMN clarification_id TEXT");
  const draftColumns = new Set(
    (database.pragma("table_info(drafts)") as Array<{ name: string }>).map((column) => column.name),
  );
  if (!draftColumns.has("submission_id")) database.exec("ALTER TABLE drafts ADD COLUMN submission_id TEXT");
  if (!draftColumns.has("repository")) database.exec("ALTER TABLE drafts ADD COLUMN repository TEXT");
  if (!draftColumns.has("plan_json")) database.exec("ALTER TABLE drafts ADD COLUMN plan_json TEXT");
  database.exec("CREATE UNIQUE INDEX IF NOT EXISTS drafts_submission ON drafts(submission_id) WHERE submission_id IS NOT NULL");
  let open = true;

  const claimJobTransaction = database.transaction((now: number, leaseMs: number) => {
    const row = database
      .prepare(
        `SELECT id, kind, idempotency_key, payload, attempts, status
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

  const mapWork = (row: WorkRow | undefined): WorkRecord | null =>
    row
      ? {
          repository: row.repository,
          issueNumber: row.issue_number,
          chatId: row.chat_id,
          topicId: row.topic_id === "" ? null : row.topic_id,
          pullRequestNumber: row.pull_request_number,
          providerJobId: row.provider_job_id,
          fixRounds: row.fix_rounds,
          state: row.state,
          headSha: row.head_sha,
          repairHeadSha: row.repair_head_sha,
          passedChecks: JSON.parse(row.passed_checks) as string[],
          blockReason: row.block_reason,
          clarificationId: row.clarification_id,
        }
      : null;

  const saveWork = (work: WorkRecord, now: number): void => {
    database
      .prepare(
        `INSERT INTO work_links(
           repository, issue_number, chat_id, topic_id, pull_request_number,
           provider_job_id, fix_rounds, state, head_sha, repair_head_sha, passed_checks,
           block_reason, clarification_id, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(repository, issue_number) DO UPDATE SET
           chat_id = excluded.chat_id,
           topic_id = excluded.topic_id,
           pull_request_number = excluded.pull_request_number,
           provider_job_id = excluded.provider_job_id,
           fix_rounds = excluded.fix_rounds,
           state = excluded.state,
           head_sha = excluded.head_sha,
           repair_head_sha = excluded.repair_head_sha,
           passed_checks = excluded.passed_checks,
           block_reason = excluded.block_reason,
           clarification_id = excluded.clarification_id,
           updated_at = excluded.updated_at`,
      )
      .run(
        work.repository,
        work.issueNumber,
        work.chatId,
        work.topicId ?? "",
        work.pullRequestNumber,
        work.providerJobId,
        work.fixRounds,
        work.state,
        work.headSha,
        work.repairHeadSha,
        JSON.stringify(work.passedChecks),
        work.blockReason ?? null,
        work.clarificationId ?? null,
        now,
      );
  };

  const resumeBlockedWorkTransaction = database.transaction((
    repository: string,
    issueNumber: number,
    reason: WorkBlockReason,
    jobKind: string,
    idempotencyKey: string,
    payload: unknown,
    now: number,
  ) => {
    const resumed = database.prepare(
      `UPDATE work_links
       SET state = 'ready', block_reason = NULL, clarification_id = NULL, updated_at = ?
       WHERE repository = ? AND issue_number = ? AND state = 'blocked' AND block_reason = ?`,
    ).run(now, repository, issueNumber, reason);
    if (resumed.changes !== 1) return false;
    database.prepare(
      `INSERT OR IGNORE INTO jobs(kind, idempotency_key, payload, available_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(jobKind, idempotencyKey, JSON.stringify(payload), now, now, now);
    return true;
  });

  const saveWorkAndEnqueueJobsTransaction = database.transaction((
    work: WorkRecord,
    jobs: JobInput[],
    now: number,
  ) => {
    saveWork(work, now);
    const statement = database.prepare(
      `INSERT OR IGNORE INTO jobs(kind, idempotency_key, payload, available_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const job of jobs) {
      statement.run(
        job.kind,
        job.idempotencyKey,
        JSON.stringify(job.payload),
        job.availableAt ?? now,
        now,
        now,
      );
    }
  });

  const expireReservations = (now: number): void => {
    database.prepare(
      `UPDATE usage_reservations
       SET status = 'released', updated_at = ?
       WHERE status = 'reserved' AND expires_at <= ?
         AND NOT EXISTS (
           SELECT 1 FROM routing_attempts
           WHERE routing_attempts.reservation_id = usage_reservations.id
             AND routing_attempts.status = 'reserved'
         )`,
    ).run(now, now);
  };

  const usageTotals = (
    where: "job_id" | "month",
    value: string,
  ): { tokens: number; cost: number } => {
    const row = database.prepare(
      `SELECT
         COALESCE(SUM(CASE
           WHEN status = 'reserved' THEN estimated_input_tokens + estimated_output_tokens
           WHEN status = 'settled' THEN actual_input_tokens + actual_output_tokens
           ELSE 0 END), 0) AS tokens,
         COALESCE(SUM(CASE
           WHEN status = 'reserved' THEN estimated_cost_micros
           WHEN status = 'settled' THEN actual_cost_micros
           ELSE 0 END), 0) AS cost
       FROM usage_reservations
       WHERE ${where} = ? AND status IN ('reserved', 'settled')`,
    ).get(value) as { tokens: number; cost: number };
    return row;
  };

  const reserveUsageTransaction = database.transaction((request: UsageReservationRequest, now: Date) => {
    const nowMs = now.getTime();
    const expiresAt = new Date(request.expiresAt).getTime();
    if (!Number.isFinite(expiresAt) || expiresAt <= nowMs) throw new Error("Usage reservation expiry must be in the future");
    expireReservations(nowMs);
    const requestedTokens = request.estimatedUsage.inputTokens + request.estimatedUsage.outputTokens;
    if (requestedTokens > request.limits.perJobTokens) return { ok: false as const, reason: "job_tokens" as const };
    if (request.estimatedCostMicros > request.limits.perJobCostMicros) {
      return { ok: false as const, reason: "job_cost" as const };
    }
    const job = usageTotals("job_id", request.jobId);
    if (job.tokens + requestedTokens > request.limits.perJobTokens) {
      return { ok: false as const, reason: "job_tokens" as const };
    }
    if (job.cost + request.estimatedCostMicros > request.limits.perJobCostMicros) {
      return { ok: false as const, reason: "job_cost" as const };
    }
    const month = usageTotals("month", request.month);
    if (month.tokens + requestedTokens > request.limits.monthlyTokens) {
      return { ok: false as const, reason: "monthly_tokens" as const };
    }
    if (month.cost + request.estimatedCostMicros > request.limits.monthlyCostMicros) {
      return { ok: false as const, reason: "monthly_cost" as const };
    }
    const reservationId = randomUUID();
    database.prepare(
      `INSERT INTO usage_reservations(
         id, job_id, month, candidate_json, attempt,
         estimated_input_tokens, estimated_output_tokens, estimated_cost_micros,
         status, expires_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?)`,
    ).run(
      reservationId,
      request.jobId,
      request.month,
      JSON.stringify(request.candidate),
      request.attempt,
      request.estimatedUsage.inputTokens,
      request.estimatedUsage.outputTokens,
      request.estimatedCostMicros,
      expiresAt,
      nowMs,
      nowMs,
    );
    return { ok: true as const, reservationId };
  });

  const finalizeRoutingAttemptTransaction = database.transaction((
    finalization: RoutingAttemptFinalization,
    now: Date,
  ) => {
    const attempt = database.prepare(
      "SELECT reservation_id, status FROM routing_attempts WHERE route_id = ?",
    ).get(finalization.routeId) as { reservation_id: string; status: StoredRoutingAttempt["status"] } | undefined;
    if (!attempt || attempt.status !== "reserved") return false;

    let usageChanges: number;
    if (finalization.settlement) {
      if (finalization.settlement.reservationId !== attempt.reservation_id) {
        throw new Error("Usage reservation does not belong to the provider route");
      }
      usageChanges = database.prepare(
        `UPDATE usage_reservations
         SET status = 'settled', actual_input_tokens = ?, actual_output_tokens = ?,
             actual_cost_micros = ?, updated_at = ?
         WHERE id = ? AND status = 'reserved'`,
      ).run(
        finalization.settlement.actualUsage.inputTokens,
        finalization.settlement.actualUsage.outputTokens,
        finalization.settlement.actualCostMicros,
        now.getTime(),
        finalization.settlement.reservationId,
      ).changes;
    } else {
      usageChanges = database.prepare(
        "UPDATE usage_reservations SET status = 'released', updated_at = ? WHERE id = ? AND status = 'reserved'",
      ).run(now.getTime(), attempt.reservation_id).changes;
    }
    if (usageChanges !== 1) return false;

    const attemptChanges = database.prepare(
      `UPDATE routing_attempts
       SET status = ?, failure_category = ?, updated_at = ?
       WHERE route_id = ? AND status = 'reserved'`,
    ).run(
      finalization.status,
      finalization.failureCategory,
      finalization.event.occurredAt,
      finalization.routeId,
    ).changes;
    if (attemptChanges !== 1) throw new Error("Provider route is no longer active");

    database.prepare(
      "INSERT INTO routing_events(job_id, state, event_json, occurred_at) VALUES (?, ?, ?, ?)",
    ).run(
      finalization.event.jobId,
      finalization.event.state,
      JSON.stringify(finalization.event),
      finalization.event.occurredAt,
    );
    return true;
  });

  const mapRoutingAttempt = (row: {
    route_id: string;
    task_json: string;
    candidate_json: string;
    attempt: number;
    reservation_id: string;
    status: "reserved" | "complete" | "failed";
    failure_category: ProviderFailureCategory | null;
    created_at: string;
    updated_at: string;
  } | undefined): StoredRoutingAttempt | null => row
    ? {
        routeId: row.route_id,
        task: JSON.parse(row.task_json) as RoutingTask,
        candidate: JSON.parse(row.candidate_json) as ModelCandidate,
        attempt: row.attempt,
        reservationId: row.reservation_id,
        status: row.status,
        failureCategory: row.failure_category,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    : null;

  return {
    recordWebhook(source, deliveryId, payloadHash) {
      const result = database
        .prepare(
          "INSERT OR IGNORE INTO webhook_receipts(source, delivery_id, payload_hash, received_at) VALUES (?, ?, ?, ?)",
        )
        .run(source, deliveryId, payloadHash, Date.now());
      return result.changes === 1;
    },

    recordWebhookJob(source, deliveryId, payloadHash, kind, idempotencyKey, payload, now = Date.now()) {
      const transaction = database.transaction(() => {
        const receipt = database
          .prepare(
            "INSERT OR IGNORE INTO webhook_receipts(source, delivery_id, payload_hash, received_at) VALUES (?, ?, ?, ?)",
          )
          .run(source, deliveryId, payloadHash, now);
        if (receipt.changes !== 1) return false;
        database
          .prepare(
            `INSERT INTO jobs(kind, idempotency_key, payload, available_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(kind, idempotencyKey, JSON.stringify(payload), now, now, now);
        return true;
      });
      return transaction.immediate();
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

    saveWorkAndEnqueueJobs(work, jobs, now = Date.now()) {
      saveWorkAndEnqueueJobsTransaction.immediate(work, jobs, now);
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
            reclaimed: row.status === "running",
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

    failNotification(id, error, now, options) {
      const row = database.prepare("SELECT attempts FROM outbox WHERE id = ?").get(id) as
        | { attempts: number }
        | undefined;
      if (!row) throw new Error(`Unknown notification ${id}`);
      const attempts = row.attempts + 1;
      const permanent = options.permanent === true || attempts >= options.maxAttempts;
      const jitter = options.jitterMs ?? Math.floor(Math.random() * 500);
      const availableAt = now + Math.min(3_600_000, 1_000 * 2 ** attempts) + jitter;
      database
        .prepare(
          `UPDATE outbox
           SET status = ?, attempts = ?, available_at = ?, lease_until = NULL, updated_at = ?
           WHERE id = ?`,
        )
        .run(permanent ? "failed" : "pending", attempts, availableAt, now, id);
    },

    bindChat(chatId, topicId, installationId, repository, now = Date.now()) {
      database
        .prepare(
          `INSERT INTO chat_bindings(chat_id, topic_id, installation_id, repository, created_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(chat_id, topic_id) DO UPDATE SET
             installation_id = excluded.installation_id,
             repository = excluded.repository,
             created_at = excluded.created_at`,
        )
        .run(chatId, topicId ?? "", installationId, repository, now);
    },

    getChatBinding(chatId, topicId) {
      const row = database
        .prepare(
          `SELECT chat_id, topic_id, installation_id, repository
           FROM chat_bindings WHERE chat_id = ? AND topic_id = ?`,
        )
        .get(chatId, topicId ?? "") as BindingRow | undefined;
      return row
        ? {
            chatId: row.chat_id,
            topicId: row.topic_id === "" ? null : row.topic_id,
            installationId: row.installation_id,
            repository: row.repository,
          }
        : null;
    },

    startDraft(chatId, topicId, userId, now = Date.now(), ttlMs = 86_400_000) {
      const transaction = database.transaction(() => {
        database
          .prepare(
            `UPDATE drafts SET status = 'cancelled'
             WHERE chat_id = ? AND topic_id = ? AND user_id = ? AND status = 'open'`,
          )
          .run(chatId, topicId ?? "", userId);
        const result = database
          .prepare(
            `INSERT INTO drafts(chat_id, topic_id, user_id, expires_at, created_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(chatId, topicId ?? "", userId, now + ttlMs, now);
        return Number(result.lastInsertRowid);
      });
      return transaction.immediate();
    },

    appendDraftItem(draftId, messageId, item, now = Date.now()) {
      const result = database
        .prepare(
          `INSERT OR IGNORE INTO draft_items(draft_id, message_id, kind, payload, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(draftId, messageId, item.kind, JSON.stringify(item), now);
      return result.changes === 1;
    },

    getOpenDraft(chatId, topicId, userId, now = Date.now()) {
      const row = database
        .prepare(
          `SELECT id, chat_id, topic_id, user_id FROM drafts
           WHERE chat_id = ? AND topic_id = ? AND user_id = ? AND status = 'open' AND expires_at > ?`,
        )
        .get(chatId, topicId ?? "", userId, now) as DraftRow | undefined;
      if (!row) return null;
      const items = database
        .prepare("SELECT message_id, payload FROM draft_items WHERE draft_id = ? ORDER BY id")
        .all(row.id) as DraftItemRow[];
      return {
        id: row.id,
        chatId: row.chat_id,
        topicId: row.topic_id === "" ? null : row.topic_id,
        userId: row.user_id,
        messageIds: items.map((item) => item.message_id),
        items: items.map((item) => JSON.parse(item.payload) as FeedbackItem),
      };
    },

    getDraftBySubmission(submissionId) {
      const row = database
        .prepare(
          `SELECT id, chat_id, topic_id, user_id FROM drafts
           WHERE submission_id = ?`,
        )
        .get(submissionId) as DraftRow | undefined;
      if (!row) return null;
      const items = database
        .prepare("SELECT message_id, payload FROM draft_items WHERE draft_id = ? ORDER BY id")
        .all(row.id) as DraftItemRow[];
      return {
        id: row.id,
        chatId: row.chat_id,
        topicId: row.topic_id === "" ? null : row.topic_id,
        userId: row.user_id,
        messageIds: items.map((item) => item.message_id),
        items: items.map((item) => JSON.parse(item.payload) as FeedbackItem),
      };
    },

    saveSubmissionPlan(draftId, submissionId, repository, plan) {
      database
        .prepare(
          `UPDATE drafts SET submission_id = ?, repository = ?, plan_json = ?
           WHERE id = ? AND (submission_id IS NULL OR submission_id = ?)`,
        )
        .run(submissionId, repository, JSON.stringify(plan), draftId, submissionId);
    },

    getSubmissionPlan(draftId) {
      const row = database
        .prepare("SELECT repository, plan_json FROM drafts WHERE id = ?")
        .get(draftId) as { repository: string | null; plan_json: string | null } | undefined;
      return row?.repository && row.plan_json
        ? { repository: row.repository, plan: JSON.parse(row.plan_json) as WorkPlan }
        : null;
    },

    closeDraft(id, status, submissionId) {
      database
        .prepare("UPDATE drafts SET status = ?, submission_id = COALESCE(?, submission_id) WHERE id = ? AND status = 'open'")
        .run(status, submissionId ?? null, id);
    },

    linkWork(work, now = Date.now()) {
      saveWork(work, now);
    },

    saveWork(work, now = Date.now()) {
      saveWork(work, now);
    },

    getWorkByIssue(repository, issueNumber) {
      const row = database
        .prepare("SELECT * FROM work_links WHERE repository = ? AND issue_number = ?")
        .get(repository, issueNumber) as WorkRow | undefined;
      return mapWork(row);
    },

    getWorkByPullRequest(repository, pullRequestNumber) {
      const row = database
        .prepare("SELECT * FROM work_links WHERE repository = ? AND pull_request_number = ?")
        .get(repository, pullRequestNumber) as WorkRow | undefined;
      return mapWork(row);
    },

    resumeBlockedWork(repository, issueNumber, reason, jobKind, idempotencyKey, payload, now = Date.now()) {
      return resumeBlockedWorkTransaction.immediate(
        repository,
        issueNumber,
        reason,
        jobKind,
        idempotencyKey,
        payload,
        now,
      );
    },

    getAdminSummary(now = Date.now()) {
      const repositories = database
        .prepare(
          `SELECT repository, chat_id, topic_id, created_at
           FROM chat_bindings
           ORDER BY repository, created_at DESC`,
        )
        .all() as Array<{
          repository: string;
          chat_id: string;
          topic_id: string;
          created_at: number;
        }>;
      const jobCounts = database
        .prepare("SELECT status, COUNT(*) AS count FROM jobs GROUP BY status")
        .all() as Array<{ status: string; count: number }>;
      const workCounts = database
        .prepare("SELECT state, COUNT(*) AS count FROM work_links GROUP BY state")
        .all() as Array<{ state: string; count: number }>;
      const recentWorkRows = database
        .prepare(
          `SELECT repository, issue_number, pull_request_number, fix_rounds, state, updated_at
           FROM work_links
           ORDER BY updated_at DESC
           LIMIT 25`,
        )
        .all() as AdminWorkRow[];
      const approvalRows = database
        .prepare(
          `SELECT repository, issue_number, pull_request_number, fix_rounds, state, updated_at
           FROM work_links
           WHERE state = 'human'
           ORDER BY updated_at DESC
           LIMIT 25`,
        )
        .all() as AdminWorkRow[];
      const failureRows = database
        .prepare(
          `SELECT source, kind, attempts, updated_at
           FROM (
             SELECT 'job' AS source, kind, attempts, updated_at
             FROM jobs WHERE status = 'failed'
             UNION ALL
             SELECT 'notification' AS source, 'delivery' AS kind, attempts, updated_at
             FROM outbox WHERE status = 'failed'
           )
           ORDER BY updated_at DESC
           LIMIT 10`,
        )
        .all() as Array<{
          source: "job" | "notification";
          kind: string;
          attempts: number;
          updated_at: number;
        }>;
      const jobStates: AdminSummary["jobStates"] = {
        pending: 0,
        running: 0,
        complete: 0,
        failed: 0,
      };
      for (const row of jobCounts) {
        if (row.status in jobStates) jobStates[row.status as keyof typeof jobStates] = row.count;
      }
      const workStates: AdminSummary["workStates"] = {
        inbox: 0,
        ready: 0,
        working: 0,
        blocked: 0,
        human: 0,
        done: 0,
      };
      for (const row of workCounts) {
        if (row.state in workStates) workStates[row.state as FlowState] = row.count;
      }
      const mapAdminWork = (row: AdminWorkRow): AdminWorkItem => ({
        repository: row.repository,
        state: row.state,
        issueNumber: row.issue_number,
        issueUrl: githubWorkUrl(row.repository, "issues", row.issue_number),
        pullRequestNumber: row.pull_request_number,
        pullRequestUrl: githubWorkUrl(row.repository, "pull", row.pull_request_number),
        fixRounds: row.fix_rounds,
        updatedAt: toIsoDate(row.updated_at),
      });

      return {
        generatedAt: toIsoDate(now),
        storageReady: open,
        repositories: repositories.map((row) => ({
          repository: row.repository,
          context: `Telegram ${maskTelegramIdentifier(row.chat_id)}${
            row.topic_id === "" ? "" : ` / topic ${maskTelegramIdentifier(row.topic_id)}`
          }`,
          boundAt: toIsoDate(row.created_at),
        })),
        jobStates,
        workStates,
        recentWork: recentWorkRows.map(mapAdminWork),
        recentFailures: failureRows.map((row) => ({
          source: row.source,
          kind: row.kind,
          attempts: row.attempts,
          failedAt: toIsoDate(row.updated_at),
        })),
        awaitingApproval: approvalRows.map((row) => {
          const work = mapAdminWork(row);
          return {
            repository: work.repository,
            issueNumber: work.issueNumber,
            issueUrl: work.issueUrl,
            pullRequestNumber: work.pullRequestNumber,
            pullRequestUrl: work.pullRequestUrl,
            updatedAt: work.updatedAt,
          };
        }),
      };
    },

    setProviderCredential(provider, credential) {
      database.prepare(
        `INSERT INTO provider_credentials(provider, sealed_credential, verified_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(provider) DO UPDATE SET
           sealed_credential = excluded.sealed_credential,
           verified_at = excluded.verified_at,
           updated_at = excluded.updated_at`,
      ).run(provider, credential.sealed, credential.verifiedAt, credential.updatedAt);
    },

    getProviderCredential(provider) {
      const row = database.prepare(
        "SELECT sealed_credential, verified_at, updated_at FROM provider_credentials WHERE provider = ?",
      ).get(provider) as { sealed_credential: string; verified_at: string; updated_at: string } | undefined;
      return row
        ? { sealed: row.sealed_credential, verifiedAt: row.verified_at, updatedAt: row.updated_at }
        : null;
    },

    setProviderModelCatalog(catalog, now = Date.now()) {
      database.prepare(
        `INSERT INTO control_settings(key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ).run(`models:${catalog.provider}`, JSON.stringify(catalog), now);
    },

    getProviderModelCatalog(provider) {
      const row = database.prepare("SELECT value FROM control_settings WHERE key = ?")
        .get(`models:${provider}`) as { value: string } | undefined;
      return row ? JSON.parse(row.value) as ProviderModelCatalog : null;
    },

    setRoutingSettings(settings, now = Date.now()) {
      database.prepare(
        `INSERT INTO control_settings(key, value, updated_at) VALUES ('routing', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ).run(JSON.stringify(settings), now);
    },

    getRoutingSettings() {
      const row = database.prepare("SELECT value FROM control_settings WHERE key = 'routing'")
        .get() as { value: string } | undefined;
      return row ? JSON.parse(row.value) as RoutingSettings : null;
    },

    saveManagedRepository(repository) {
      database.prepare(
        `INSERT INTO managed_repositories(
           repository, installation_id, codeowners, setup_pull_request_url, merge_gate_installed, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(repository) DO UPDATE SET
           installation_id = excluded.installation_id,
           codeowners = excluded.codeowners,
           setup_pull_request_url = excluded.setup_pull_request_url,
           merge_gate_installed = excluded.merge_gate_installed,
           updated_at = excluded.updated_at`,
      ).run(
        repository.repository,
        repository.installationId,
        JSON.stringify(repository.codeowners),
        repository.setupPullRequestUrl,
        repository.mergeGateInstalled ? 1 : 0,
        repository.updatedAt,
      );
    },

    getManagedRepository(repository) {
      const row = database.prepare("SELECT * FROM managed_repositories WHERE repository = ?")
        .get(repository) as {
          repository: string;
          installation_id: number;
          codeowners: string;
          setup_pull_request_url: string | null;
          merge_gate_installed: number;
          updated_at: string;
        } | undefined;
      return row
        ? {
            repository: row.repository,
            installationId: row.installation_id,
            codeowners: JSON.parse(row.codeowners) as string[],
            setupPullRequestUrl: row.setup_pull_request_url,
            mergeGateInstalled: row.merge_gate_installed === 1,
            status: row.merge_gate_installed === 1 ? "active" : "pending",
            updatedAt: row.updated_at,
          }
        : null;
    },

    listManagedRepositories() {
      const rows = database.prepare("SELECT repository FROM managed_repositories ORDER BY repository")
        .all() as Array<{ repository: string }>;
      return rows.flatMap((row) => {
        const repository = this.getManagedRepository(row.repository);
        return repository ? [repository] : [];
      });
    },

    async reserveUsage(request, now = new Date()) {
      return reserveUsageTransaction.immediate(request, now);
    },

    async settleUsage(settlement, now = new Date()) {
      const result = database.prepare(
        `UPDATE usage_reservations
         SET status = 'settled', actual_input_tokens = ?, actual_output_tokens = ?,
             actual_cost_micros = ?, updated_at = ?
         WHERE id = ? AND status = 'reserved'`,
      ).run(
        settlement.actualUsage.inputTokens,
        settlement.actualUsage.outputTokens,
        settlement.actualCostMicros,
        now.getTime(),
        settlement.reservationId,
      );
      return result.changes === 1;
    },

    async releaseUsage(reservationId, now = new Date()) {
      database.prepare(
        "UPDATE usage_reservations SET status = 'released', updated_at = ? WHERE id = ? AND status = 'reserved'",
      ).run(now.getTime(), reservationId);
    },

    getUsageReservation(reservationId) {
      const row = database.prepare("SELECT * FROM usage_reservations WHERE id = ?").get(reservationId) as {
        id: string;
        job_id: string;
        candidate_json: string;
        attempt: number;
        estimated_input_tokens: number;
        estimated_output_tokens: number;
        estimated_cost_micros: number;
        status: "reserved" | "settled" | "released";
      } | undefined;
      return row
        ? {
            id: row.id,
            jobId: row.job_id,
            candidate: JSON.parse(row.candidate_json) as ModelCandidate,
            attempt: row.attempt,
            estimatedUsage: {
              inputTokens: row.estimated_input_tokens,
              outputTokens: row.estimated_output_tokens,
            },
            estimatedCostMicros: row.estimated_cost_micros,
            status: row.status,
          }
        : null;
    },

    saveRoutingAttempt(attempt) {
      database.prepare(
        `INSERT INTO routing_attempts(
           route_id, job_id, role, task_json, candidate_json, attempt,
           reservation_id, status, failure_category, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        attempt.routeId,
        attempt.task.jobId,
        attempt.task.role,
        JSON.stringify(attempt.task),
        JSON.stringify(attempt.candidate),
        attempt.attempt,
        attempt.reservationId,
        attempt.status,
        attempt.failureCategory,
        attempt.createdAt,
        attempt.updatedAt,
      );
    },

    getRoutingAttempt(routeId) {
      const row = database.prepare("SELECT * FROM routing_attempts WHERE route_id = ?").get(routeId) as Parameters<typeof mapRoutingAttempt>[0];
      return mapRoutingAttempt(row);
    },

    listRoutingAttempts(jobId) {
      const rows = database.prepare("SELECT * FROM routing_attempts WHERE job_id = ? ORDER BY rowid")
        .all(jobId) as Array<NonNullable<Parameters<typeof mapRoutingAttempt>[0]>>;
      return rows.flatMap((row) => {
        const attempt = mapRoutingAttempt(row);
        return attempt ? [attempt] : [];
      });
    },

    async finalizeRoutingAttempt(finalization, now = new Date()) {
      return finalizeRoutingAttemptTransaction.immediate(finalization, now);
    },

    appendRoutingEvent(event) {
      database.prepare(
        "INSERT INTO routing_events(job_id, state, event_json, occurred_at) VALUES (?, ?, ?, ?)",
      ).run(event.jobId, event.state, JSON.stringify(event), event.occurredAt);
    },

    getRoutingSummary(now = new Date()) {
      expireReservations(now.getTime());
      const month = now.toISOString().slice(0, 7);
      const rows = database.prepare(
        `SELECT status,
                estimated_input_tokens + estimated_output_tokens AS estimated_tokens,
                estimated_cost_micros,
                COALESCE(actual_input_tokens, 0) + COALESCE(actual_output_tokens, 0) AS actual_tokens,
                COALESCE(actual_cost_micros, 0) AS actual_cost_micros
         FROM usage_reservations WHERE month = ? AND status IN ('reserved', 'settled')`,
      ).all(month) as Array<{
        status: "reserved" | "settled";
        estimated_tokens: number;
        estimated_cost_micros: number;
        actual_tokens: number;
        actual_cost_micros: number;
      }>;
      const events = database.prepare("SELECT event_json FROM routing_events ORDER BY occurred_at DESC, id DESC LIMIT 25")
        .all() as Array<{ event_json: string }>;
      return {
        month,
        reservedTokens: rows.filter((row) => row.status === "reserved").reduce((sum, row) => sum + row.estimated_tokens, 0),
        settledTokens: rows.filter((row) => row.status === "settled").reduce((sum, row) => sum + row.actual_tokens, 0),
        reservedCostMicros: rows.filter((row) => row.status === "reserved").reduce((sum, row) => sum + row.estimated_cost_micros, 0),
        settledCostMicros: rows.filter((row) => row.status === "settled").reduce((sum, row) => sum + row.actual_cost_micros, 0),
        recentEvents: events.map((row) => JSON.parse(row.event_json) as RouterEvent),
      };
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
