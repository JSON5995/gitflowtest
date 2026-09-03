# GitFlow AI v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a single deployable service that turns Telegram feedback into planned GitHub work, dispatches isolated coding agents, gates pull requests with independent review and deterministic QA, and returns status to Telegram.

**Architecture:** A TypeScript/Fastify process handles Telegram and GitHub webhooks, a SQLite-backed job/outbox loop, multimodal intake, and GitHub App operations. GitHub Issues and Actions own the development lifecycle; repositories receive a small contract and three workflows. Codex builds by default, Claude reviews, and Cursor remains an optional builder adapter.

**Tech Stack:** Node.js 22, TypeScript, Fastify, Zod, Octokit, better-sqlite3, jose, Vitest, Docker, GitHub Actions, Telegram Bot API, OpenAI Responses/Audio APIs, Claude Code Action, Codex Action.

**Spec:** `docs/superpowers/specs/2026-09-03-gitflow-ai-blueprint-design.md`

## Global Constraints

- One deployable process and one SQLite database in WAL mode.
- GitHub is the durable work record; SQLite stores bindings, drafts, idempotency, jobs, and notification outbox entries only.
- No dashboard, Kubernetes, Redis, message broker, vector database, autonomous merge, or production deployment.
- Telegram chat plus forum-topic maps to exactly one installed GitHub repository.
- Repository commands are argument arrays and execute with `shell: false` from the base commit's `.flow/config.json`.
- Planner creates zero to four sub-issues and splits only independently mergeable work.
- Builder and reviewer providers must differ.
- AI Apps cannot merge or bypass the default-branch ruleset.
- Webhook handlers verify, persist, and acknowledge before slow work starts.
- Two automatic code-fix rounds maximum.
- All external effects require an idempotency key.

## File map

```text
package.json                         scripts and locked dependencies
tsconfig.json                        strict TypeScript configuration
vitest.config.ts                     unit and integration test configuration
src/domain.ts                        shared domain types and state labels
src/config.ts                        environment parsing and invariants
src/server.ts                        Fastify composition and health endpoints
src/storage.ts                       SQLite schema, transactions, jobs, and outbox
src/telegram.ts                      Telegram verification, parsing, drafts, and replies
src/intake.ts                        media download, transcription, vision, and plan schema
src/github.ts                        GitHub App auth, issue/PR operations, and webhook handling
src/orchestrator.ts                  state transitions and retry/fix policies
src/cursor.ts                        optional Cursor Cloud Agent adapter
src/cli.ts                           setup, doctor, and repository onboarding commands
tests/*.test.ts                      behavior tests with local HTTP fakes
fixtures/*.json                      redacted Telegram/GitHub webhook fixtures
repo-kit/.flow/config.json           example repository command contract
repo-kit/.flow/AI_RULES.md            canonical coding and review rules
repo-kit/scripts/run-contract.mjs    safe command-array executor
repo-kit/.github/workflows/*.yml     build, review, and QA workflows
Dockerfile                           production image
docker-compose.yml                   one-service deployment and persistent volume
flow                                 setup/doctor/repo CLI wrapper
.env.example                         complete redacted configuration template
README.md                            operator quickstart and recovery guide
```

---

### Task 1: Service foundation and validated configuration

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `src/domain.ts`
- Create: `src/config.ts`
- Create: `src/server.ts`
- Test: `tests/config.test.ts`
- Test: `tests/health.test.ts`

**Interfaces:**
- Produces: `AppConfig`, `FeedbackBundle`, `WorkPlan`, `FlowState`, `loadConfig(env)`, and `buildServer(deps)`.
- Consumes: no earlier task interfaces.

- [ ] **Step 1: Create the package and compiler configuration**

Use ESM, strict TypeScript, Node 22, and scripts `build`, `dev`, `start`, `test`, `test:watch`, `typecheck`, and `lint`. Install runtime dependencies `fastify`, `zod`, `@octokit/app`, `@octokit/webhooks`, `better-sqlite3`, and `jose`; install TypeScript, Vitest, ESLint, and matching type packages as development dependencies. Commit the generated lockfile.

- [ ] **Step 2: Write failing configuration tests**

