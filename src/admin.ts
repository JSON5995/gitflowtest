import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ControlPlane, ControlPlaneSnapshot } from "./control-plane.js";
import type { Provider } from "./domain.js";
import type { GitHubAppAccess, GitHubInstallation, GitHubInstallationRepository } from "./github-app.js";
import type { AdminSummary, AdminWorkItem } from "./storage.js";

export type AdminRouteOptions = {
  username: string;
  password: string;
  getSummary: () => AdminSummary | Promise<AdminSummary>;
  publicUrl?: string;
  trustedOrigins?: string[];
  controlPlane?: Pick<ControlPlane, "getSnapshot" | "saveProviderCredential" | "refreshProviderModels" | "saveRoutingSettings" | "provisionRepository">;
  github?: {
    appSlug: string;
    stateSecret: Buffer;
    access: Pick<GitHubAppAccess, "getInstallation" | "listInstallations" | "listInstallationRepositories">;
  };
};

type AdminGitHubInstallation = GitHubInstallation & {
  repositories: GitHubInstallationRepository[];
  missingPermissions: string[];
};

const FLOW_WRITE_PERMISSIONS = [
  "actions",
  "administration",
  "checks",
  "contents",
  "issues",
  "pull_requests",
  "secrets",
  "actions_variables",
  "workflows",
] as const;

const ADMIN_CSP = [
  "default-src 'none'",
  "style-src 'self'",
  "img-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const setAdminHeaders = (reply: FastifyReply): void => {
  reply
    .header("Cache-Control", "no-store")
    .header("Content-Security-Policy", ADMIN_CSP)
    .header("Cross-Origin-Opener-Policy", "same-origin")
    .header("Cross-Origin-Resource-Policy", "same-origin")
    .header("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
    .header("Referrer-Policy", "no-referrer")
    .header("Strict-Transport-Security", "max-age=63072000; includeSubDomains")
    .header("X-Content-Type-Options", "nosniff")
    .header("X-Frame-Options", "DENY");
};

const secureEqual = (actual: string, expected: string): boolean => {
  const actualDigest = createHash("sha256").update(actual, "utf8").digest();
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(actualDigest, expectedDigest);
};

const parseBasicCredentials = (
  authorization: string | undefined,
): { username: string; password: string } | null => {
  if (!authorization || authorization.length > 4_096) return null;
  const match = authorization.match(/^Basic ([A-Za-z0-9+/]+={0,2})$/i);
  if (!match?.[1]) return null;
  const decoded = Buffer.from(match[1], "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator < 0) return null;
  return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
};

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    };
    return entities[character] ?? character;
  });

const formatTime = (value: string): string => {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return "Unknown time";
  return parsed.toISOString().replace("T", " ").slice(0, 16) + " UTC";
};

const githubLink = (url: string | null, label: string): string => {
  if (!url) return `<span class="quiet">${escapeHtml(label)}</span>`;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.hostname !== "github.com") {
      return `<span class="quiet">${escapeHtml(label)}</span>`;
    }
    return `<a href="${escapeHtml(parsed.href)}" rel="noreferrer">${escapeHtml(label)} <span aria-hidden="true">↗</span></a>`;
  } catch {
    return `<span class="quiet">${escapeHtml(label)}</span>`;
  }
};

const renderWorkLinks = (work: AdminWorkItem): string => {
  const issue = githubLink(work.issueUrl, `Issue #${work.issueNumber}`);
  const pullRequest = work.pullRequestNumber === null
    ? '<span class="quiet">No pull request</span>'
    : githubLink(work.pullRequestUrl, `PR #${work.pullRequestNumber}`);
  return `${issue}<span class="link-divider" aria-hidden="true">/</span>${pullRequest}`;
};

