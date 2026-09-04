# Flow AI

Turn Telegram feedback into reviewed, tested GitHub pull requests.

```text
Telegram feedback
    ↓
GitHub issue + small work units
    ↓
Claude, Codex, or Cursor builds the change
    ↓
Independent CI, code review, API, browser, and visual QA
    ↓
Draft PR becomes ready for a human CODEOWNER
```

Flow AI is deliberately small: one Node service, one SQLite database, and four GitHub Actions workflows installed in each project. GitHub remains the source of truth. Flow AI never merges a pull request.

## The simple version

Install and configure Flow AI once. After that, enter any local GitHub project and run:

```sh
cd /path/to/your-project
flow-ai repo add
```

The CLI detects `OWNER/REPO` through GitHub CLI and prepares the repository. It installs the workflows, labels, encrypted AI secrets, read-only workflow defaults, protected files, required checks, and human CODEOWNER merge gate through a reviewable `flow/setup` pull request.

Then connect the project in Telegram:

```text
/connect OWNER/REPO
/new
```

Send feedback, screenshots, voice notes, or a screen recording, followed by:

```text
/ship
```

Flow AI handles the delivery cycle and leaves the resulting PR ready for human approval.

## One service handles many repositories

You do **not** deploy Flow AI once per repository. Deploy one central Flow AI service for a company or trusted team, then connect as many repositories as that service's GitHub App is allowed to access.

Keep Flow AI itself in one dedicated private operations repository and host that repository once. Target application repositories receive only the small `.flow/`, `.github/workflows/`, and guidance files installed by the CLI; they do not run another copy of the service.

```text
One hosted Flow AI service
├── Telegram topic: Web app  → acme/web
├── Telegram topic: API      → acme/api
├── Telegram topic: Mobile   → acme/mobile
└── Telegram group: Internal → acme/internal-tools
```

Repository isolation is carried through the entire system:

- Each Telegram group/topic has its own repository binding.
- Every draft stores the repository selected when it is submitted.
- Durable jobs and work records are keyed by repository and issue number.
- The GitHub App resolves the correct installation for every repository.
- Every repository gets its own Actions secrets, workflows, branches, issues, checks, and merge rules.
- Building and QA run in that repository's GitHub Actions account, not on the central Flow AI host.

The recommended Telegram layout is one business group with Topics enabled and one topic per repository or product. Run `/connect OWNER/REPO` once inside each topic. A topic can be reconnected later, but finish or cancel any open draft before changing its repository.

One instance is appropriate for repositories that share the same trusted operators and provider credentials. `TELEGRAM_ADMIN_IDS` is currently a global allowlist, so every listed operator can connect a Telegram destination to any repository accessible to the GitHub App. Use a separate Flow AI instance per customer or security boundary when that is not acceptable. This version is multi-repository, not a public multi-tenant SaaS control plane.

## What is automated

`flow-ai repo add` handles the repository-side setup:

- Detects the current GitHub repository, or accepts an explicit `OWNER/REPO`.
- Confirms that the runtime GitHub App can access it.
- Creates or refreshes the isolated `flow/setup` branch.
- Opens a setup pull request instead of writing directly to the default branch.
- Installs the build, CI, review, and real-QA workflows.
- Installs the repository command contract and AI rules.
- Preserves existing `AGENTS.md`, `CLAUDE.md`, and CODEOWNERS guidance.
- Encrypts and uploads only the AI secrets required by the selected providers.
- Creates the `flow:*` lifecycle labels.
- Sets the default GitHub Actions token to read-only.
- Requires the exact Flow checks from the runtime App.
- Requires a fresh human CODEOWNER approval before merge.

You supply the integration credentials once. Flow AI cannot safely create Telegram bots, accept vendor terms, choose human approvers, or generate GitHub App private keys on your behalf.

## Requirements

