# Flow Control Plane and Provider Routing Specification

## Goal

Make the hosted `/admin` application the day-to-day control plane for provider credentials, repository onboarding, model routing, budgets, and provider handoffs while preserving a small, auditable security boundary.

## Boundaries

- `flow init` remains the one-time bootstrap that creates the admin password, webhook secrets, and a 256-bit credential-encryption key.
- The GitHub App ID and private key remain bootstrap credentials because Flow cannot access GitHub before an App exists. Once bootstrapped, repository selection and provisioning happen in `/admin/setup` without a local `gh` session.
- Flow stores provider credentials encrypted with AES-256-GCM. The encryption key stays in the host environment and never enters SQLite, GitHub comments, workflow inputs, logs, or HTML.
- Provider credentials are copied to GitHub Actions only through GitHub's encrypted Actions Secrets API. They are never sent through `workflow_dispatch` inputs.
- Hosted Codex uses an OpenAI API key. Hosted Claude uses an Anthropic API key. Local browser sessions are not copied into Flow. Cursor is enabled only when the operator supplies a Cursor machine API key; browser login is local-only and unavailable to ephemeral GitHub runners.
- One Flow deployment serves many repositories inside one trusted company boundary. Separate companies use separate deployments and GitHub Apps.

## Admin behavior

- `/admin` remains the operational summary.
- `/admin/setup` is an authenticated, CSRF-protected, server-rendered control page with no client JavaScript.
- It shows masked connection status for GitHub, OpenAI, Anthropic, and Cursor.
- Operators can verify and save OpenAI and Anthropic API keys, optionally save a Cursor API key, select economy/frontier models, set role routing, and set per-job/monthly token and cost admission limits.
- Operators can enter `OWNER/REPO` and CODEOWNERS, then have Flow verify the GitHub App installation, create a setup pull request, install encrypted provider secrets and non-secret variables, and record the repository.
- Secrets are write-only: the UI never renders them after submission.
- Provider verification failures do not overwrite a previously working credential.

## Routing behavior

- Build, AI review, and visual QA each receive an explicit route ID, provider, and model. CI remains deterministic and has no AI route.
- Low-complexity work prefers economy models; medium/high and security review prefer frontier models.
- Reviews prefer a provider different from the builder when an alternative is configured.
- Before dispatch, Flow atomically reserves estimated tokens and cost against per-job and calendar-month admission limits.
- When exact usage is unavailable from a GitHub Action, Flow settles the full reservation. This is intentionally conservative and must be described as an admission cap, not exact provider billing.
- Provider/model/attempt/checkpoint/evidence are persisted before dispatch. Handoffs never mutate the task or evidence references.
- Automatic retry/failover is allowed only for explicit transient categories: HTTP 408, HTTP 429, HTTP 5xx, network errors, and workflow timeout. Generic workflow failure, authentication, invalid request, security refusal, policy refusal, test failure, and unknown failure block for a human.
- Retries are bounded per candidate. Exhausting a candidate hands off to the next configured provider. Exhausting all candidates blocks the work and notifies Telegram.

## Clarifications

- Intake and builder questions are structured GitHub issue comments and move work to `flow:blocked`.
- Authorized Telegram `/answer ISSUE_NUMBER ...` replies and GitHub comments from users with write/maintain/admin permission resume exactly once.
- Answers are always treated as untrusted requirement context.

## Security and operations

- Admin mutation endpoints require Basic authentication, a same-origin check, and a single-use CSRF token.
- All secrets and failure details are redacted from responses and logs.
- GitHub App permissions are documented exactly. Setup-capable deployments need Administration, Contents, Secrets, Variables, and Workflows write access in addition to runtime permissions; installation remains restricted to selected repositories.
- Human CODEOWNER approval and required checks remain mandatory for generated feature pull requests.
- The admin includes recent routing events and month-to-date reserved/settled usage.
- SQLite remains the single-instance durable store; reservations use immediate transactions.

## Acceptance criteria

- A fresh operator can bootstrap Flow, open `/admin/setup`, add provider credentials, configure routes and limits, and provision multiple installed repositories without running `flow repo add` per repository.
- Provider keys never appear in HTML, JSON responses, logs, workflow inputs, or SQLite plaintext.
- Every AI workflow receives the chosen provider and model.
- A simulated timeout retries and then hands off without changing task/checkpoint evidence.
- A generic failure blocks and never silently changes provider.
- Budget exhaustion prevents dispatch and appears in the admin.
- Clarification and resume behavior remains green.
- Unit, integration, type, lint, build, and desktop/mobile browser checks pass.