const renderAdmin = (summary: AdminSummary): string => {
  const activeJobs = summary.jobStates.pending + summary.jobStates.running;
  const activeWork = summary.workStates.ready + summary.workStates.working + summary.workStates.blocked;
  const repositories = summary.repositories.length === 0
    ? '<li class="empty">No repositories are bound yet.</li>'
    : summary.repositories.map((binding) => `
        <li class="binding-row">
          <div><strong>${escapeHtml(binding.repository)}</strong><span>${escapeHtml(binding.context)}</span></div>
          <time datetime="${escapeHtml(binding.boundAt)}">${escapeHtml(formatTime(binding.boundAt))}</time>
        </li>`).join("");
  const approvals = summary.awaitingApproval.length === 0
    ? '<li class="empty">Nothing is waiting on a person.</li>'
    : summary.awaitingApproval.map((work) => `
        <li class="approval-row">
          <div>
            <span class="repo-label">${escapeHtml(work.repository)}</span>
            <strong>${work.pullRequestNumber === null ? `Issue #${work.issueNumber}` : `Pull request #${work.pullRequestNumber}`}</strong>
          </div>
          <div class="approval-meta">
            ${githubLink(work.pullRequestUrl ?? work.issueUrl, "Review on GitHub")}
            <time datetime="${escapeHtml(work.updatedAt)}">${escapeHtml(formatTime(work.updatedAt))}</time>
          </div>
        </li>`).join("");
  const recentWork = summary.recentWork.length === 0
    ? '<li class="empty">No work has entered the flow.</li>'
    : summary.recentWork.map((work) => `
        <li class="work-row">
          <div class="work-primary">
            <span class="state state-${escapeHtml(work.state)}">${escapeHtml(work.state)}</span>
            <strong>${escapeHtml(work.repository)}</strong>
          </div>
          <div class="work-links">${renderWorkLinks(work)}</div>
          <div class="work-meta"><span>${work.fixRounds} fix ${work.fixRounds === 1 ? "round" : "rounds"}</span><time datetime="${escapeHtml(work.updatedAt)}">${escapeHtml(formatTime(work.updatedAt))}</time></div>
        </li>`).join("");
  const failures = summary.recentFailures.length === 0
    ? '<li class="empty">No recent failures.</li>'
    : summary.recentFailures.map((failure) => `
        <li class="failure-row">
          <span class="failure-mark" aria-hidden="true">!</span>
          <div><strong>${escapeHtml(failure.kind)}</strong><span>${escapeHtml(failure.source)} · ${failure.attempts} ${failure.attempts === 1 ? "attempt" : "attempts"}</span></div>
          <time datetime="${escapeHtml(failure.failedAt)}">${escapeHtml(formatTime(failure.failedAt))}</time>
        </li>`).join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="30">
  <title>Flow operations</title>
  <link rel="stylesheet" href="/admin/styles.css">
</head>
<body>
  <main class="shell">
    <header class="masthead">
      <div>
        <p class="eyebrow">Flow / operator console</p>
        <h1>Flow operations</h1>
        <p class="lede">See what is moving, waiting, and needs attention.</p>
        <nav aria-label="Admin sections"><a href="/admin">Operations</a><a href="/admin/setup">Setup</a></nav>
      </div>
      <div class="health ${summary.storageReady ? "is-healthy" : "is-degraded"}">
        <span class="health-dot" aria-hidden="true"></span>
        <div><strong>${summary.storageReady ? "Systems ready" : "Storage unavailable"}</strong><span>Snapshot ${escapeHtml(formatTime(summary.generatedAt))}</span></div>
      </div>
    </header>

    <section class="pulse" aria-label="Current operating summary">
      <div><span>Repositories</span><strong>${summary.repositories.length}</strong></div>
      <div><span>Active jobs</span><strong>${activeJobs}</strong></div>
      <div><span>Active work</span><strong>${activeWork}</strong></div>
      <div class="attention"><span>Human decisions</span><strong>${summary.awaitingApproval.length}</strong></div>
    </section>

    <section class="flow-rail" aria-labelledby="flow-heading">
      <div class="section-heading"><div><p>Work state</p><h2 id="flow-heading">Delivery flow</h2></div><span>Live ledger</span></div>
      <ol>
        ${(["inbox", "ready", "working", "blocked", "human", "done"] as const).map((state) => `
          <li class="rail-${state}"><span>${state}</span><strong>${summary.workStates[state]}</strong></li>`).join("")}
      </ol>
    </section>

    <div class="grid">
      <section class="panel approvals-panel" aria-labelledby="approval-heading">
        <div class="section-heading"><div><p>Decision queue</p><h2 id="approval-heading">Awaiting approval</h2></div><span>${summary.awaitingApproval.length} open</span></div>
        <ul class="approval-list">${approvals}</ul>
      </section>

      <section class="panel jobs-panel" aria-labelledby="jobs-heading">
        <div class="section-heading"><div><p>Queue</p><h2 id="jobs-heading">Jobs</h2></div><span>${summary.jobStates.failed} failed</span></div>
        <dl class="job-grid">
          <div><dt>Pending</dt><dd>${summary.jobStates.pending}</dd></div>
          <div><dt>Running</dt><dd>${summary.jobStates.running}</dd></div>
          <div><dt>Complete</dt><dd>${summary.jobStates.complete}</dd></div>
          <div class="failed"><dt>Failed</dt><dd>${summary.jobStates.failed}</dd></div>
        </dl>
      </section>

      <section class="panel work-panel" aria-labelledby="work-heading">
        <div class="section-heading"><div><p>Latest activity</p><h2 id="work-heading">Recent work</h2></div><span>${summary.recentWork.length} shown</span></div>
        <ul class="work-list">${recentWork}</ul>
      </section>

      <section class="panel failures-panel" aria-labelledby="failures-heading">
        <div class="section-heading"><div><p>Exceptions</p><h2 id="failures-heading">Recent failures</h2></div><span>Details redacted</span></div>
        <ul class="failure-list">${failures}</ul>
      </section>

      <section class="panel bindings-panel" aria-labelledby="bindings-heading">
        <div class="section-heading"><div><p>Routing</p><h2 id="bindings-heading">Repository bindings</h2></div><span>Telegram IDs masked</span></div>
        <ul class="binding-list">${repositories}</ul>
      </section>
    </div>
    <footer>Operations refresh every 30 seconds</footer>
  </main>
</body>
</html>`;
};

const providerName = (provider: Provider): string => ({ codex: "OpenAI / Codex", claude: "Anthropic / Claude", cursor: "Cursor" })[provider];

const renderProvider = (
  connection: ControlPlaneSnapshot["providers"][number],
  catalog: ControlPlaneSnapshot["modelCatalogs"][number],
  csrf: string,
): string => `
  <article class="provider-card">
    <div class="provider-status"><div><p>${escapeHtml(providerName(connection.provider))}</p><strong>${connection.configured ? "Connected" : "Not connected"}</strong></div><span class="status-pill status-${connection.verification}">${escapeHtml(connection.verification)}</span></div>
    <p class="provider-note">${connection.provider === "cursor"
      ? "Requires a Cursor machine API key. A desktop browser login cannot authenticate an ephemeral GitHub runner. Cursor does not publish a model-list API, so use the exact model-ID fallback below."
      : "Use a server-side API key. The submitted value is verified, encrypted, and never displayed again."}</p>
    ${catalog.lastError ? `<p class="model-error" role="alert">${escapeHtml(catalog.lastError)}</p>` : ""}
    <form method="post" action="/admin/providers/${connection.provider}">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <label for="credential-${connection.provider}">New credential</label>
      <input id="credential-${connection.provider}" name="credential" type="password" required minlength="8" maxlength="16384" autocomplete="new-password">
      <button type="submit">${connection.configured ? "Replace credential" : "Connect provider"}</button>
    </form>
    ${catalog.supportsDiscovery && connection.configured ? `<form method="post" action="/admin/providers/${connection.provider}/models">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <button class="secondary-button" type="submit">Refresh available models</button>
      ${catalog.refreshedAt ? `<span class="model-refresh-time">Last successful refresh ${escapeHtml(formatTime(catalog.refreshedAt))}</span>` : ""}
    </form>` : ""}
  </article>`;

const formatDecimal = (value: number): string => String(value / 1_000_000);

const renderRouting = (
  snapshot: ControlPlaneSnapshot,
  csrf: string,
): string => {
  const candidates = snapshot.routing?.candidates ?? [];
  const limits = snapshot.routing?.policy.limits;
  const routingRoles = [
    { id: "build", name: "Builder", agentRoles: ["intake", "plan", "build"] as const },
    { id: "review", name: "Reviewer", agentRoles: ["review", "security"] as const },
    { id: "qa", name: "Visual QA", agentRoles: ["qa"] as const },
  ] as const;
  const providerFields = (["codex", "claude", "cursor"] as const).map((provider) => {
    const providerCandidates = candidates.filter((candidate) => candidate.provider === provider);
    const legacyCandidate = providerCandidates.find((candidate) => !candidate.roles);
    const catalog = snapshot.modelCatalogs.find((item) => item.provider === provider);
    const roleFields = routingRoles.map((role) => {
      const candidate = providerCandidates.find((item) => item.roles?.some((itemRole) => role.agentRoles.includes(itemRole as never)))
        ?? legacyCandidate;
      const compatibleModels = catalog?.models.filter((model) => model.roles.includes(role.id)) ?? [];
      const datalistId = `${provider}-${role.id}-models`;
      const modelInput = `${provider}_${role.id}_model`;
      const list = provider === "cursor" ? "" : ` list="${datalistId}"`;
      const datalist = provider === "cursor" ? "" : `<datalist id="${datalistId}">${compatibleModels
        .map((model) => `<option value="${escapeHtml(model.id)}" label="${escapeHtml(`${model.name} — ${model.id}`)}"></option>`)
        .join("")}</datalist>`;
      return `<section class="role-model">
        <h3>${escapeHtml(role.name)}</h3>
        <label for="${modelInput}">Choose or enter exact model ID</label>
        <input id="${modelInput}" name="${modelInput}"${list} maxlength="200" value="${escapeHtml(candidate?.model ?? "")}" placeholder="Exact provider model ID" autocomplete="off">
        ${datalist}
        <label for="${provider}_${role.id}_tier">Model tier</label>
        <select id="${provider}_${role.id}_tier" name="${provider}_${role.id}_tier"><option value="economy"${candidate?.tier === "economy" ? " selected" : ""}>Economy</option><option value="frontier"${candidate?.tier !== "economy" ? " selected" : ""}>Frontier</option></select>
        <div class="price-grid">
          <label for="${provider}_${role.id}_input_price">Input $ / 1M<input id="${provider}_${role.id}_input_price" name="${provider}_${role.id}_input_price" type="number" min="0" max="100000" step="0.000001" value="${candidate ? formatDecimal(candidate.inputMicrosPerMillionTokens) : "0"}"></label>
          <label for="${provider}_${role.id}_output_price">Output $ / 1M<input id="${provider}_${role.id}_output_price" name="${provider}_${role.id}_output_price" type="number" min="0" max="100000" step="0.000001" value="${candidate ? formatDecimal(candidate.outputMicrosPerMillionTokens) : "0"}"></label>
        </div>
      </section>`;
    }).join("");
    return `<fieldset class="routing-card">
      <legend>${escapeHtml(providerName(provider))}</legend>
      <label class="toggle"><input name="${provider}_enabled" type="checkbox"${providerCandidates.some((candidate) => candidate.enabled) ? " checked" : ""}> Use this provider</label>
      ${roleFields}
    </fieldset>`;
  }).join("");
  const usage = snapshot.routingSummary;
  return `<p class="provider-note">Flow chooses among enabled providers for each role, then hands off automatically when one is unavailable. Search the discovered list or enter an exact model ID as the advanced fallback. Rates remain manual because model-list APIs do not provide your current prices.</p>
    <div class="usage-strip"><span>${escapeHtml(usage.month)}</span><strong>${usage.settledTokens.toLocaleString("en-US")} used</strong><span>${usage.reservedTokens.toLocaleString("en-US")} reserved · $${formatDecimal(usage.settledCostMicros)} settled</span></div>
    <form method="post" action="/admin/routing" class="routing-form">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <div class="routing-grid">${providerFields}</div>
      <fieldset class="budget-card"><legend>Hard admission limits</legend>
        <div class="budget-grid">
          <label for="per_job_tokens">Tokens per job<input id="per_job_tokens" name="per_job_tokens" type="number" min="1" step="1" required value="${limits?.perJobTokens ?? 500_000}"></label>
          <label for="monthly_tokens">Tokens per month<input id="monthly_tokens" name="monthly_tokens" type="number" min="1" step="1" required value="${limits?.monthlyTokens ?? 10_000_000}"></label>
          <label for="per_job_cost">Cost per job ($)<input id="per_job_cost" name="per_job_cost" type="number" min="0.000001" step="0.000001" required value="${limits ? formatDecimal(limits.perJobCostMicros) : "25"}"></label>
          <label for="monthly_cost">Cost per month ($)<input id="monthly_cost" name="monthly_cost" type="number" min="0.000001" step="0.000001" required value="${limits ? formatDecimal(limits.monthlyCostMicros) : "500"}"></label>
          <label for="max_retries">Retries before handoff<input id="max_retries" name="max_retries" type="number" min="0" max="5" step="1" required value="${snapshot.routing?.policy.maxTransientRetriesPerCandidate ?? 1}"></label>
        </div>
      </fieldset>
      <button type="submit">Save routing policy</button>
    </form>`;
};

const renderGitHubRepositoryPicker = (
  snapshot: ControlPlaneSnapshot,
  installations: AdminGitHubInstallation[],
  csrf: string,
  appSlug?: string,
): string => {
  const managed = new Map(snapshot.repositories.map((repository) => [repository.repository.toLowerCase(), repository]));
  const available = installations.flatMap((installation) =>
    installation.missingPermissions.length === 0
      ? installation.repositories.filter((repository) => !repository.archived && !repository.disabled)
      : []);
  const options = available
    .map((repository) => {
      const existing = managed.get(repository.fullName.toLowerCase());
      const status = existing ? ` — ${existing.status}` : "";
      return `<option value="${escapeHtml(repository.fullName)}" label="${escapeHtml(`${repository.fullName}${status}`)}"></option>`;
    })
    .join("");
  const installationRows = installations.length === 0
    ? '<li class="empty">No GitHub App installations are visible yet.</li>'
    : installations.map((installation) => `<li>
        <div><strong>${escapeHtml(installation.account.login)}</strong><span>${installation.missingPermissions.length === 0
          ? `${installation.repositories.length} accessible repositories`
          : `Missing required App permissions: ${installation.missingPermissions.join(", ")}`}</span></div>
        ${githubLink(installation.htmlUrl, "Update repository access")}
      </li>`).join("");
  const connect = appSlug
    ? '<a class="button-link" href="/admin/github/connect">Connect GitHub</a>'
    : '<span class="quiet">GitHub installation flow is unavailable.</span>';
  return `
      <div class="github-connect"><div><strong>Install or update the GitHub App</strong><p class="provider-note">GitHub lets you choose the account, organization, and repositories. Flow validates the returned installation before listing anything.</p></div>${connect}</div>
      <ul class="managed-list installation-list">${installationRows}</ul>
      <form method="post" action="/admin/repositories" class="repository-form">
        <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
        <div class="repository-field"><label for="repository">Search installed repositories</label><input id="repository" name="repository" list="github-repositories" maxlength="200" placeholder="Start typing owner/repository" autocomplete="off"></div>
        <datalist id="github-repositories">${options}</datalist>
        <div class="repository-field"><label for="codeowners">Required human reviewers</label><input id="codeowners" name="codeowners" required maxlength="1000" placeholder="@owner,@org/team" autocomplete="off"></div>
        <label class="confirm-repository"><input name="confirm" type="checkbox" value="yes" required> I confirm Flow may open the reviewed setup PR for this repository.</label>
        <button type="submit">Add or reconcile repository</button>
        <details class="manual-repository"><summary>Advanced: enter a repository manually</summary><label for="repository_manual">Exact owner/repository</label><input id="repository_manual" name="repository_manual" maxlength="200" placeholder="owner/repository" autocomplete="off"></details>
      </form>`;
};

const renderSetup = (
  snapshot: ControlPlaneSnapshot,
  csrf: string,
  notice?: string,
  githubInstallations: AdminGitHubInstallation[] = [],
  appSlug?: string,
): string => {
  const activeRepositories = snapshot.repositories.filter((repository) => repository.status === "active").length;
  const pendingRepositories = snapshot.repositories.length - activeRepositories;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Flow setup</title>
  <link rel="stylesheet" href="/admin/styles.css">
</head>
<body>
  <main class="shell setup-shell">
    <header class="setup-header">
      <div><p class="eyebrow">Flow / control plane</p><h1>Setup</h1><p class="lede">Connect machine credentials, choose models and budgets, then add repositories.</p></div>
      <nav aria-label="Admin sections"><a href="/admin">Operations</a><a href="/admin/setup" aria-current="page">Setup</a></nav>
    </header>
    ${notice ? `<p class="notice" role="status">${escapeHtml(notice)}</p>` : ""}
    <section class="setup-section" aria-labelledby="providers-heading">
      <div class="section-heading"><div><p>Authentication</p><h2 id="providers-heading">Connect providers</h2></div><span>Secrets are write-only</span></div>
      <div class="provider-grid">${snapshot.providers.map((provider) => renderProvider(
        provider,
        snapshot.modelCatalogs.find((catalog) => catalog.provider === provider.provider)!,
        csrf,
      )).join("")}</div>
    </section>
    <section class="setup-section" aria-labelledby="routing-heading">
      <div class="section-heading"><div><p>Policy</p><h2 id="routing-heading">Models and budgets</h2></div><span>${snapshot.routing ? "Configured" : "Not configured"}</span></div>
      ${snapshot.routing ? "" : '<p class="setup-warning" role="alert">Work is paused until you choose models and save these routing settings.</p>'}
      ${renderRouting(snapshot, csrf)}
    </section>
    <section class="setup-section" aria-labelledby="repos-heading">
      <div class="section-heading"><div><p>GitHub</p><h2 id="repos-heading">Managed repositories</h2></div><span>${activeRepositories} active · ${pendingRepositories} pending</span></div>
      <p class="provider-note">Provider credentials are added only after the reviewed setup PR is merged, the exact protected kit is verified on the default branch, and the human merge gate is installed.</p>
      ${renderGitHubRepositoryPicker(snapshot, githubInstallations, csrf, appSlug)}
      <ul class="managed-list">${snapshot.repositories.length === 0
        ? '<li class="empty">No repositories have been provisioned from this console.</li>'
        : snapshot.repositories.map((repository) => `<li><div><strong>${escapeHtml(repository.repository)}</strong><span>${repository.status === "active" ? "Active — merge gate installed" : "Pending — merge the setup PR, then add this repository again to activate it"}</span></div>${repository.setupPullRequestUrl ? githubLink(repository.setupPullRequestUrl, "Open setup PR") : ""}</li>`).join("")}</ul>
    </section>
    <footer>Credentials are encrypted at rest · values are never shown again</footer>
  </main>
</body>
</html>`;
};

const ADMIN_STYLES = `
:root {
  color-scheme: light;
  --ink: #101820;
  --muted: #5a6872;
  --fog: #f1f5f7;
  --paper: #fbfcfc;
  --line: #d6dfe3;
  --blue: #165dcc;
  --blue-soft: #e8f0fd;
  --green: #11705b;
  --green-soft: #e4f4ee;
  --amber: #9a5d08;
  --amber-soft: #fff1d6;
  --red: #b2382b;
  --red-soft: #fbe9e6;
  --radius: 14px;
  font-family: "Avenir Next", "Segoe UI", sans-serif;
  background: var(--fog);
  color: var(--ink);
}
* { box-sizing: border-box; }
body { margin: 0; min-width: 320px; background: var(--fog); }
a { color: var(--blue); font-weight: 650; text-decoration-thickness: 1px; text-underline-offset: 3px; }
a:hover { text-decoration-thickness: 2px; }
a:focus-visible { outline: 3px solid #72a7ff; outline-offset: 3px; border-radius: 2px; }
.shell { width: min(1180px, calc(100% - 40px)); margin: 0 auto; padding: 48px 0 32px; }
.masthead { display: flex; align-items: end; justify-content: space-between; gap: 32px; margin-bottom: 32px; }
.eyebrow, .section-heading p { margin: 0 0 7px; color: var(--blue); font-family: ui-monospace, "SFMono-Regular", Consolas, monospace; font-size: 11px; font-weight: 750; letter-spacing: .11em; text-transform: uppercase; }
h1, h2 { margin: 0; font-family: "Arial Narrow", "Avenir Next Condensed", "Segoe UI", sans-serif; letter-spacing: -.035em; }
h1 { max-width: 680px; font-size: clamp(46px, 7vw, 82px); font-stretch: condensed; font-weight: 800; line-height: .94; }
h2 { font-size: 25px; line-height: 1; }
.lede { max-width: 560px; margin: 16px 0 0; color: var(--muted); font-size: 16px; line-height: 1.5; }
nav { display: flex; gap: 16px; margin-top: 18px; font-size: 13px; }
.health { display: flex; align-items: center; gap: 12px; min-width: 225px; padding: 13px 15px; border: 1px solid var(--line); border-radius: 12px; background: var(--paper); box-shadow: 0 8px 30px rgba(16, 24, 32, .06); }
.health-dot { width: 11px; height: 11px; flex: 0 0 auto; border-radius: 50%; background: var(--red); box-shadow: 0 0 0 5px var(--red-soft); }
.health.is-healthy .health-dot { background: var(--green); box-shadow: 0 0 0 5px var(--green-soft); }
.health div { display: grid; gap: 2px; }
.health strong { font-size: 14px; }
.health span:last-child { color: var(--muted); font-family: ui-monospace, "SFMono-Regular", Consolas, monospace; font-size: 10px; }
.pulse { display: grid; grid-template-columns: repeat(4, 1fr); overflow: hidden; margin-bottom: 18px; border: 1px solid var(--ink); border-radius: var(--radius); background: var(--ink); color: white; }
.pulse div { display: flex; min-height: 108px; padding: 18px 20px; flex-direction: column; justify-content: space-between; border-right: 1px solid #35414a; }
.pulse div:last-child { border-right: 0; }
.pulse span { color: #b9c5cc; font-size: 12px; font-weight: 650; letter-spacing: .04em; text-transform: uppercase; }
.pulse strong { font-family: ui-monospace, "SFMono-Regular", Consolas, monospace; font-size: 36px; line-height: 1; }
.pulse .attention { background: var(--blue); }
.pulse .attention span { color: #dce9ff; }
.flow-rail, .panel { border: 1px solid var(--line); border-radius: var(--radius); background: var(--paper); box-shadow: 0 10px 35px rgba(30, 45, 55, .045); }
.flow-rail { margin-bottom: 18px; padding: 22px; }
.section-heading { display: flex; align-items: end; justify-content: space-between; gap: 20px; margin-bottom: 22px; }
.section-heading > span { color: var(--muted); font-family: ui-monospace, "SFMono-Regular", Consolas, monospace; font-size: 10px; letter-spacing: .03em; text-transform: uppercase; }
.flow-rail ol { display: grid; grid-template-columns: repeat(6, 1fr); margin: 0; padding: 0; list-style: none; }
.flow-rail li { position: relative; display: grid; gap: 9px; padding: 15px 16px; border-top: 3px solid var(--line); border-right: 1px solid var(--line); }
.flow-rail li:last-child { border-right: 0; }
.flow-rail li::before { position: absolute; top: -7px; left: 15px; width: 10px; height: 10px; border: 2px solid var(--paper); border-radius: 50%; background: var(--muted); content: ""; }
.flow-rail li.rail-working::before, .flow-rail li.rail-ready::before { background: var(--blue); }
.flow-rail li.rail-blocked::before { background: var(--red); }
.flow-rail li.rail-human::before { background: var(--amber); }
.flow-rail li.rail-done::before { background: var(--green); }
.flow-rail li span { color: var(--muted); font-size: 11px; font-weight: 700; letter-spacing: .07em; text-transform: uppercase; }
.flow-rail li strong { font-family: ui-monospace, "SFMono-Regular", Consolas, monospace; font-size: 24px; }
.grid { display: grid; grid-template-columns: minmax(0, 1.45fr) minmax(300px, .75fr); gap: 18px; }
.panel { min-width: 0; padding: 22px; }
.work-panel, .bindings-panel { grid-column: 1 / -1; }
ul { margin: 0; padding: 0; list-style: none; }
.approval-row, .binding-row, .failure-row, .work-row { border-top: 1px solid var(--line); }
.approval-row:first-child, .binding-row:first-child, .failure-row:first-child, .work-row:first-child { border-top: 0; }
.approval-row { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 15px 0; }
.approval-row > div:first-child { display: grid; gap: 3px; }
.repo-label { color: var(--muted); font-size: 11px; font-weight: 650; }
.approval-meta { display: grid; justify-items: end; gap: 5px; }
time, .work-meta { color: var(--muted); font-family: ui-monospace, "SFMono-Regular", Consolas, monospace; font-size: 10px; }
.job-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin: 0; }
.job-grid div { display: grid; gap: 10px; padding: 14px; border-radius: 9px; background: var(--fog); }
.job-grid div.failed { background: var(--red-soft); }
.job-grid dt { color: var(--muted); font-size: 11px; font-weight: 700; text-transform: uppercase; }
.job-grid dd { margin: 0; font-family: ui-monospace, "SFMono-Regular", Consolas, monospace; font-size: 24px; font-weight: 800; }
.work-row { display: grid; grid-template-columns: minmax(190px, .8fr) minmax(230px, 1fr) auto; align-items: center; gap: 18px; padding: 14px 0; }
.work-primary { display: flex; align-items: center; gap: 10px; min-width: 0; }
.work-primary strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.state { min-width: 68px; padding: 5px 7px; border-radius: 5px; background: var(--fog); color: var(--muted); font-family: ui-monospace, "SFMono-Regular", Consolas, monospace; font-size: 9px; font-weight: 800; letter-spacing: .06em; text-align: center; text-transform: uppercase; }
.state-working, .state-ready { background: var(--blue-soft); color: var(--blue); }
.state-blocked { background: var(--red-soft); color: var(--red); }
.state-human { background: var(--amber-soft); color: var(--amber); }
.state-done { background: var(--green-soft); color: var(--green); }
.work-links { display: flex; align-items: center; gap: 9px; font-size: 12px; }
.link-divider { color: var(--line); }
.work-meta { display: grid; justify-items: end; gap: 4px; white-space: nowrap; }
.failure-row, .binding-row { display: grid; align-items: center; gap: 12px; padding: 14px 0; }
.failure-row { grid-template-columns: auto 1fr auto; }
.failure-mark { display: grid; width: 25px; height: 25px; place-items: center; border-radius: 50%; background: var(--red-soft); color: var(--red); font-family: ui-monospace, "SFMono-Regular", Consolas, monospace; font-weight: 900; }
.failure-row div, .binding-row div { display: grid; gap: 3px; }
.failure-row div span, .binding-row div span { color: var(--muted); font-size: 11px; }
.binding-row { grid-template-columns: 1fr auto; }
.empty { padding: 24px 0 4px; color: var(--muted); font-size: 14px; }
.quiet { color: var(--muted); }
footer { padding: 24px 2px 0; color: var(--muted); font-family: ui-monospace, "SFMono-Regular", Consolas, monospace; font-size: 10px; text-transform: uppercase; }
.setup-shell { max-width: 980px; }
.setup-header { display: flex; align-items: end; justify-content: space-between; gap: 24px; margin-bottom: 28px; }
.setup-header h1 { font-size: clamp(46px, 7vw, 72px); }
.setup-section { margin-bottom: 18px; padding: 22px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--paper); box-shadow: 0 10px 35px rgba(30, 45, 55, .045); }
.provider-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.provider-card { min-width: 0; padding: 16px; border: 1px solid var(--line); border-radius: 10px; background: white; }
.provider-status { display: flex; align-items: start; justify-content: space-between; gap: 10px; }
.provider-status p { margin: 0 0 3px; color: var(--muted); font-size: 11px; }
.provider-status strong { font-size: 15px; }
.status-pill { padding: 4px 6px; border-radius: 5px; background: var(--fog); color: var(--muted); font-family: ui-monospace, "SFMono-Regular", Consolas, monospace; font-size: 8px; font-weight: 800; text-transform: uppercase; }
.status-verified { background: var(--green-soft); color: var(--green); }
.status-configured { background: var(--amber-soft); color: var(--amber); }
.provider-note { color: var(--muted); font-size: 12px; line-height: 1.55; }
.model-error { padding: 9px; border-radius: 7px; background: var(--red-soft); color: var(--red); font-size: 11px; line-height: 1.45; }
.model-refresh-time { color: var(--muted); font-size: 10px; line-height: 1.4; }
form { display: grid; gap: 8px; margin-top: 14px; }
label { color: var(--muted); font-size: 11px; font-weight: 700; }
input, select { width: 100%; min-width: 0; padding: 10px 11px; border: 1px solid var(--line); border-radius: 7px; background: white; color: var(--ink); font: inherit; }
input:focus-visible, select:focus-visible, button:focus-visible { outline: 3px solid #72a7ff; outline-offset: 2px; }
button { width: fit-content; padding: 9px 12px; border: 0; border-radius: 7px; background: var(--ink); color: white; font: inherit; font-size: 12px; font-weight: 750; cursor: pointer; }
button:hover { background: var(--blue); }
.secondary-button { border: 1px solid var(--line); background: white; color: var(--ink); }
.notice { padding: 12px 14px; border: 1px solid #b9ddce; border-radius: 9px; background: var(--green-soft); color: var(--green); font-size: 13px; font-weight: 650; }
.setup-warning { padding: 12px 14px; border: 1px solid #edc878; border-radius: 9px; background: #fff7e6; color: #7a4b00; font-size: 13px; font-weight: 650; }
.github-connect { display: flex; align-items: center; justify-content: space-between; gap: 18px; margin-top: 14px; padding: 15px; border: 1px solid var(--line); border-radius: 10px; background: white; }
.github-connect strong { font-size: 14px; }
.github-connect p { margin: 5px 0 0; }
.button-link { display: inline-block; flex: 0 0 auto; padding: 9px 12px; border-radius: 7px; background: var(--ink); color: white; font-size: 12px; text-decoration: none; }
.button-link:hover { background: var(--blue); }
.repository-form { grid-template-columns: 1fr 1fr; align-items: end; gap: 10px; }
.repository-field { display: grid; gap: 5px; }
.confirm-repository { display: flex; grid-column: 1 / -1; align-items: center; gap: 8px; color: var(--ink); }
.confirm-repository input { width: auto; }
.manual-repository { grid-column: 1 / -1; color: var(--muted); font-size: 11px; }
.manual-repository summary { cursor: pointer; font-weight: 700; }
.manual-repository label { display: block; margin: 9px 0 5px; }
.managed-list { margin-top: 20px; }
.managed-list li { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 13px 0; border-top: 1px solid var(--line); }
.managed-list li div { display: grid; gap: 3px; }
.managed-list li span { color: var(--muted); font-size: 11px; }
.routing-form { gap: 14px; }
.routing-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
fieldset { min-width: 0; margin: 0; border: 1px solid var(--line); border-radius: 10px; }
legend { padding: 0 6px; font-size: 12px; font-weight: 800; }
.routing-card, .budget-card { display: grid; gap: 8px; padding: 14px; background: white; }
.role-model { display: grid; gap: 7px; padding-top: 12px; border-top: 1px solid var(--line); }
.role-model h3 { margin: 0; font-size: 13px; }
.toggle { display: flex; align-items: center; gap: 7px; color: var(--ink); }
.toggle input { width: auto; }
.price-grid, .budget-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 9px; }
.price-grid label, .budget-grid label { display: grid; gap: 5px; }
.usage-strip { display: flex; align-items: center; gap: 12px; padding: 11px 13px; border-radius: 8px; background: var(--fog); font-family: ui-monospace, "SFMono-Regular", Consolas, monospace; font-size: 10px; }
.usage-strip strong { margin-left: auto; }
@media (max-width: 760px) {
  .shell { width: min(100% - 24px, 620px); padding-top: 28px; }
  .masthead { align-items: stretch; flex-direction: column; }
  .health { min-width: 0; }
  .pulse { grid-template-columns: 1fr 1fr; }
  .pulse div { min-height: 92px; border-bottom: 1px solid #35414a; }
  .pulse div:nth-child(2) { border-right: 0; }
  .pulse div:nth-child(3), .pulse div:nth-child(4) { border-bottom: 0; }
  .flow-rail ol { grid-template-columns: 1fr 1fr 1fr; }
  .flow-rail li:nth-child(3) { border-right: 0; }
  .grid { grid-template-columns: 1fr; }
  .work-panel, .bindings-panel { grid-column: auto; }
  .work-row { grid-template-columns: 1fr; gap: 9px; }
  .work-meta { justify-items: start; }
  .setup-header { align-items: start; flex-direction: column; }
  .provider-grid { grid-template-columns: 1fr; }
  .routing-grid { grid-template-columns: 1fr; }
  .repository-form { grid-template-columns: 1fr; }
  .confirm-repository, .manual-repository { grid-column: auto; }
  .github-connect { align-items: start; flex-direction: column; }
}
@media (max-width: 470px) {
  .shell { width: calc(100% - 18px); }
  h1 { font-size: 45px; }
  .pulse { border-radius: 10px; }
  .pulse div { padding: 15px; }
  .flow-rail, .panel { padding: 17px; border-radius: 10px; }
  .flow-rail ol { grid-template-columns: 1fr 1fr; }
  .flow-rail li:nth-child(2), .flow-rail li:nth-child(4) { border-right: 0; }
  .flow-rail li:nth-child(3) { border-right: 1px solid var(--line); }
  .section-heading { align-items: start; flex-direction: column; gap: 8px; }
  .approval-row { align-items: start; flex-direction: column; }
  .approval-meta { justify-items: start; }
  .binding-row, .failure-row { grid-template-columns: auto 1fr; }
  .binding-row time, .failure-row time { grid-column: 2; }
}
@media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } }
`;

const loadGitHubInstallations = async (
  access: Pick<GitHubAppAccess, "listInstallations" | "listInstallationRepositories">,
): Promise<AdminGitHubInstallation[]> => {
  const installations = await access.listInstallations();
  return Promise.all(installations.slice(0, 100).map(async (installation) => ({
    ...installation,
    repositories: await access.listInstallationRepositories(installation.id),
    missingPermissions: FLOW_WRITE_PERMISSIONS.filter((permission) =>
      installation.permissions[permission] !== "write"),
  })));
};

export const registerAdminRoutes = (
  server: FastifyInstance,
  options: AdminRouteOptions,
): void => {
  const csrfTokens = new Set<string>();
  const publicOrigin = options.publicUrl ? new URL(options.publicUrl).origin : null;
  const trustedOrigins = new Set([
    ...(publicOrigin ? [publicOrigin] : []),
    ...(options.trustedOrigins ?? []),
  ].map((origin) => new URL(origin).origin));
  const githubStates = new Set<string>();
  const issueGitHubState = (): string => {
    if (!options.github) throw new Error("GitHub setup is unavailable");
    const payload = `${Date.now() + 10 * 60_000}.${randomBytes(24).toString("base64url")}`;
    const signature = createHmac("sha256", options.github.stateSecret).update(payload).digest("base64url");
    const state = `${payload}.${signature}`;
    githubStates.add(state);
    if (githubStates.size > 128) githubStates.delete(githubStates.values().next().value ?? "");
    return state;
  };
  const consumeGitHubState = (state: string): boolean => {
    if (!options.github || state.length > 512) return false;
    const match = state.match(/^(\d+)\.([A-Za-z0-9_-]{32})\.([A-Za-z0-9_-]{43})$/);
    if (!match?.[1] || !match[2] || !match[3]) return false;
    const payload = `${match[1]}.${match[2]}`;
    const expected = createHmac("sha256", options.github.stateSecret).update(payload).digest("base64url");
    if (!secureEqual(match[3], expected) || Number(match[1]) < Date.now()) return false;
    return githubStates.delete(state);
  };
  if (!server.hasContentTypeParser("application/x-www-form-urlencoded")) {
    server.addContentTypeParser(
      "application/x-www-form-urlencoded",
      { parseAs: "string", bodyLimit: 32 * 1024 },
      (_request, body, done) => {
        const values: Record<string, string> = {};
        for (const [key, value] of new URLSearchParams(body as string)) values[key] = value;
        done(null, values);
      },
    );
  }
  const authorize = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    setAdminHeaders(reply);
    const credentials = parseBasicCredentials(request.headers.authorization);
    const usernameMatches = secureEqual(credentials?.username ?? "", options.username);
    const passwordMatches = secureEqual(credentials?.password ?? "", options.password);
    if (usernameMatches && passwordMatches) return;
    await reply
      .header("WWW-Authenticate", 'Basic realm="Flow Admin", charset="UTF-8"')
      .code(401)
      .send({ error: "Authentication required" });
  };

  const authorizeMutation = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await authorize(request, reply);
    if (reply.sent) return;
    if (!request.headers.origin || !trustedOrigins.has(request.headers.origin)) {
      const location = publicOrigin ? `${publicOrigin}/admin` : "/admin";
      await reply.code(403).send({
        error: `Request origin was not accepted. Open Flow Admin at ${location} and try again.`,
      });
      return;
    }
  };

  const authorizeCsrf = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const body = z.record(z.string(), z.string()).safeParse(request.body);
    const token = body.success ? body.data.csrf : undefined;
    if (!token || !csrfTokens.delete(token)) {
      await reply.code(403).send({ error: "Request token was not accepted" });
    }
  };

  server.get("/admin", { onRequest: authorize }, async (_request, reply) => {
    const summary = await options.getSummary();
    return reply.type("text/html; charset=utf-8").send(renderAdmin(summary));
  });

  server.get("/admin/styles.css", { onRequest: authorize }, async (_request, reply) =>
    reply.type("text/css; charset=utf-8").send(ADMIN_STYLES));

  if (options.controlPlane) {
    server.get("/admin/setup", { onRequest: authorize }, async (request, reply) => {
      const csrf = randomBytes(32).toString("base64url");
      csrfTokens.add(csrf);
      if (csrfTokens.size > 128) csrfTokens.delete(csrfTokens.values().next().value ?? "");
      const query = z.object({
        saved: z.enum(["codex", "claude", "cursor"]).optional(),
        provider: z.enum(["codex", "claude", "cursor"]).optional(),
        models: z.enum(["refreshed", "failed"]).optional(),
        github: z.enum(["connected", "failed"]).optional(),
        repository: z.enum(["pending", "active"]).optional(),
        routing: z.literal("saved").optional(),
      }).safeParse(request.query);
      const notice = query.success
        ? query.data.saved
          ? `${providerName(query.data.saved)} credential saved.`
          : query.data.models === "refreshed" && query.data.provider
            ? `${providerName(query.data.provider)} model list refreshed.`
          : query.data.models === "failed" && query.data.provider
            ? `${providerName(query.data.provider)} model refresh failed. The last successful list is still available below.`
          : query.data.github === "connected"
            ? "GitHub App installation validated. Choose a repository below."
          : query.data.github === "failed"
            ? "GitHub installation could not be loaded. Reconnect GitHub or update the App permissions."
          : query.data.routing
            ? "Routing models and hard budget limits saved."
          : query.data.repository === "pending"
            ? "Repository pending. Merge its setup pull request, then add it again to install the merge gate and activate it."
          : query.data.repository === "active"
            ? "Repository active. The setup is merged, merge gate is installed, and provider credentials are available to its workflows."
            : undefined
        : undefined;
      let githubInstallations: AdminGitHubInstallation[] = [];
      let githubNotice = notice;
      if (options.github) {
        try {
          githubInstallations = await loadGitHubInstallations(options.github.access);
        } catch {
          githubNotice = githubNotice ?? "GitHub installations could not be listed. Check the App key and permissions, then reconnect.";
        }
      }
      return reply.type("text/html; charset=utf-8").send(renderSetup(
        options.controlPlane!.getSnapshot(),
        csrf,
        githubNotice,
        githubInstallations,
        options.github?.appSlug,
      ));
    });

    if (options.github) {
      server.get("/admin/github/connect", { onRequest: authorize }, async (_request, reply) => {
        const state = issueGitHubState();
        const target = `https://github.com/apps/${encodeURIComponent(options.github!.appSlug)}/installations/new?state=${encodeURIComponent(state)}`;
        return reply.redirect(target, 302);
      });

      server.get("/admin/github/callback", { onRequest: authorize }, async (request, reply) => {
        const query = z.object({
          installation_id: z.coerce.number().int().positive(),
          state: z.string().min(1).max(512),
        }).safeParse(request.query);
        if (!query.success || !consumeGitHubState(query.data.state)) {
          return reply.code(403).send({ error: "GitHub setup state was invalid or expired. Start again from Flow Admin." });
        }
        try {
          const installation = await options.github!.access.getInstallation(query.data.installation_id);
          await options.github!.access.listInstallationRepositories(installation.id);
        } catch {
          return reply.redirect("/admin/setup?github=failed", 303);
        }
        return reply.redirect("/admin/setup?github=connected", 303);
      });
    }

    server.post("/admin/providers/:provider", {
      onRequest: authorizeMutation,
      preValidation: authorizeCsrf,
    }, async (request, reply) => {
      const parameters = z.object({ provider: z.enum(["codex", "claude", "cursor"]) }).parse(request.params);
      const body = z.object({ credential: z.string().min(8).max(16_384) }).parse(request.body);
      try {
        await options.controlPlane!.saveProviderCredential(parameters.provider, body.credential);
      } catch {
        return reply.code(422).send({
          error: "Credential verification or repository synchronization failed; check the provider and GitHub App access",
        });
      }
      return reply.redirect(`/admin/setup?saved=${parameters.provider}`, 303);
    });

    server.post("/admin/providers/:provider/models", {
      onRequest: authorizeMutation,
      preValidation: authorizeCsrf,
    }, async (request, reply) => {
      const parameters = z.object({ provider: z.enum(["codex", "claude"]) }).parse(request.params);
      try {
        await options.controlPlane!.refreshProviderModels(parameters.provider);
        return reply.redirect(`/admin/setup?models=refreshed&provider=${parameters.provider}`, 303);
      } catch {
        return reply.redirect(`/admin/setup?models=failed&provider=${parameters.provider}`, 303);
      }
    });

    server.post("/admin/repositories", {
      onRequest: authorizeMutation,
      preValidation: authorizeCsrf,
    }, async (request, reply) => {
      const parsedBody = z.object({
        repository: z.string().max(200).optional().default(""),
        repository_manual: z.string().max(200).optional().default(""),
        codeowners: z.string().min(1).max(1_000),
        confirm: z.literal("yes"),
      }).safeParse(request.body);
      if (!parsedBody.success) {
        return reply.code(422).send({ error: "Choose a repository, enter CODEOWNERS, and confirm provisioning" });
      }
      const body = parsedBody.data;
      const repository = (body.repository_manual.trim() || body.repository.trim());
      if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
        return reply.code(422).send({ error: "Choose an installed repository or enter exact owner/repository" });
      }
      const codeowners = body.codeowners.split(/[\s,]+/).filter(Boolean);
      if (codeowners.length === 0 || codeowners.some((entry) => !/^@[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?$/.test(entry))) {
        return reply.code(422).send({ error: "CODEOWNERS must be GitHub @users or @org/teams" });
      }
      try {
        const result = await options.controlPlane!.provisionRepository({ repository, codeowners });
        return reply.redirect(`/admin/setup?repository=${result.status}`, 303);
      } catch {
        return reply.code(422).send({ error: "GitHub could not provision that installed repository; verify App access and permissions" });
      }
    });

    server.post("/admin/routing", {
      onRequest: authorizeMutation,
      preValidation: authorizeCsrf,
    }, async (request, reply) => {
      const body = z.record(z.string(), z.string()).parse(request.body);
      const numeric = (name: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number =>
        z.coerce.number().finite().min(minimum).max(maximum).parse(body[name]);
      try {
        const roleRouting = [
          { id: "build", roles: ["intake", "plan", "build"] as const },
          { id: "review", roles: ["review", "security"] as const },
          { id: "qa", roles: ["qa"] as const },
        ];
        const candidates = (["codex", "claude", "cursor"] as const).flatMap((provider) => {
          if (body[`${provider}_enabled`] !== "on") return [];
          return roleRouting.map((role) => ({
            id: `${provider}-${role.id}`,
            provider,
            model: z.string().trim().regex(/^[A-Za-z0-9._:/-]{1,200}$/).parse(body[`${provider}_${role.id}_model`]),
            tier: z.enum(["economy", "frontier"]).parse(body[`${provider}_${role.id}_tier`]),
            enabled: true,
            roles: [...role.roles],
            inputMicrosPerMillionTokens: Math.round(numeric(`${provider}_${role.id}_input_price`, 0, 100_000) * 1_000_000),
            outputMicrosPerMillionTokens: Math.round(numeric(`${provider}_${role.id}_output_price`, 0, 100_000) * 1_000_000),
          }));
        });
        options.controlPlane!.saveRoutingSettings({
          candidates,
          policy: {
            maxTransientRetriesPerCandidate: numeric("max_retries", 0, 5),
            baseBackoffMs: 1_000,
            maxBackoffMs: 30_000,
            jitterRatio: 0.15,
            reservationTtlMs: 3_600_000,
            limits: {
              perJobTokens: numeric("per_job_tokens", 1),
              monthlyTokens: numeric("monthly_tokens", 1),
              perJobCostMicros: Math.round(numeric("per_job_cost", 0.000001, 1_000_000) * 1_000_000),
              monthlyCostMicros: Math.round(numeric("monthly_cost", 0.000001, 1_000_000) * 1_000_000),
            },
          },
        });
      } catch {
        return reply.code(422).send({ error: "Enable at least one connected provider and enter valid model, price, retry, and budget values" });
      }
      return reply.redirect("/admin/setup?routing=saved", 303);
    });
  }

  server.get("/api/admin/summary", { onRequest: authorize }, async (_request, reply) =>
    reply.send(await options.getSummary()));
};