```ts
it("rejects identical builder and reviewer providers", () => {
  expect(() => loadConfig(validEnv({ FLOW_BUILDER: "codex", FLOW_REVIEWER: "codex" })))
    .toThrow(/must differ/);
});

it("requires an https public URL outside tests", () => {
  expect(() => loadConfig(validEnv({ PUBLIC_URL: "http://example.com" })))
    .toThrow(/https/);
});
```

- [ ] **Step 3: Run the tests and verify failure**

Run: `npm test -- tests/config.test.ts`  
Expected: FAIL because `loadConfig` does not exist.

- [ ] **Step 4: Implement shared types and environment validation**

Define:

```ts
export type Provider = "codex" | "claude" | "cursor";
export type FlowState = "inbox" | "ready" | "working" | "blocked" | "human" | "done";
export type FeedbackItem =
  | { kind: "text"; text: string }
  | { kind: "photo" | "document" | "voice"; fileId: string; mimeType?: string; caption?: string };
export type FeedbackBundle = {
  source: { chatId: string; topicId: string | null; userId: string; messageIds: number[] };
  repository: string;
  items: FeedbackItem[];
};
export type WorkUnit = { title: string; body: string; canRunInParallel: boolean };
export type WorkPlan = {
  title: string;
  problem: string;
  evidence: string[];
  acceptanceCriteria: string[];
  nonGoals: string[];
  risks: string[];
  needsHumanInput: boolean;
  units: WorkUnit[];
};
```

Validate every variable listed in the spec, parse comma-delimited admin IDs, set default limits, and fail when the builder/reviewer match or Cursor is selected without `CURSOR_API_KEY`.

- [ ] **Step 5: Add health behavior and tests**

Test that `/health/live` always returns `{ "ok": true }` and `/health/ready` returns 503 when storage is not writable. Implement `buildServer` with dependency injection so tests do not contact external services.

- [ ] **Step 6: Verify and commit**

Run: `npm run typecheck && npm test`  
Expected: PASS.  
Commit: `feat: establish validated service foundation`

---

### Task 2: Durable SQLite jobs, idempotency, and notification outbox

**Files:**
- Create: `src/storage.ts`
- Test: `tests/storage.test.ts`

**Interfaces:**
- Consumes: `FlowState` from `src/domain.ts`.
- Produces: `openStorage(path)`, `Storage.recordWebhook`, `Storage.enqueueJob`, `Storage.claimJob`, `Storage.completeJob`, `Storage.failJob`, `Storage.enqueueNotification`, and `Storage.claimNotification`.

- [ ] **Step 1: Write failing transaction and deduplication tests**

```ts
it("records one webhook delivery exactly once", () => {
  const storage = openStorage(":memory:");
  expect(storage.recordWebhook("telegram", "101", "hash-a")).toBe(true);
  expect(storage.recordWebhook("telegram", "101", "hash-a")).toBe(false);
});

it("reclaims a job whose lease expired", () => {
  const storage = openStorage(":memory:");
  storage.enqueueJob("intake", "issue:7", { issue: 7 });
  const first = storage.claimJob(1000, 30_000);
  expect(first?.idempotencyKey).toBe("issue:7");
  expect(storage.claimJob(31_001, 30_000)?.id).toBe(first?.id);
});
```

- [ ] **Step 2: Run and verify failure**

Run: `npm test -- tests/storage.test.ts`  
Expected: FAIL because `openStorage` does not exist.

- [ ] **Step 3: Implement the schema in one migration**

Create tables `chat_bindings`, `drafts`, `draft_items`, `webhook_receipts`, `jobs`, `work_links`, and `outbox`. Enforce unique keys on `(source, delivery_id)`, `jobs.idempotency_key`, and `outbox.idempotency_key`. Enable `journal_mode=WAL`, `foreign_keys=ON`, and `busy_timeout=5000`.

- [ ] **Step 4: Implement atomic claim and retry behavior**

Use `BEGIN IMMEDIATE` to select the oldest due row and set `lease_until` in one transaction. `failJob` increments attempts and calculates `next_attempt_at = now + min(3600000, 1000 * 2^attempts) + jitter`. Mark validation and authentication failures permanent.

- [ ] **Step 5: Verify restart and outbox safety**

Add tests that close/reopen a temporary database, reclaim an expired lease, and prove a notification cannot be inserted twice. Run: `npm test -- tests/storage.test.ts`. Expected: PASS.

- [ ] **Step 6: Commit**

Commit: `feat: add durable local job and outbox storage`

---

