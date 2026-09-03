# GitFlow AI: Minimal Multi-Agent Development Blueprint

**Date:** 2026-09-03  
**Status:** Build-ready design  
**Audience:** CTOs and business owners who want feedback turned into reviewed pull requests without operating an AI development platform

## 1. Executive decision

Build one small, containerized **intake and orchestration service**. Do not build a dashboard, a project-management database, a custom coding agent, or a general workflow engine.

- Telegram is the first human interface. Slack and Discord become later adapters that emit the same internal `FeedbackBundle` object.
- GitHub is the source of truth, work queue, audit log, permission system, and human approval surface.
- The service authenticates people, groups their text/screenshots/voice notes, converts those inputs into implementation-ready GitHub issues, and mirrors status back to chat.
- Disposable GitHub-hosted runners execute planning, coding, review, and QA.
- A different provider reviews the builder's pull request.
- Deterministic tests and branch rules—not an AI opinion—decide whether a pull request is technically mergeable.
- A human code owner always performs the final approval. No AI credential can merge or bypass repository rules.

The default provider routing is:

| Role | Default | Reason |
|---|---|---|
| Voice transcription and screenshot digestion | OpenAI API | One multimodal intake path |
| Planning and issue decomposition | OpenAI structured output | Fast, schema-validated planning before work starts |
| Implementation | Codex GitHub Action | Official action with workspace and privilege controls |
| Independent review | Claude Code GitHub Action | Separate provider and read-only review context |
| QA | Repository commands in GitHub Actions | Repeatable pass/fail evidence rather than model confidence |

Cursor is an optional implementation adapter, not a critical v1 dependency. Its Cloud Agents can work on GitHub repositories and open pull requests, and its API can create many concurrent agents, but the API is currently documented as beta. Cursor Bugbot can also be an optional second reviewer. Do not make a beta API the only golden path for a system described as bulletproof.

## 2. Product boundary

### In scope

1. Multiple Telegram users and groups.
2. Multiple GitHub organizations and repositories.
3. Text, photos, documents, and voice notes.
4. Structured issue creation and conservative sub-issue decomposition.
5. Sequential or parallel AI implementation.
6. Independent AI review, deterministic CI/QA, automated fix rounds, and a final human gate.
7. Telegram progress notifications with links back to GitHub.
8. Claude, Codex, and optional Cursor role routing.
9. Idempotency, auditability, retry limits, cost limits, and prompt-injection containment.

### Explicit non-goals

- No custom web dashboard in v1.
- No replacement for GitHub Issues or Projects.
- No custom agent runtime or model gateway.
- No autonomous production deployment.
- No autonomous merge.
- No Kubernetes, Kafka, Redis, Temporal, vector database, or microservices.
- No attempt to infer arbitrary repository install/test/start commands.

The last point is important: reliable QA across arbitrary repositories is impossible without a small repository-owned contract. Every onboarded repository must declare its deterministic commands.

## 3. Human experience

### Telegram setup

An administrator adds the bot to a Telegram group or private chat and runs:

```text
/connect owner/repository
```

The bot verifies that:

1. the caller is an allowed administrator;
2. the GitHub App is installed for that repository; and
3. the repository contains a valid `.flow/config.json` contract.

The binding is stored at Telegram **chat + forum-topic** granularity. This lets one group have a topic per product or repository without inventing another workspace model.

### Submitting work

The user taps **New request**, sends any combination of text, screenshots, documents, and voice notes, then taps **Send to GitHub**. In direct chats, `/new` and `/ship` provide the same flow.

The bot returns a preview containing:

- concise title;
- problem statement;
- observed screenshot details;
- voice transcription;
- proposed acceptance criteria;
- target repository; and
- risk classification.

Submission creates the GitHub issue immediately. Normal, low-risk work proceeds automatically. Work involving authentication, authorization, billing, destructive migrations, production infrastructure, legal/privacy behavior, or missing acceptance criteria is labeled `flow:blocked` and the bot asks one focused question in the original Telegram thread.

### Status messages

Telegram receives only meaningful transitions:

