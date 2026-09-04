import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AdminSummary, AdminWorkItem } from "./storage.js";

export type AdminRouteOptions = {
  username: string;
  password: string;
  getSummary: () => AdminSummary | Promise<AdminSummary>;
};

const ADMIN_CSP = [
  "default-src 'none'",
  "style-src 'self'",
  "img-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
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
        <p class="eyebrow">Flow AI / operator console</p>
        <h1>Flow operations</h1>
        <p class="lede">A read-only view of what is moving, waiting, and needs attention.</p>
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
    <footer>Read only · refreshes every 30 seconds</footer>
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

export const registerAdminRoutes = (
  server: FastifyInstance,
  options: AdminRouteOptions,
): void => {
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

  server.get("/admin", { onRequest: authorize }, async (_request, reply) => {
    const summary = await options.getSummary();
    return reply.type("text/html; charset=utf-8").send(renderAdmin(summary));
  });

  server.get("/admin/styles.css", { onRequest: authorize }, async (_request, reply) =>
    reply.type("text/css; charset=utf-8").send(ADMIN_STYLES));

  server.get("/api/admin/summary", { onRequest: authorize }, async (_request, reply) =>
    reply.send(await options.getSummary()));
};