- Node.js 22 or newer
- Docker with Compose
- [GitHub CLI](https://cli.github.com/) authenticated as a repository administrator
- A stable public HTTPS URL for the Flow AI service
- A Telegram bot token
- A private GitHub App
- An OpenAI API key for multimodal intake and transcription
- Provider keys for whichever delivery agents you select

## 1. Install the CLI

From this Flow AI checkout:

```sh
npm ci
npm run build
npm link
```

Confirm it is available:

```sh
flow-ai --help
```

If you do not want a global command, use `/absolute/path/to/gitflow/flow` everywhere that this guide uses `flow-ai`.

## 2. Create the one-time integrations

### Telegram bot

1. Open BotFather and create a bot.
2. Copy the bot token.
3. Use BotFather's `/setprivacy` command and disable privacy for the bot. This allows it to receive ordinary feedback, screenshots, documents, voice messages, and recordings.
4. Add the bot to the business Telegram group. It does not need administrator rights.
5. Record the numeric Telegram user IDs that are allowed to submit work.

Only allowlisted user IDs are accepted. Unauthorized updates are discarded before entering the durable queue.

### Runtime GitHub App

Create one private GitHub App for Flow AI.

Set its webhook URL to:

```text
https://YOUR-FLOW-HOST/webhooks/github
```

Give it these repository permissions:

| Permission | Access |
| --- | --- |
| Actions | Read and write |
| Checks | Read and write |
| Contents | Read-only |
| Issues | Read and write |
| Metadata | Read-only |
| Pull requests | Read and write |

Subscribe it to:

- Pull request
- Workflow run

Generate a private key and install the App on every repository Flow AI may use. Do not grant it Administration, Secrets, Variables, or Workflows permission. Those one-time changes use the human administrator authenticated through GitHub CLI.

## 3. Create the Flow AI configuration

For one provider handling build, review, and visual QA:

```sh
flow-ai setup --agent codex
```

The other choices are `claude` and `cursor`.

For stronger reviewer independence, use split-provider mode:

```sh
flow-ai setup
```

The command creates `.env` in the Flow AI installation directory with owner-only file permissions. Fill in its empty values:

| Variable | Purpose |
| --- | --- |
| `PUBLIC_URL` | Public HTTPS address of this service |
| `TELEGRAM_BOT_TOKEN` | Token supplied by BotFather |
| `TELEGRAM_WEBHOOK_SECRET` | Random secret protecting Telegram callbacks |
| `TELEGRAM_ADMIN_IDS` | Comma-separated allowlist of Telegram user IDs |
| `GITHUB_APP_ID` | Numeric runtime GitHub App ID |
| `GITHUB_APP_PRIVATE_KEY_BASE64` | Base64-encoded GitHub App private key |
| `GITHUB_WEBHOOK_SECRET` | Random secret protecting GitHub callbacks |
| `OPENAI_API_KEY` | Multimodal intake and Codex, when selected |
| `ANTHROPIC_API_KEY` | Required when Claude is selected |
| `CURSOR_API_KEY` | Required when Cursor is selected |
| `FLOW_AGENT` | Optional single provider for every AI role |
| `FLOW_BUILDER` | Builder in split-provider mode |
| `FLOW_REVIEWER` | Reviewer and visual-QA provider in split mode |
| `FLOW_CODEOWNERS` | Required human GitHub users or teams |
| `FLOW_MAX_FIX_ROUNDS` | Maximum automatic repair attempts; default `2` |

Generate the two webhook secrets independently:

```sh
openssl rand -hex 32
```

Convert the downloaded GitHub App key to one line:

```sh
node -e "process.stdout.write(require('fs').readFileSync('YOUR-KEY.pem').toString('base64'))"
```

CODEOWNERS examples:

```dotenv
FLOW_CODEOWNERS=@octocat
FLOW_CODEOWNERS=@your-org/platform-team,@release-owner
```

OpenAI is always required for Telegram transcription and multimodal planning. In single-provider mode, the chosen vendor runs each role in a separate invocation. Split-provider mode is recommended when independent review matters more than using one vendor.

Validate the configuration:

```sh
flow-ai doctor
```

## 4. Host the central service

The central service must be continuously reachable over HTTPS because Telegram and GitHub send webhooks to it. It also needs one persistent writable directory at `/data` for SQLite. It does not need to clone or build every connected repository; GitHub Actions supplies the build compute.

### Recommended: Fly.io

Fly.io is the simplest fit for the current architecture: it deploys the included Dockerfile, gives the service a public HTTPS address, and supports a persistent volume mounted at `/data`. Keep exactly one Machine while the service uses SQLite. See Fly's official [Dockerfile deployment](https://fly.io/docs/languages-and-frameworks/dockerfile/), [volume](https://fly.io/docs/volumes/overview/), and [configuration](https://fly.io/docs/reference/configuration/) documentation.

Install and authenticate `flyctl`, then run this from the Flow AI repository:

```sh
fly auth login
fly launch --no-deploy
```

Choose a unique app name and a region near your team. Update the generated `fly.toml` so it contains these settings, while retaining its generated `app` and `primary_region` values:

```toml
[build]
  dockerfile = "Dockerfile"

[env]
  NODE_ENV = "production"
  PORT = "3000"
  DATABASE_PATH = "/data/flow.db"

[http_service]
  internal_port = 3000
  force_https = true
  auto_stop_machines = "off"
  auto_start_machines = true
  min_machines_running = 1

[[http_service.checks]]
  grace_period = "10s"
  interval = "30s"
  method = "GET"
  timeout = "5s"
  path = "/health/ready"

[[mounts]]
  source = "flow_data"
  destination = "/data"

[[vm]]
  memory = "1gb"
  cpu_kind = "shared"
  cpus = 1
```

Create the volume in the same region as the app:

```sh
fly volumes create flow_data --region YOUR_REGION --size 1
```

Set `PUBLIC_URL` in your local `.env` to the generated address:

```dotenv
PUBLIC_URL=https://YOUR-APP.fly.dev
```

Import the configuration into Fly's encrypted secret store, override the hosted database path, deploy, and keep one Machine:

```sh
fly secrets import < .env
fly secrets set DATABASE_PATH=/data/flow.db
fly deploy
fly scale count 1
```

Fly documents that app secrets are encrypted and exposed as environment variables only at runtime. Updating a secret restarts the Machine. See [Fly secrets](https://fly.io/docs/apps/secrets/).

Verify the deployment:

```sh
curl https://YOUR-APP.fly.dev/health/live
curl https://YOUR-APP.fly.dev/health/ready
fly logs
```

Finally, set the GitHub App webhook URL to:

```text
https://YOUR-APP.fly.dev/webhooks/github
```

The service automatically registers the corresponding Telegram webhook when it starts.

### Alternative: a small VPS

A small Ubuntu/Debian VM with Docker is the most predictable option when you already operate servers. Clone Flow AI once, keep `.env` on that server, and run:

```sh
docker compose up -d --build
docker compose ps
```

The Compose file binds port 3000 to localhost only. Put Caddy, nginx, Traefik, or your existing load balancer in front of it and terminate HTTPS there. Persist and back up the `flow-data` Docker volume. Open only ports 80 and 443 publicly.

### Alternative: Render

Create one paid Docker Web Service from this repository, add the `.env` values in Render's environment settings, attach a persistent disk at `/data`, set `DATABASE_PATH=/data/flow.db`, and configure `/health/ready` as the health endpoint. Keep the service at one instance. Render's default filesystem is ephemeral; only an attached persistent disk survives redeploys. See Render's [Docker](https://render.com/docs/docker) and [persistent disk](https://render.com/docs/disks) documentation.

Do not deploy this SQLite version to a stateless function platform or scale it horizontally. Moving to multiple service replicas requires replacing SQLite with shared transactional storage and queue leasing.

### Local-only development

For development, the same Compose command is enough:

```sh
docker compose up -d --build
docker compose ps
```

Use an HTTPS tunnel only for temporary webhook testing. A sleeping laptop is not a production host.

Health endpoints:

```text
GET /health/live
GET /health/ready
```

The GitHub CLI is needed on the administrator's computer for `flow-ai repo add`; it is not needed inside the hosted runtime container.

## 5. Add a project from its own folder

Authenticate GitHub CLI with an administrator account:

```sh
gh auth login
gh auth status
```

Enter the target project and run the installer:

```sh
cd /path/to/your-project
flow-ai repo add
```

Flow AI uses `gh repo view` to detect the repository. To configure a repository without entering its folder:

```sh
flow-ai repo add OWNER/REPO
```

The CLI prints one of two outcomes:

1. The setup PR merged successfully and the merge gate is active.
2. Existing repository protection requires human approval. Open the printed setup PR, approve and merge it, then run `flow-ai repo add` again. The second run activates the merge gate.

This process does not modify the target's local working tree and does not push application feature code from your computer. Repository installation happens through GitHub's API and the reviewable setup branch.

### Add several repositories to the same service

Repeat the repository command for each project. Do not create another Flow AI deployment:

```sh
cd /work/acme-web
flow-ai repo add

cd /work/acme-api
flow-ai repo add

cd /work/acme-mobile
flow-ai repo add
```

Install the same private GitHub App on all three repositories. The CLI stores provider credentials and workflows separately in each repository, while all webhook events return to the one central `PUBLIC_URL`.

Then bind Telegram destinations independently:

```text
# In the Web topic
/connect acme/web

# In the API topic
/connect acme/api

# In the Mobile topic
/connect acme/mobile
```

The same Telegram group can therefore drive several repositories without mixing drafts, issues, branches, or PR state.

## 6. Use it from Telegram

Connect a group or topic to a repository:

```text
/connect OWNER/REPO
```

Start a feedback bundle:

```text
/new
```

Now send any combination of:

- Written requirements or bug reports
- Screenshots
- Documents
- Voice notes
- Ordinary videos
- Telegram video notes or screen recordings

Finish the bundle:

```text
/ship
```

Other commands:

```text
/status
/cancel
```

Flow AI transcribes audio, samples up to 12 useful video frames, analyzes screenshots and recordings, redacts common secret patterns, and turns the bundle into a structured work plan. Telegram identities remain in private SQLite storage; GitHub receives only an opaque HMAC correlation marker.

## What happens after `/ship`

1. The plan becomes a GitHub parent issue.
2. Independently deliverable work becomes GitHub sub-issues.
3. Each ready unit enters the durable build queue.
4. The selected builder receives the issue as untrusted requirements data.
5. The builder edits a credential-free checkout.
6. A fresh job validates protected paths and runs the repository's real checks.
7. Another fresh job pushes only the verified patch to `flow/<issue-number>`.
8. Flow AI opens one draft PR owned by the runtime App.
9. CI, independent AI review, and real QA execute against the exact PR SHA.
10. A failed gate creates one bounded repair attempt for that SHA.
11. When all three gates pass, the PR becomes ready and receives `flow:human`.
12. A configured human CODEOWNER reviews and merges it.

The service ignores generic check runs, forked branches, stale SHAs, incorrect workflow paths, collaborator-dispatched runs, and PRs not created by the Flow App.

## Real QA, not mock-only QA

Each repository receives two contracts:

- `.flow/config.json` defines install, check, QA, start, health, and protected-path rules.
- `.flow/qa.json` defines real API probes, browser journeys, screen sizes, assertions, fonts, design tokens, and minimum control sizes.

The default preset expects a Node web application on port 3000. Commands are arrays, not shell strings. This prevents feedback text from becoming executable commands.

Local candidate QA:

- Runs install, test, build, and the application server inside a secretless container.
- Mounts the trusted QA contract read-only.
- Keeps the browser harness and evidence outside the candidate's writable filesystem.
- Calls the running application's real endpoints.
- Drives the real UI with Playwright and Stagehand-compatible journeys.
- Captures 390×844 mobile and 1440×900 desktop screenshots.
- Fails for horizontal overflow, unexpected fonts, missing design tokens, undersized controls, failed assertions, or incorrect endpoint responses.

If the application needs authentication, external services, or dedicated test data, use an isolated preview environment. Set the repository variable:

```text
FLOW_QA_BASE_URL=https://preview-{pr}.example.com
```

The `{pr}` placeholder becomes the pull request number. Store only dedicated low-privilege test credentials in these optional repository secrets:

```text
FLOW_QA_EMAIL
FLOW_QA_PASSWORD
FLOW_QA_TOKEN
```

Never use production or customer credentials. Local candidate jobs receive no repository secrets.

The target application's configured start command must listen on `0.0.0.0` inside its QA container. Update `.flow/config.json` through a human-reviewed PR when the project uses another runtime, port, or command set.

## Security boundaries

- The runtime GitHub App has read-only Contents access and cannot edit CODEOWNERS or the merge ruleset.
- The human GitHub CLI token is used only during explicit repository provisioning.
- GitHub workflow permissions default to read-only.
- Provider credentials never enter the branch-push job.
- Candidate application code never shares a runner with preview credentials.
- Code review runs against a fixed diff from a trusted-base checkout.
- Review publication runs in a separate write-capable job with data-only input.
- Workflow results require the expected App actor, triggering actor, workflow ID, path, default branch, and trusted workflow commit.
- Required `ci`, `ai-review`, and `qa` checks are tied to the runtime App's integration ID.
- Every generated PR requires a fresh human CODEOWNER approval.
- Webhook receipt and job creation are committed in one database transaction.
- Issue creation, sub-issue linking, notifications, and repair dispatches are replay-safe.

No autonomous delivery system is literally infallible. The final human merge gate is intentional and should not be removed.

## CLI reference

```text
flow-ai setup [--agent claude|codex|cursor]
    Create the private service configuration once.

flow-ai doctor
    Validate configuration, repository kit, and durable storage.

flow-ai repo add
    Configure the GitHub repository associated with the current folder.

flow-ai repo add OWNER/REPO
    Configure an explicit GitHub repository.
```

The local `./flow` wrapper supports the same commands.

## Updating a repository's contract

Project-specific behavior belongs in the installed `.flow/` directory. Change it through a normal human-reviewed PR:

- Edit `.flow/config.json` for the project's real commands and health endpoint.
- Edit `.flow/qa.json` for real user journeys, API probes, design tokens, and fonts.
- Keep at least one API probe, one browser journey, and both mobile and desktop viewports.
- Keep automation definitions, CODEOWNERS, agent instructions, migrations, and QA scripts protected from generated feature changes.

Mock tests remain useful, but they supplement rather than replace the live application checks.

## Operations

- Back up the `flow-data` Docker volume regularly.
- Monitor `/health/ready` and container restarts.
- Rotate provider, Telegram, and GitHub App keys periodically.
- Review changes to pinned GitHub Actions and exact Playwright/Stagehand versions.
- Telegram's hosted Bot API limits bot downloads to 20 MB. Use Telegram's local Bot API server if larger recordings are required.
- Cursor's headless CLI is a vendor beta and its installer currently tracks the latest release. Treat Cursor upgrades as reviewed dependency changes.
- Run one central service replica per company/security boundary. That replica can handle many repositories. Horizontal service scaling requires replacing SQLite with a shared transactional queue.

## Troubleshooting

### `flow-ai repo add` cannot detect the project

Confirm the folder has a GitHub remote and GitHub CLI can resolve it:

```sh
git remote -v
gh repo view
```

Alternatively pass `OWNER/REPO` explicitly.

### GitHub authentication is invalid

```sh
gh auth status
gh auth login
```

The authenticated user must be allowed to create repository secrets, variables, labels, rulesets, branches, and pull requests.

### The GitHub App cannot access the repository

Install the private App on that repository and confirm its permissions match the table above.

### The setup PR is waiting

This is expected when the repository already protects its default branch. Have a qualified human approve and merge the printed `flow/setup` PR, then rerun:

```sh
flow-ai repo add
```

### Local QA cannot reach the application

Check `.flow/config.json`:

- The start command must bind to `0.0.0.0`.
- `healthUrl` must point to the exposed local port.
- The application must start without production secrets.

Use an isolated `FLOW_QA_BASE_URL` preview when those conditions are not appropriate.

## Current scope

Telegram is the supported business interface in this version. The intake model is designed so Slack and Discord adapters can be added later without changing the GitHub delivery state machine.