- issue created;
- plan ready and number of work units;
- implementation started;
- pull request opened;
- review or QA failed and an automatic fix round started;
- blocked and needs human help; or
- ready for human review.

Routine model chatter, command logs, and token-by-token progress stay in GitHub Actions logs.

## 4. Architecture

```text
Telegram ──webhook──> Flow service ──GitHub App──> GitHub issue/sub-issues
   ^                       │                            │
   │                       │                            ├─ plan/build workflows
   │                       │                            ├─ pull request
   │                       │                            ├─ independent AI review
   │                       │                            └─ deterministic CI + QA
   │                       │                                      │
   └──── status outbox <── GitHub webhooks <──────────────────────┘
                                                               human approval
```

### Component A: Flow service

A single Node.js/TypeScript process with four internal modules:

1. **Channel adapter** — verifies Telegram webhooks and converts updates to a provider-neutral `FeedbackBundle`.
2. **Intake processor** — downloads Telegram attachments, transcribes audio, describes images, redacts obvious secrets, and generates a schema-validated issue plan.
3. **GitHub adapter** — authenticates as a GitHub App installation, creates issues/sub-issues, changes state labels, dispatches workflows, and consumes GitHub webhooks.
4. **Worker/outbox** — retries background operations and sends deduplicated Telegram notifications.

The modules are boundaries inside one process, not separate services.

### Component B: SQLite

SQLite in WAL mode on a persistent volume stores only operational state:

- `chat_bindings` — Telegram chat/topic to GitHub installation and repository;
- `drafts` and `draft_items` — unsubmitted feedback bundles;
- `webhook_receipts` — unique Telegram update IDs and GitHub delivery IDs;
- `jobs` — retryable intake and notification work;
- `work_links` — Telegram message, GitHub issue, PR, and provider job IDs; and
- `outbox` — messages waiting to be delivered.

GitHub remains the durable business record. One process and SQLite are sufficient for the expected human-scale event rate. Back up the database daily. Add Postgres only if the service genuinely needs multiple active replicas.

### Component C: Repository kit

Each repository receives a tiny, versioned kit:

```text
.flow/config.json
.flow/AI_RULES.md
.github/workflows/flow-build.yml
.github/workflows/flow-review.yml
.github/workflows/flow-qa.yml
AGENTS.md                     # one-line pointer to .flow/AI_RULES.md
CLAUDE.md                     # one-line pointer to .flow/AI_RULES.md
.cursor/rules/flow.mdc        # one-line pointer to .flow/AI_RULES.md
```

Provider shims point to one shared instruction file so rules are not copied and allowed to drift.

### Component D: Provider adapters

The v1 provider interface is deliberately small:

```ts
type AgentRole = "builder" | "reviewer";

type AgentRequest = {
  repository: string;
  issueOrPullRequest: number;
  role: AgentRole;
  instructionsPath: ".flow/AI_RULES.md";
  maxMinutes: number;
  maxAttempts: number;
};
```

Provider-specific work remains inside GitHub workflows:

- **Codex:** `openai/codex-action`, using `permission-profile: :workspace` for building and `:read-only` for review. The action provides a secure API proxy and defaults to privilege reduction on Linux.
- **Claude:** `anthropics/claude-code-action`, using automation mode for builds and its code-review workflow for reviews.
- **Cursor:** the Cloud Agent API starts an isolated hosted agent for an issue and returns a provider job ID. The Flow service polls only until a PR is created, then GitHub webhooks resume control.

Configuration must reject `builder == reviewer`. Independence is enforced, not merely suggested.

## 5. Repository contract

`.flow/config.json` is the only project-specific runtime configuration:

```json
{
  "version": 1,
  "install": ["npm", "ci"],
  "checks": [
    ["npm", "run", "lint"],
    ["npm", "test"],
    ["npm", "run", "build"]
  ],
  "qa": [["npm", "run", "test:e2e"]],
  "start": ["npm", "run", "start"],
  "healthUrl": "http://127.0.0.1:3000/health",
  "maxParallelBuilds": 2,
  "protectedPaths": [
    ".github/workflows/",
    "migrations/",
    ".flow/"
  ]
}
```