### Task 3: Telegram intake adapter and draft UX

**Files:**
- Create: `src/telegram.ts`
- Create: `fixtures/telegram-text.json`
- Create: `fixtures/telegram-photo.json`
- Create: `fixtures/telegram-voice.json`
- Test: `tests/telegram.test.ts`

**Interfaces:**
- Consumes: `FeedbackBundle`, `FeedbackItem`, storage draft APIs, `TELEGRAM_WEBHOOK_SECRET`, and admin IDs.
- Produces: `verifyTelegramSecret(headers)`, `parseTelegramUpdate(update)`, `TelegramClient`, and `registerTelegramRoutes(server, deps)`.

- [ ] **Step 1: Add redacted webhook fixtures and failing parser tests**

Cover text, photo caption, voice `file_id`, forum `message_thread_id`, callback button submission, unauthorized user, and duplicate update ID. Assert that a photo album becomes one draft item group and that user/chat IDs are stored as strings.

- [ ] **Step 2: Run and verify failure**

Run: `npm test -- tests/telegram.test.ts`  
Expected: FAIL because the parser and routes do not exist.

- [ ] **Step 3: Implement verification and pure update parsing**

Compare the incoming `X-Telegram-Bot-Api-Secret-Token` using a timing-safe equality function. Parse only `message` and `callback_query` updates. Return a discriminated union for `connect`, `newDraft`, `appendItem`, `submitDraft`, `cancelDraft`, and `status`; ignore every other update safely.

- [ ] **Step 4: Implement the draft interaction**

`/new` creates a 24-hour draft. Text/photos/voice/documents append to the current user's draft in the current chat/topic. Inline buttons invoke signed callback values for **Send to GitHub** and **Discard**. `/connect owner/repo` is restricted to configured Telegram administrator IDs and verifies repository access through an injected GitHub function.

- [ ] **Step 5: Acknowledge before processing**

The webhook route verifies the secret, records `update_id`, stores the parsed action, enqueues work, and returns 200. It does not download media or call a model synchronously.

- [ ] **Step 6: Verify and commit**

Run: `npm test -- tests/telegram.test.ts && npm run typecheck`  
Expected: PASS.  
Commit: `feat: capture Telegram feedback bundles`

---

### Task 4: Multimodal intake and conservative work planning

**Files:**
- Create: `src/intake.ts`
- Test: `tests/intake.test.ts`

**Interfaces:**
- Consumes: `FeedbackBundle`, `WorkPlan`, Telegram `getFile`, and trusted repository context.
- Produces: `buildWorkPlan(bundle, context)`, `downloadTelegramFile(fileId)`, and `formatIssueBody(plan, source)`.

- [ ] **Step 1: Write failing schema and decomposition tests**

```ts
it("rejects more than four work units", () => {
  expect(() => WorkPlanSchema.parse(planWithUnits(5))).toThrow();
});

it("keeps dependent work in one unit", async () => {
  const plan = await buildWorkPlan(bundle("schema migration then API"), context, fakeModel);
  expect(plan.units).toHaveLength(1);
});
```

Also test secret redaction, a Telegram file larger than 20 MB, one JSON-repair attempt, and risk words for auth, billing, destructive migrations, production infrastructure, legal, and privacy behavior.

- [ ] **Step 2: Run and verify failure**

Run: `npm test -- tests/intake.test.ts`  
Expected: FAIL because the intake processor does not exist.

- [ ] **Step 3: Implement media normalization**

Call Telegram `getFile`, download into a size-capped temporary file, transcribe voice through the OpenAI Audio API, and send photos to the multimodal intake request. Delete temporary files in `finally`. Replace common token/key/password patterns with `[REDACTED]` before prompts or logs.

- [ ] **Step 4: Implement strict planning output**

Use the `WorkPlan` JSON schema with strict parsing. The system prompt must require explicit acceptance criteria, prohibit invented facts, cap units at four, and collapse dependent/shared-core work into one unit. On invalid output, make exactly one repair call containing validation errors; otherwise mark the work blocked.

- [ ] **Step 5: Format a stable GitHub issue body**

Render sections: Problem, Evidence, Acceptance criteria, Non-goals, Risks, Source, and Work units. Escape user-authored HTML, omit provider chain-of-thought, and include Telegram message IDs rather than bot-token file URLs.

- [ ] **Step 6: Verify and commit**

