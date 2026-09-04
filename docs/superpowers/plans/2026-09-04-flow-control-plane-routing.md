# Flow Control Plane and Provider Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the hosted Flow admin into the secure repository/provider control plane and connect durable model routing, budgets, and transient provider handoffs to GitHub workflows.

**Architecture:** Keep Fastify, SQLite, and GitHub Actions. Add a small encrypted credential vault and durable routing ledger to the existing storage module, a control-plane service that provisions repositories through the installed GitHub App, and explicit provider/model/route inputs in workflows. The admin remains server-rendered and JavaScript-free; mutations use authenticated forms with single-use CSRF tokens.

**Tech Stack:** TypeScript 6, Node.js 22+, Fastify 5, better-sqlite3, Octokit GitHub App, libsodium sealed-box repository secrets, Node AES-256-GCM credential encryption, Vitest, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-04-flow-control-plane-routing.md`

## Global Constraints

- Keep one Flow deployment per trusted company boundary and support many repositories in it.
- Never place provider secrets in workflow inputs, HTML, JSON responses, logs, or plaintext SQLite.
- Use GitHub APIs for repository flow; do not shell out to Git for hosted administration.
- Fail over only on explicit transient failures; unknown and deterministic failures block.
- Keep human CODEOWNER approval mandatory.
- Keep the admin server-rendered, accessible, responsive, and free of client JavaScript.
- Preserve the implemented clarification loop and its trust checks.

---

### Task 1: Encrypted control-plane persistence

**Files:**
- Create: `src/credential-vault.ts`
- Modify: `src/storage.ts`
- Modify: `src/config.ts`
- Modify: `src/cli.ts`
- Test: `tests/credential-vault.test.ts`
- Test: `tests/storage.test.ts`
- Test: `tests/config.test.ts`
- Test: `tests/cli.test.ts`

**Interfaces:**
- Produces: `createCredentialVault(key: Buffer)` with `seal(plaintext)` and `open(ciphertext)`.
- Produces: `Storage.setProviderCredential`, `getProviderCredential`, `setRoutingSettings`, `getRoutingSettings`, `saveManagedRepository`, and `listManagedRepositories`.
- Produces: `AppConfig.credentialKey`, generated as `FLOW_CREDENTIAL_KEY` by `flow init`.

- [ ] Write failing vault round-trip, tamper, wrong-key, and no-plaintext storage tests.
- [ ] Run `npm test -- --run tests/credential-vault.test.ts tests/storage.test.ts tests/config.test.ts tests/cli.test.ts` and confirm the new assertions fail.
- [ ] Implement AES-256-GCM envelopes as versioned base64url values and add the SQLite migrations/methods.
- [ ] Generate and validate a 32-byte `FLOW_CREDENTIAL_KEY` without ever printing it.
- [ ] Re-run the focused tests and confirm they pass.

### Task 2: Provider authentication and admin setup UI

**Files:**
- Create: `src/control-plane.ts`
- Modify: `src/admin.ts`
- Modify: `src/server.ts`
- Modify: `src/index.ts`
- Test: `tests/control-plane.test.ts`
- Test: `tests/admin.test.ts`

**Interfaces:**
- Produces: `ControlPlane.getSnapshot()`, `saveProviderCredential(provider, credential)`, `saveRoutingSettings(settings)`, and `provisionRepository(input)`.
- Extends: `AdminRouteOptions` with a `controlPlane` dependency and CSRF secret.

- [ ] Write failing tests proving secrets are write-only, invalid credentials do not replace valid ones, Basic auth applies to mutations, cross-origin requests fail, and CSRF tokens are single-use.
- [ ] Run the focused tests and confirm failure.
- [ ] Add provider verification adapters: OpenAI `/v1/models`, Anthropic `/v1/models`, and Cursor configured-without-remote-verification.
- [ ] Render `/admin/setup` with provider, routing, budget, and repository forms; update CSP to permit same-origin forms only.
- [ ] Parse URL-encoded bodies with strict size limits and schemas; use POST-redirect-GET and redacted status messages.
- [ ] Re-run focused tests and confirm success.

### Task 3: GitHub-App repository provisioning from admin

**Files:**
- Modify: `src/github-app.ts`
- Modify: `src/provision.ts`
- Modify: `src/control-plane.ts`
- Modify: `src/admin.ts`
- Test: `tests/github-app.test.ts`
- Test: `tests/provision.test.ts`
- Test: `tests/control-plane.test.ts`

**Interfaces:**
- Produces: `GitHubAppAccess.getRepositoryApi(repository)` and `getAppSlug()`.
- Consumes: encrypted provider credentials and routing settings from Task 1.

- [ ] Write failing tests for installed-repository validation, App-token provisioning, encrypted Actions-secret writes, setup-PR behavior, and repository persistence.
- [ ] Run the focused tests and confirm failure.
- [ ] Provision through the installation API, stop automatic setup-PR merging, and expose actionable permission errors.
- [ ] Record repositories only after GitHub accepts provisioning; show setup PR and merge-gate state in admin.
- [ ] Re-run focused tests and confirm success.

### Task 4: Durable routing ledger and policy service

**Files:**
- Modify: `src/provider-router.ts`
- Create: `src/routing-service.ts`
- Modify: `src/storage.ts`
- Test: `tests/provider-router.test.ts`
- Create: `tests/routing-service.test.ts`
- Test: `tests/storage.test.ts`

**Interfaces:**
- Produces: `RoutingService.reserveRoute(task)`, `completeRoute(routeId, usage?)`, and `failRoute(routeId, category)`.
- Implements: `UsageLedger` using SQLite immediate transactions.
- Produces: persisted route attempts/events and `Storage.getRoutingSummary()`.

- [ ] Write failing tests for atomic job/month caps, expired reservations, conservative settlement, independent-review preference, bounded retry, handoff, and terminal blocking.
- [ ] Run focused tests and confirm failure.
- [ ] Implement the SQLite ledger and routing service using the existing pure router selection/failure rules.
- [ ] Re-run focused tests and confirm success.

### Task 5: Explicit provider/model workflow dispatch

**Files:**
- Modify: `src/github.ts`
- Modify: `repo-kit/.github/workflows/flow-build.yml`
- Modify: `repo-kit/.github/workflows/flow-review.yml`
- Modify: `repo-kit/.github/workflows/flow-qa.yml`
- Modify: `repo-kit/.flow/config.json`
- Test: `tests/github.test.ts`
- Test: `tests/workflows.test.ts`

**Interfaces:**
- Extends: `dispatchBuild` and `dispatchQuality` with `{ routeId, provider, model }`.
- Workflow inputs: `route_id`, `provider`, and `model`; run names include route IDs for webhook correlation.

- [ ] Write failing tests that every AI dispatch includes the selected route/provider/model and secrets never appear in inputs.
- [ ] Run focused tests and confirm failure.
- [ ] Replace repository-variable provider conditions with trusted workflow inputs and pass model selection to each official action/CLI.
- [ ] Disable Cursor steps unless a machine key has been configured during provisioning.
- [ ] Re-run focused tests and confirm success.

### Task 6: Worker routing, budget, and handoff integration

**Files:**
- Modify: `src/worker.ts`
- Modify: `src/orchestrator.ts`
- Modify: `src/index.ts`
- Test: `tests/worker.test.ts`
- Test: `tests/orchestrator.test.ts`
- Test: `tests/e2e.test.ts`

**Interfaces:**
- Consumes: `RoutingService` from Task 4 and route-aware GitHub dispatch from Task 5.
- Persists: selected route ID in `WorkRecord.providerJobId` before dispatch.

- [ ] Write failing tests for build/review/QA selection, conservative success settlement, timeout retry/handoff, budget block notification, and no failover on generic failure.
- [ ] Run focused tests and confirm failure.
- [ ] Reserve before dispatch, persist the attempt, correlate workflow results by route ID, and enqueue only approved retries/handoffs.
- [ ] Keep clarification resume and repair evidence intact across routing.
- [ ] Re-run focused and clarification tests and confirm success.

### Task 7: Configuration, deployment, CLI warning, and documentation

**Files:**
- Modify: `.env.example`
- Modify: `src/railway.ts`
- Modify: `package.json`
- Modify: `README.md`
- Test: `tests/railway.test.ts`
- Test: `tests/deployment.test.ts`

**Interfaces:**
- Adds: Railway allowlist entries for the credential key and routing defaults.
- Documents: admin setup, provider auth limitations, GitHub App setup permissions, admission-budget semantics, and multi-repository onboarding.

- [ ] Write failing deployment assertions for the new required variables and explicit `fsevents` script denial.
- [ ] Run focused tests and confirm failure.
- [ ] Update environment templates, Railway deployment, `allowScripts`, and operator docs.
- [ ] Re-run focused tests and `npm install` to confirm the warning is gone.

### Task 8: Full verification and visual QA

**Files:**
- Modify only files required by verified failures.

**Interfaces:**
- Produces: evidence for the complete spec acceptance criteria.

- [ ] Run `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, and `git diff --check`.
- [ ] Start the built admin against a temporary database and verify login, CSRF mutation flows, secret redaction, desktop layout, mobile layout, and horizontal overflow with Playwright.
- [ ] Inspect screenshots and browser console output.
- [ ] Review the final diff for credential leakage, workflow-expression injection, unsafe failover, and unrelated changes.
- [ ] Commit the complete working tree on the existing feature branch only after all checks pass.