Commands are argument arrays, never shell strings. A small checked-in runner executes them with `shell: false`. QA loads the contract from the pull request's **base commit**, preventing an agent from weakening the checks in its own branch.

If `qa`, `start`, or `healthUrl` is absent, the repository is treated as a non-web project. `install` and at least one `checks` entry are mandatory.

Changes under `protectedPaths` automatically require a human code-owner review and cannot be auto-fixed by an agent.

## 6. GitHub lifecycle

Use one mutually exclusive state label at a time:

| Label | Meaning |
|---|---|
| `flow:inbox` | Intake is being normalized and planned |
| `flow:ready` | A single shippable unit is eligible to build |
| `flow:working` | An agent owns the unit |
| `flow:blocked` | Human information or intervention is required |
| `flow:human` | PR passed review and QA; awaiting a human |
| `flow:done` | Merged or deliberately closed |

### Stage 1: Digest and plan

The intake model receives:

- the complete feedback bundle;
- text extracted from voice and screenshots;
- repository `README`, `.flow/AI_RULES.md`, `.flow/config.json`, and file tree; and
- a strict JSON schema.

Its output contains the problem, evidence, acceptance criteria, non-goals, risk flags, and one to four work units.

Decomposition rule:

- Create multiple sub-issues only when each can be merged independently without waiting for another unit and without predictably editing the same core files.
- If work has dependencies or is cross-cutting, keep one issue.
- Cap decomposition at four units.

GitHub supports nested sub-issues and parent progress tracking, but the product intentionally uses one level and at most four children. That gives useful parallelism without becoming a scheduler.

### Stage 2: Claim and build

A `flow:ready` issue starts one build. GitHub Actions concurrency uses the repository and issue number as its key, so duplicate events cannot create two agents for one issue. Repository-level `maxParallelBuilds` prevents a flood of simultaneous changes.

The builder:

1. checks out the default branch into a disposable Linux runner;
2. installs dependencies before the model step;
3. creates `flow/<issue>-<slug>`;
4. reads the issue and `.flow/AI_RULES.md`;
5. implements the smallest change satisfying the criteria;
6. adds or updates tests;
7. runs the declared checks;
8. commits and pushes using a short-lived GitHub App installation token; and
9. opens a draft PR linked to the issue.

The PR body contains summary, acceptance-criteria mapping, checks run, known risks, and visual evidence when applicable.

### Stage 3: Review

The reviewer runs with read-only repository permissions and no production credentials. It receives the base/head diff, issue, repository rules, and CI results. It returns schema-validated findings:

```json
{
  "verdict": "pass | changes_required",
  "findings": [
    {
      "severity": "critical | high | medium | low",
      "path": "src/example.ts",
      "line": 42,
      "problem": "...",
      "recommendedFix": "..."
    }
  ]
}
```

Critical, high, or medium findings fail the `ai-review` check. Low findings are advisory. The reviewer never pushes code.

### Stage 4: QA and fix loop

QA always runs the base-branch contract:

1. install;
2. lint/typecheck;
3. unit/integration tests;
4. build;
5. start and health check when configured;
6. repository-owned end-to-end tests; and
7. upload logs, coverage, screenshots, and videos as Actions artifacts.

If review or QA fails, the builder gets one follow-up containing only the structured findings and failing evidence. It may push a fix to the existing branch. The loop is capped at two automatic fix rounds. After the second failure the PR is labeled `flow:blocked`, and Telegram receives a concise escalation.

### Stage 5: Human gate

When `ci`, `ai-review`, and `qa` pass, the draft flag is removed, the issue becomes `flow:human`, and Telegram receives the PR link and evidence summary.

The default-branch ruleset requires:

- a pull request;
- all three required checks from their expected GitHub Apps;
- one approving human review, preferably CODEOWNERS;
- dismissal of stale approvals after new commits;
- the branch to be up to date or pass through merge queue;
- blocked force pushes and branch deletion; and
- no bypass permission for the Flow or provider apps.

AI success is a status check, not a GitHub approval. This prevents an AI review from accidentally satisfying the required human-review count.

## 7. Security model

### Trust boundaries