Run: `npm test -- tests/intake.test.ts && npm run typecheck`  
Expected: PASS.  
Commit: `feat: digest multimodal feedback into work plans`

---

### Task 5: GitHub App authentication and issue lifecycle

**Files:**
- Create: `src/github.ts`
- Create: `fixtures/github-issues-labeled.json`
- Create: `fixtures/github-pull-request.json`
- Create: `fixtures/github-check-suite.json`
- Test: `tests/github.test.ts`

**Interfaces:**
- Consumes: `WorkPlan`, `FlowState`, GitHub App ID/private key/webhook secret, and storage idempotency APIs.
- Produces: `GitHubGateway.verifyWebhook`, `hasRepositoryAccess`, `createPlannedIssue`, `setFlowState`, `dispatchBuild`, and `registerGitHubRoutes`.

- [ ] **Step 1: Write failing authentication, idempotency, and label tests**

Verify that an invalid HMAC returns 401, the same `X-GitHub-Delivery` is acknowledged without duplicate work, exactly one `flow:*` state label remains after a transition, and unavailable repositories cannot be bound.

- [ ] **Step 2: Run and verify failure**

Run: `npm test -- tests/github.test.ts`  
Expected: FAIL because `GitHubGateway` does not exist.

- [ ] **Step 3: Implement installation-scoped clients**

Use `@octokit/app` to exchange the App private key for short-lived installation tokens. Cache clients only until five minutes before token expiry. Resolve repositories by installation and reject repositories outside that installation.

- [ ] **Step 4: Implement issue and sub-issue creation**

Create one parent issue from `WorkPlan`. When `units.length > 1`, create child issues, link them through GitHub's sub-issue API, and label only independent children `flow:ready`. When `needsHumanInput` is true, create no ready children and set the parent to `flow:blocked`.

- [ ] **Step 5: Implement webhook-to-job routing**

Persist and acknowledge issue, PR, check, workflow, push, and installation events. Enqueue normalized jobs containing repository, issue/PR number, head SHA, action, and installation ID. Never trust repository or actor values supplied in issue text.

- [ ] **Step 6: Verify and commit**

Run: `npm test -- tests/github.test.ts && npm run typecheck`  
Expected: PASS.  
Commit: `feat: connect planned work to GitHub`

---

### Task 6: Repository contract and deterministic runner

**Files:**
- Create: `repo-kit/.flow/config.json`
- Create: `repo-kit/.flow/AI_RULES.md`
- Create: `repo-kit/AGENTS.md`
- Create: `repo-kit/CLAUDE.md`
- Create: `repo-kit/.cursor/rules/flow.mdc`
- Create: `repo-kit/scripts/run-contract.mjs`
- Test: `tests/contract-runner.test.ts`

**Interfaces:**
- Consumes: `.flow/config.json` from an explicitly supplied Git commit.
- Produces: CLI `node scripts/run-contract.mjs <install|checks|qa|start> --config <path>` with deterministic exit codes.

- [ ] **Step 1: Write failing command-safety tests**

Test that the runner accepts `[["npm","test"]]`, rejects shell strings, rejects empty commands, does not expand `$HOME`, does not interpret `;`, and returns the child process's non-zero exit code. Test that QA can load a config file materialized from the base commit rather than the PR checkout.

- [ ] **Step 2: Run and verify failure**

Run: `npm test -- tests/contract-runner.test.ts`  
Expected: FAIL because the contract runner does not exist.

- [ ] **Step 3: Implement contract validation and execution**

Parse `version`, `install`, `checks`, optional `qa`, optional `start`, optional `healthUrl`, `maxParallelBuilds`, and `protectedPaths`. Execute one command array at a time with `spawn(command[0], command.slice(1), { shell: false, stdio: "inherit" })`. Reject commands whose executable is not a bare program name or a repository-relative path.

- [ ] **Step 4: Write canonical AI rules and thin shims**

`.flow/AI_RULES.md` must require minimal scoped changes, tests mapped to acceptance criteria, no weakening of checks, no secret access, no workflow/config edits unless the issue explicitly targets them, and a PR evidence summary. `AGENTS.md`, `CLAUDE.md`, and `.cursor/rules/flow.mdc` each instruct the provider to read and follow `.flow/AI_RULES.md` without duplicating its rules.

- [ ] **Step 5: Verify and commit**

