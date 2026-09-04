# Flow AI

Flow AI turns a Telegram group into a guarded software-delivery queue:

`Telegram feedback → planned GitHub issues → Claude/Codex/Cursor build → AI review → real CI + browser/API/visual QA → human approval`

It is one Node service, one SQLite file, and four small workflows installed in each repository. GitHub remains the source of truth. The service never merges a pull request.

The running service uses a least-privilege GitHub App and GitHub's REST API. One-time repository provisioning uses the administrator's GitHub CLI login. Repository workflows use `gh` for issue/PR data and local `git` inside isolated Actions checkouts. This keeps runtime access narrow while every branch, commit, PR, label, check, and rule remains auditable in GitHub.

## 1. Create the two integrations

### Telegram

1. In BotFather, create a bot and copy its token.
2. Use BotFather's `/setprivacy` command and disable privacy for this bot. This lets it receive ordinary feedback, screenshots, documents, and voice notes in a group.
3. Add the bot to the Telegram group. It does not need administrator rights.
4. Record the numeric Telegram user IDs allowed to connect repositories. Separate multiple IDs with commas.

### GitHub App

Create one private GitHub App for the service. Set its webhook URL to `https://YOUR-FLOW-HOST/webhooks/github`, create a strong webhook secret, and enable these repository permissions:

- Actions: Read and write
- Checks: Read and write
- Contents: Read-only
- Issues: Read and write
- Metadata: Read-only
- Pull requests: Read and write

Subscribe to the **Pull request** and **Workflow run** events. Generate a private key and install the App on every repository Flow AI may use. Do not grant this runtime App Administration, Secrets, Variables, or Workflows permission; provisioning deliberately uses a separate human administrator credential.

## 2. Configure it

Choose one delivery agent for every AI role:

```sh
./flow setup --agent codex
# or: claude / cursor
```

For stronger separation, run `./flow setup` and leave `FLOW_AGENT` blank; then choose different `FLOW_BUILDER` and `FLOW_REVIEWER` values.

Edit `.env` and fill the required integration values plus the key for the selected delivery agent. The setup command creates this file with owner-only permissions. Generate separate Telegram and GitHub webhook secrets with `openssl rand -hex 32`. Convert the downloaded GitHub private key to the required single-line value with:

```sh
node -e "process.stdout.write(require('fs').readFileSync('YOUR-KEY.pem').toString('base64'))"
```

`PUBLIC_URL` must be the public HTTPS address of this service. OpenAI currently handles multimodal Telegram planning and transcription, so `OPENAI_API_KEY` is always required. Add `ANTHROPIC_API_KEY` when Claude is selected or `CURSOR_API_KEY` when Cursor is selected. In single-agent mode, the selected vendor performs build, code review, and visual QA in separate invocations; split mode remains the safer default for independent review.

Set `FLOW_CODEOWNERS` to the human GitHub users or organization teams that may approve generated pull requests, such as `@octocat` or `@your-org/platform-team`. Flow AI installs this as a repository-wide CODEOWNERS rule; the runtime App is deliberately unable to alter it.

Validate everything local before deployment:

```sh
./flow doctor
```

## 3. Run the service

```sh
docker compose up -d --build
docker compose ps
```

Deploy the same container on any host that gives it a stable HTTPS URL. Keep the `/data` volume; it contains the durable queue and work links. Only port 3000 needs routing. Never expose `.env` or the SQLite volume publicly.

## 4. Add a repository

```sh
gh auth login
gh auth status
./flow repo add OWNER/REPO
```

The command uses the GitHub CLI credential only for provisioning. It creates a `flow/setup` branch and pull request, attempts to merge that setup PR through the repository's existing rules, installs encrypted Actions secrets, sets workflow variables, creates the `flow:*` labels, forces the repository's default workflow token to read-only, and installs the human-code-owner approval ruleset only after setup is merged. If existing protection requires a person to approve the setup PR, the command prints its link; merge it and run the same command once more. Existing `AGENTS.md`, `CLAUDE.md`, and CODEOWNERS content is preserved; the Flow rule is appended as the final repository-wide ownership rule.