Telegram messages, screenshots, voice transcriptions, issue bodies, PR descriptions, repository contents, and test output are untrusted input. They may describe work but may not change security policy.

### Required controls

1. Verify Telegram's `X-Telegram-Bot-Api-Secret-Token` header.
2. Verify GitHub webhook HMAC signatures before parsing events.
3. Deduplicate Telegram `update_id` and GitHub `X-GitHub-Delivery` values.
4. Use a GitHub App, not a personal access token. Generate short-lived installation tokens.
5. Give each workflow the minimum explicit GitHub permissions.
6. Never use `pull_request_target` to execute code from a PR branch.
7. Never expose production, deployment, cloud-admin, customer-data, or database credentials to agent jobs.
8. Keep model API keys in organization Actions secrets or use OIDC federation where the provider supports it.
9. Pin third-party actions to commit SHAs and update them through Dependabot.
10. Run coding agents on disposable GitHub-hosted Linux runners. Do not reuse self-hosted workers for untrusted agent jobs.
11. Enforce command/time/output limits and a per-issue budget.
12. Redact likely secrets from intake and logs before sending them to model APIs.
13. Allowlist Telegram user IDs, chat IDs, GitHub installations, and repositories.
14. Keep all merges human-only and enforce that in GitHub rulesets.

### GitHub App permissions

Control-plane App repository permissions:

- Metadata: read
- Contents: read/write
- Issues: read/write
- Pull requests: read/write
- Checks: read/write
- Actions: read/write
- Workflows: read

Subscribe only to installation, issues, issue comments, pull requests, pull-request reviews, check runs/suites, workflow runs, and push events. Do not request organization administration or repository secrets permissions.

## 8. Reliability and operational rules

- Webhook handlers verify, persist, and return `2xx` quickly. Slow model or GitHub work is performed by the local job loop.
- Every job has an idempotency key and unique database constraint.
- Retries use exponential backoff with jitter. Permanent validation/auth failures do not retry.
- Telegram and GitHub delivery use an outbox so a process restart cannot lose a notification.
- Drafts expire after 24 hours; completed webhook receipts are retained for 30 days.
- `/health/live` checks the process. `/health/ready` checks SQLite, writable storage, and configuration.
- Daily SQLite backup; weekly restore test.
- Graceful shutdown stops claiming jobs, finishes the active transaction, and exits.
- One automatic retry for transient provider errors; two code-fix rounds; then block and notify.
- Metrics are counters and structured logs first. Add an observability vendor only after there is an operational need.

## 9. Deployment and one-command setup

### Environment variables

```text
PUBLIC_URL=https://flow.example.com
DATABASE_PATH=/data/flow.db

TELEGRAM_BOT_TOKEN=
TELEGRAM_WEBHOOK_SECRET=
TELEGRAM_ADMIN_IDS=123456789,987654321

GITHUB_APP_ID=
GITHUB_APP_PRIVATE_KEY_BASE64=
GITHUB_WEBHOOK_SECRET=

OPENAI_API_KEY=
ANTHROPIC_API_KEY=
CURSOR_API_KEY=                  # optional

FLOW_BUILDER=codex              # codex | claude | cursor
FLOW_REVIEWER=claude             # must differ from builder
FLOW_MAX_ISSUE_COST_USD=25
FLOW_MAX_FIX_ROUNDS=2
```

### Bootstrap UX

The repository will provide one command:

```bash
./flow setup
```

It must:

1. verify Docker and the public HTTPS URL;
2. create `.env` interactively without echoing secrets;
3. use a GitHub App manifest URL to prefill the correct permissions and webhook events;
4. accept the returned App ID, private key, and webhook secret;
5. verify the Telegram token and register the Telegram webhook;
6. start the service with Docker Compose;
7. run live/ready checks;
8. print the exact `/connect owner/repo` command; and
9. print a redacted diagnostic summary.

GitHub organization authorization and Telegram bot creation cannot safely be bypassed by a script; those are intentional one-time human authorization steps. Everything after the credentials are pasted is automated.

### Repository onboarding

```bash
./flow repo add owner/repository
```

This command:

1. checks that the GitHub App is installed;
2. opens a bootstrap PR containing the repository kit;
3. detects common package-manager commands and writes a proposed `.flow/config.json`;
4. validates the proposed commands in CI;
5. creates the six state labels; and
6. prints or opens the exact ruleset setup page if the caller lacks administration permission.

The onboarding PR still requires a human to confirm the repository contract and merge it.

## 10. Cost and concurrency controls

- Default to two builds per repository and five builds globally.
- Planner may create at most four work units.
- Cap builder and reviewer runtime separately.
- Store provider usage metadata against the issue/PR when available.
- Stop dispatching when the daily or per-issue budget is reached; label `flow:blocked` and notify Telegram.
- Do not send the full repository to the intake model. Send the file tree and a few trusted context files; the coding agent reads the checkout on its runner.
- Cancel superseded review jobs when a new PR commit arrives.

## 11. Failure behavior

| Failure | System response |
|---|---|
| Duplicate Telegram or GitHub webhook | Return success; do nothing twice |
| Telegram attachment exceeds the Bot API download limit | Ask for a smaller file or a secure link; keep the draft |
| Intake model returns invalid JSON | One schema-repair attempt, then `flow:blocked` |
| GitHub App loses access | Stop work and notify the configured administrators |
| Builder times out | One fresh attempt on the same issue, then block |
| Review/QA fails | Up to two fix rounds on the same PR branch |
| Branch conflicts with main | Rebase once through the builder; otherwise block |
| Budget exceeded | Stop before dispatching another model call |
| Service restart | Unfinished jobs and outbox messages resume from SQLite |
| Provider outage | Back off; do not silently switch providers mid-PR |

## 12. Acceptance criteria for v1

The system is ready when all of these are demonstrated in a disposable test organization:

1. An allowed Telegram user submits text, one screenshot, and one voice note.
2. The bot previews and creates one correctly structured GitHub issue without duplicate delivery.
3. A decomposable request creates independent GitHub sub-issues; a cross-cutting request stays single.
4. Two independent issues build in parallel on different branches without duplicate jobs.
5. The configured builder opens a draft PR and attaches check evidence.
6. A different configured provider reviews the PR with read-only permissions.
7. A deliberate test failure blocks readiness and triggers one fix round.
8. Passing CI, AI review, and QA moves the PR to `flow:human` and sends one Telegram notification.
9. The AI and Flow GitHub Apps cannot merge or bypass the default-branch ruleset.
10. Replaying every captured webhook produces no duplicate issue, PR, comment, or Telegram notification.
11. Restarting the service during intake resumes the work.
12. A second Telegram group can bind to a different repository without seeing the first group's work.

## 13. Current platform facts supporting the design

- GitHub Apps provide scoped authentication and webhook-driven automation. GitHub also supports prefilled App registration URLs and manifests, which makes repeatable installation practical: <https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-using-url-parameters>
- GitHub Issues supports parent/sub-issue relationships and nested hierarchies. The product intentionally uses only one level and a four-child cap: <https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/adding-sub-issues>
- GitHub rulesets can require pull requests, human reviews, and status checks from an expected App: <https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets>
- Telegram webhooks support a secret verification header, retry failed deliveries, and let bots re-request expiring file download URLs through `getFile`: <https://core.telegram.org/bots/api>
- Claude Code's official GitHub Action can turn issues into pull requests, run automated review, use organization-level reusable workflows, and authenticate through API keys or OIDC federation: <https://code.claude.com/docs/en/github-actions>
- OpenAI's official Codex Action supports controlled workspace/read-only permission profiles, privilege reduction, model/effort selection, and structured outputs: <https://github.com/openai/codex-action>
- Cursor Cloud Agents work in isolated environments against GitHub repositories and can create pull requests. Its programmatic Background Agents API is documented as beta, so it remains optional in the golden path: <https://docs.cursor.com/background-agent/api/overview>

## 14. Final simplification test

The complete v1 has:

- one service;
- one SQLite file;
- one Docker image;
- one GitHub App;
- one Telegram bot;
- one small repository contract;
- three GitHub workflows; and
- zero custom dashboards or autonomous merge paths.

Anything beyond those boundaries must justify itself with an observed failure in production.