Run: `npm test -- tests/contract-runner.test.ts`  
Expected: PASS.  
Commit: `feat: define safe repository execution contract`

---

### Task 7: Codex build workflow

**Files:**
- Create: `repo-kit/.github/workflows/flow-build.yml`
- Test: `tests/workflow-build.test.ts`

**Interfaces:**
- Consumes: issue event with `flow:ready`, base-branch repository contract, `OPENAI_API_KEY`, and GitHub App credentials.
- Produces: branch `flow/<issue>-<slug>`, a linked draft PR, and state transition to `flow:working`.

- [ ] **Step 1: Write failing workflow policy tests**

Parse the YAML and assert: trigger is `issues: [labeled]`; job condition requires `flow:ready`; concurrency key includes repository and issue number; permissions are explicit; runner is Ubuntu; timeout is finite; checkout is the default branch; dependencies install before Codex; Codex uses `openai/codex-action` with `permission-profile: :workspace`; and no `pull_request_target` trigger exists.

- [ ] **Step 2: Run and verify failure**

Run: `npm test -- tests/workflow-build.test.ts`  
Expected: FAIL because `flow-build.yml` does not exist.

- [ ] **Step 3: Implement trusted setup and agent execution**

Materialize `.flow/config.json` from the default-branch SHA, validate it, run `install`, create the issue branch, and build a prompt file from the issue through a data-safe API step. Invoke `openai/codex-action@v1` with the workspace profile, default privilege reduction, a finite effort/model configuration, and the trusted prompt file.

- [ ] **Step 4: Implement verification, push, and PR creation**

Run the base contract's `checks`. Use an installation token from the Flow GitHub App to commit and push so normal CI triggers. Open or update one draft PR with `Closes #<issue>`, acceptance-criteria mapping, changed paths, checks, and risks. A rerun must find and update the existing branch/PR rather than create another.

- [ ] **Step 5: Verify and commit**

Run: `npm test -- tests/workflow-build.test.ts`  
Expected: PASS.  
Commit: `feat: build ready issues with Codex`

---

### Task 8: Independent Claude review and deterministic QA workflows

**Files:**
- Create: `repo-kit/.github/workflows/flow-review.yml`
- Create: `repo-kit/.github/workflows/flow-qa.yml`
- Create: `repo-kit/.flow/review-schema.json`
- Test: `tests/workflow-review.test.ts`
- Test: `tests/workflow-qa.test.ts`

**Interfaces:**
- Consumes: pull-request base/head SHAs, issue link, base contract, `ANTHROPIC_API_KEY`, and unprivileged test configuration.
- Produces: required checks `ai-review` and `qa`, review comments, and uploaded evidence artifacts.

- [ ] **Step 1: Write failing review workflow tests**

Assert that review triggers on PR open, synchronize, reopen, and ready-for-review; checks out the merge ref with persisted credentials disabled; grants read-only contents and PR permissions; invokes `anthropics/claude-code-action`; emits the strict review schema; fails for critical/high/medium findings; and cancels an older review for the same PR when a new head SHA arrives.

- [ ] **Step 2: Write failing QA workflow tests**

Assert that QA loads `.flow/config.json` from the base SHA, executes install/checks/qa through `run-contract.mjs`, uses no production environment, has a finite timeout, uploads logs and available screenshots/videos, and never executes PR-authored workflow or contract changes.

- [ ] **Step 3: Run and verify failure**

Run: `npm test -- tests/workflow-review.test.ts tests/workflow-qa.test.ts`  
Expected: FAIL because the workflows do not exist.

- [ ] **Step 4: Implement read-only structured review**

Pass the issue, base/head diff, `.flow/AI_RULES.md`, and CI summary to Claude. Require output matching `review-schema.json`. Post inline comments for concrete findings and a summary comment for a clean result. Treat low findings as advisory; exit non-zero for critical/high/medium findings. The workflow must never push or approve the PR.

- [ ] **Step 5: Implement deterministic QA**

Fetch the base contract into a temporary trusted path, run install/checks/qa, start the app when configured, poll `healthUrl` with a bounded timeout, and terminate the process on completion. Upload evidence using `if: always()` while excluding environment files and secrets.

- [ ] **Step 6: Verify and commit**

Run: `npm test -- tests/workflow-review.test.ts tests/workflow-qa.test.ts`  
Expected: PASS.  
Commit: `feat: gate pull requests with review and QA`