The included preset assumes a Node web app that starts on port 3000. Before adding another stack, change `repo-kit/.flow/config.json` to safe command arrays and set the real start/health values. No shell strings are accepted. Configure `repo-kit/.flow/qa.json` with the application's real routes, API probes, expected UI state, approved fonts/design tokens, and any login journey. The shipped contract already fails closed unless it has at least one live API probe, one browser journey, and both mobile and desktop viewports.

For an authenticated journey, use an isolated preview deployment and set the repository variable `FLOW_QA_BASE_URL`; `{pr}` may be used as a pull-request-number placeholder. Store only dedicated, low-privilege test values in `FLOW_QA_EMAIL`, `FLOW_QA_PASSWORD`, and `FLOW_QA_TOKEN` repository secrets. Never use production or customer credentials. Local merge-candidate testing intentionally receives no repository secrets.

## 5. Use it from Telegram

In the Telegram group or topic:

```text
/connect OWNER/REPO
/new
```

Send messages, screenshots, documents, voice notes, ordinary videos, or Telegram video notes, then send:

```text
/ship
```

Flow AI redacts common secret patterns in text, transcribes voice and screen-recording audio, samples up to 12 recording frames for vision, creates one parent issue plus independently mergeable sub-issues, and starts work. Telegram identities remain private in SQLite; GitHub receives only an HMAC correlation marker. Screenshots and sampled frames are sent to the configured OpenAI account for vision, so the Telegram allowlist must use dedicated business participants and they must avoid submitting unrelated confidential material. Telegram's hosted Bot API limits downloads to 20 MB; run Telegram's local Bot API server if larger recordings are required.

Each PR is checked by `ci`, `ai-review`, and `qa`. QA runs the repository's real commands, starts the actual merge candidate or targets an isolated preview, probes real endpoints without response mocks, drives configured browser journeys, and captures mobile/desktop screenshots. Deterministic checks reject horizontal overflow, unexpected fonts, missing CSS tokens, undersized controls, failed assertions, and bad endpoint responses. The selected QA agent then inspects the screenshots for visual, design-language, UI, and UX regressions. Failed checks get at most two automatic repair rounds. Passing work receives `flow:human`; GitHub still requires one human approval before merge.

Useful commands are `/status` and `/cancel`. Only IDs in `TELEGRAM_ADMIN_IDS` can queue feedback or use any Flow command; unauthorized updates are acknowledged and discarded before entering the durable queue.

## Operating rules

- Builders can edit a credential-free checkout but cannot approve or merge. A separate clean job applies the verified patch and receives the narrowly scoped branch-write token without executing repository code.
- Reviewers run read-only from the trusted base checkout against a fixed diff artifact and emit a strict JSON verdict. Candidate code never shares their runner with provider credentials.
- Review, CI, and QA definitions come from the trusted default branch. The service accepts results only from the exact active workflow ID/path when the App bot dispatched it from a commit in the default branch's history, then publishes those results onto the exact PR head commit.
- Only App-authored PRs from the exact `flow/<issue>` branch in the target repository are accepted. Forks, wrong bases, generic check runs, wrong workflow paths, and stale SHA results are ignored.
- Webhook receipt and job creation are one database transaction. `/ship` persists its generated plan before GitHub writes, reconciles issues through opaque source markers, and queues each build durably. A failed PR head consumes at most one repair round.
- Real local candidate tests receive no secrets. Dedicated low-privilege QA credentials are exposed only in a separate trusted-base job that drives the isolated preview URL.
- Protected paths and all executable commands live in `.flow/`; issue text and attachments are always treated as untrusted data.
- Every PR requires a fresh approval from a configured human CODEOWNER. The runtime App has read-only Contents access and no Administration permission, so it cannot rewrite the ownership rule or merge gate.
- UI/API acceptance tests must hit the running application. Mock-only tests can supplement them but cannot replace them.

Cursor's headless CLI is currently a vendor beta and its official installer tracks the latest release. Claude and Codex Actions are commit-pinned; Stagehand and Playwright are exact-version pinned. Treat Cursor upgrades as a reviewed dependency change if your organization requires fully reproducible tooling.

Check service health at `/health/live` and `/health/ready`. Back up the Docker volume regularly.