---

### Task 9: Orchestration, fix limits, and Telegram status mirroring

**Files:**
- Create: `src/orchestrator.ts`
- Create: `src/cursor.ts`
- Test: `tests/orchestrator.test.ts`
- Test: `tests/cursor.test.ts`

**Interfaces:**
- Consumes: normalized jobs, GitHub gateway, Telegram client, storage, configured provider roles, and `FLOW_MAX_FIX_ROUNDS`.
- Produces: `processJob(job, deps)`, `transition(work, event)`, `CursorGateway.startBuild`, and deduplicated status notifications.

- [ ] **Step 1: Write the state-table tests**

Cover inbox-to-ready, ready-to-working, PR-opened, review-failed, QA-failed, fix-round one/two, third failure to blocked, all-checks-pass to human, merge to done, protected-path changes to human-only, provider outage retry, and daily/per-issue budget block. Assert that replaying each event produces no second dispatch or notification.

- [ ] **Step 2: Run and verify failure**

Run: `npm test -- tests/orchestrator.test.ts`  
Expected: FAIL because the transition table does not exist.

- [ ] **Step 3: Implement a pure transition function**

Represent allowed transitions as data keyed by current `FlowState` and normalized event. Return `{ nextState, commands }`, where commands are only `dispatchBuild`, `requestFix`, `notify`, `setLabel`, and `closeIssue`. Reject stale head SHAs and impossible transitions without side effects.

- [ ] **Step 4: Execute commands through the job/outbox boundary**

Give every command an idempotency key derived from repository, issue/PR number, head SHA, event, and attempt. Enforce global and repository concurrency before dispatch. A failing command stays retryable without replaying commands already recorded as complete.

- [ ] **Step 5: Implement optional Cursor build dispatch**

When `FLOW_BUILDER=cursor`, call the Cursor Cloud Agent API with repository and issue prompt, store the returned job ID, and wait for GitHub to report the resulting branch/PR. Retry one transient API failure. Do not silently switch the provider. Unit tests use an HTTP fake and verify bearer authentication, timeout, response validation, and idempotency.

- [ ] **Step 6: Implement concise Telegram notifications**

Send only the seven transitions listed in the spec. Each message contains repository, issue or PR title, current state, one-sentence evidence/failure summary, and a GitHub link. Escape Telegram markup and split messages at API limits.

- [ ] **Step 7: Verify and commit**

Run: `npm test -- tests/orchestrator.test.ts tests/cursor.test.ts && npm run typecheck`  
Expected: PASS.  
Commit: `feat: orchestrate bounded build review and QA loops`

---

### Task 10: Setup CLI, container deployment, and repository onboarding

**Files:**
- Create: `src/cli.ts`
- Create: `flow`
- Create: `.env.example`
- Create: `Dockerfile`
- Create: `docker-compose.yml`
- Create: `.dockerignore`
- Create: `.gitignore`
- Create: `README.md`
- Test: `tests/cli.test.ts`
- Test: `tests/deployment.test.ts`

**Interfaces:**
- Consumes: all service modules, repository kit, Docker, public HTTPS URL, Telegram token, and GitHub App credentials.
- Produces: `./flow setup`, `./flow doctor`, `./flow repo add owner/repository`, and a health-checked container.

- [ ] **Step 1: Write failing CLI tests**

Test `doctor` with missing Docker, HTTP public URL, invalid Telegram token, invalid GitHub App key, inaccessible repository, invalid contract, builder/reviewer match, and redacted output. Test `repo add` in dry-run mode and assert the generated bootstrap branch contains exactly the repository-kit files.

- [ ] **Step 2: Write failing deployment-policy tests**

Assert that the image runs as a non-root user, contains no development secrets, has a health check, persists only `/data`, uses a read-only root filesystem where supported, and Docker Compose defines one application service and one named data volume.

- [ ] **Step 3: Run and verify failure**

Run: `npm test -- tests/cli.test.ts tests/deployment.test.ts`  
Expected: FAIL because the CLI and deployment files do not exist.

- [ ] **Step 4: Implement setup and doctor**

`./flow setup` validates prerequisites, captures secrets without terminal echo, writes `.env` with mode 0600, prints the prefilled GitHub App manifest URL, verifies both webhook secrets, registers the Telegram webhook, starts Docker Compose, and waits for `/health/ready`. `doctor` performs the same checks without changing external state and prints only redacted identifiers.

- [ ] **Step 5: Implement repository onboarding**

`./flow repo add owner/repository` verifies installation access, reads common package files to propose command arrays, validates each command, creates the six labels, and opens one bootstrap PR. It never pushes directly to the default branch or changes branch rules. Print the repository ruleset URL and the exact required checks: `ci`, `ai-review`, and `qa`.

- [ ] **Step 6: Build the production container**

Use a multi-stage build, copy only production output and dependencies, run under a fixed unprivileged UID, mount `/data`, set an init process, and expose the application port. Compose restarts on failure and does not contain secret values.

- [ ] **Step 7: Write the operator quickstart and recovery runbook**

Document BotFather token creation, GitHub App installation, required organization Actions secrets, first repository onboarding, Telegram `/connect`, backup/restore commands, key rotation, replay-safe restart, provider outage behavior, and complete uninstall steps.

- [ ] **Step 8: Verify and commit**

Run: `npm run lint && npm run typecheck && npm test && npm run build && docker compose config && docker build .`  
Expected: all commands succeed.  
Commit: `feat: ship one-command deployment and onboarding`

---

### Task 11: End-to-end acceptance and security proof

**Files:**
- Create: `tests/e2e/lifecycle.test.ts`
- Create: `tests/e2e/replay.test.ts`
- Create: `tests/e2e/isolation.test.ts`
- Create: `tests/e2e/security.test.ts`
- Create: `fixtures/e2e/` recorded redacted provider responses
- Modify: `README.md`

**Interfaces:**
- Consumes: the complete container, local Telegram/GitHub/provider fakes, and the repository kit.
- Produces: executable proof for every v1 acceptance criterion in the spec.

- [ ] **Step 1: Build local API fakes**

Serve deterministic Telegram, GitHub, OpenAI, Anthropic, and Cursor responses on localhost. Record all received requests after redacting authorization headers. Provide switches for duplicate delivery, 429, timeout, invalid JSON, failed review, failed QA, and provider recovery.

- [ ] **Step 2: Prove the happy path**

Submit text, photo, and voice fixtures; create one parent issue and two independent work units; dispatch two builds; simulate one PR; pass independent review and QA; and assert one `flow:human` Telegram notification with the PR link.

- [ ] **Step 3: Prove replay and restart safety**

Replay every Telegram and GitHub webhook three times, restart the service between persistence and execution, expire a job lease, and assert exactly one issue, PR dispatch, review, state transition, and notification.

- [ ] **Step 4: Prove tenant isolation and authorization**

Bind two Telegram chats to two installations, attempt cross-repository access and an unauthorized `/connect`, and assert no metadata, issue, attachment, or notification crosses the boundary.

- [ ] **Step 5: Prove the safety gates**

Inject shell syntax, prompt-injection text, a fake secret, a modified PR-branch contract, a protected workflow change, matching builder/reviewer settings, and a merge attempt by the App. Assert command arrays remain literal, secrets are redacted, base checks still run, protected changes need a human, invalid routing fails startup, and the App cannot merge.

- [ ] **Step 6: Run the release gate**

Run: `npm run lint && npm run typecheck && npm test && npm run build && docker build .`  
Expected: PASS with no live network access. Then run one manual acceptance cycle in a disposable GitHub organization and Telegram group using budget-capped provider keys.

- [ ] **Step 7: Record verified limitations and commit**

Update `README.md` with the Telegram Bot API attachment limit, Cursor beta status, single-active-replica SQLite limit, required human authorization steps, and the fact that repository QA quality depends on `.flow/config.json`.  
Commit: `test: prove end-to-end lifecycle and safety gates`

## Final release checklist

- [ ] All eleven task commits are present and reviewable.
- [ ] Unit, integration, replay, isolation, and security suites pass.
- [ ] Container health check and persistent-volume restart pass.
- [ ] GitHub App permissions match the spec and have no ruleset bypass.
- [ ] Default-branch rules require `ci`, `ai-review`, `qa`, and one human approval.
- [ ] Telegram and GitHub webhook secrets reject invalid requests.
- [ ] A disposable live run reaches `flow:human` but cannot merge itself.
- [ ] Database backup is restored successfully in a clean container.
- [ ] All documentation examples have been run exactly as written.
