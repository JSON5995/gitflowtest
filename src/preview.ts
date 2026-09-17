import Fastify, { type FastifyInstance } from "fastify";
import { DESIGN_TOKENS } from "./design.js";

export const PREVIEW_STAGES = [
  { name: "Intake", label: "01", detail: "Feedback arrives from Telegram with text, screenshots, voice notes, or screen recordings." },
  { name: "Plan", label: "02", detail: "The request becomes a structured GitHub issue with acceptance criteria and clarifications." },
  { name: "Build", label: "03", detail: "The selected coding agent works on an isolated branch and opens a traceable pull request." },
  { name: "Review", label: "04", detail: "A separate AI reviews the implementation, security, and maintainability before approval." },
  { name: "Real QA", label: "05", detail: "Live endpoints and the deployed interface are exercised on desktop and mobile viewports." },
  { name: "Human Approval", label: "06", detail: "Evidence, checks, and a working preview are ready for the final human decision." },
] as const;

export const PREVIEW_STYLES = `${DESIGN_TOKENS}
html { min-width: 320px; background: var(--fog); }
body { margin: 0; overflow-x: hidden; background: var(--fog); }
.shell { width: min(1240px, calc(100% - 48px)); margin: 0 auto; padding: 64px 0 36px; }
.masthead { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(240px, .6fr); align-items: end; gap: 48px; padding-bottom: 44px; border-bottom: 1px solid var(--line); }
.eyebrow, .kicker { margin: 0 0 10px; color: var(--blue); font-family: ui-monospace, "SFMono-Regular", Consolas, monospace; font-size: 11px; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }
h1, h2 { margin: 0; font-family: "Arial Narrow", "Avenir Next Condensed", "Segoe UI", sans-serif; letter-spacing: -.035em; }
h1 { max-width: 780px; font-size: clamp(48px, 7.5vw, 92px); font-weight: 800; line-height: .9; }
.lede { max-width: 500px; margin: 0; color: var(--muted); font-size: clamp(16px, 1.7vw, 20px); line-height: 1.55; }
.status { display: inline-flex; align-items: center; gap: 10px; margin-top: 24px; padding: 9px 12px; border: 1px solid #bad9cf; border-radius: 999px; background: var(--green-soft); color: var(--green); font-size: 12px; font-weight: 750; }
.status::before { width: 8px; height: 8px; border-radius: 50%; background: var(--green); content: ""; box-shadow: 0 0 0 4px rgba(17, 112, 91, .12); }
.lifecycle { padding: 44px 0 36px; }
.section-heading { display: flex; align-items: end; justify-content: space-between; gap: 20px; margin-bottom: 22px; }
.section-heading p { max-width: 540px; margin: 0; color: var(--muted); font-size: 14px; line-height: 1.5; }
.stage-list { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); margin: 0; padding: 0; overflow: hidden; border: 1px solid var(--line); border-radius: var(--radius); background: var(--paper); box-shadow: 0 14px 45px rgba(30, 45, 55, .06); list-style: none; }
.stage { position: relative; min-width: 0; min-height: 270px; padding: 24px 18px 20px; border-right: 1px solid var(--line); }
.stage:last-child { border-right: 0; }
.stage::before { position: absolute; top: 0; right: 0; left: 0; height: 4px; background: var(--blue); content: ""; }
.stage:last-child::before { background: var(--amber); }
.stage-number { display: block; margin-bottom: 70px; color: var(--muted); font-family: ui-monospace, "SFMono-Regular", Consolas, monospace; font-size: 11px; font-weight: 750; }
.stage h2 { margin-bottom: 12px; font-size: clamp(20px, 1.7vw, 27px); line-height: 1; }
.stage p { margin: 0; color: var(--muted); font-size: 13px; line-height: 1.48; }
.proof { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1px; overflow: hidden; border: 1px solid var(--ink); border-radius: var(--radius); background: var(--ink); color: white; }
.proof article { min-width: 0; padding: 23px; background: var(--ink); }
.proof strong { display: block; margin-bottom: 8px; font-size: 15px; }
.proof p { margin: 0; color: #b9c5cc; font-size: 13px; line-height: 1.5; }
footer { display: flex; justify-content: space-between; gap: 20px; padding-top: 30px; color: var(--muted); font-family: ui-monospace, "SFMono-Regular", Consolas, monospace; font-size: 10px; letter-spacing: .04em; text-transform: uppercase; }
@media (max-width: 980px) {
  .masthead { grid-template-columns: 1fr; gap: 24px; }
  .stage-list { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .stage { min-height: 235px; border-bottom: 1px solid var(--line); }
  .stage:nth-child(3) { border-right: 0; }
  .stage:nth-child(n + 4) { border-bottom: 0; }
  .stage-number { margin-bottom: 44px; }
}
@media (max-width: 760px) {
  .shell { width: min(100% - 28px, 640px); padding-top: 36px; }
  .masthead { padding-bottom: 30px; }
  h1 { font-size: clamp(44px, 15vw, 68px); }
  .section-heading { display: grid; align-items: start; }
  .stage-list { grid-template-columns: 1fr; }
  .stage { display: grid; grid-template-columns: 48px minmax(0, 1fr); min-height: 0; gap: 4px 12px; padding: 22px 18px; border-right: 0; border-bottom: 1px solid var(--line); }
  .stage:nth-child(3), .stage:nth-child(n + 4) { border-bottom: 1px solid var(--line); }
  .stage:last-child { border-bottom: 0; }
  .stage-number { grid-row: 1 / 3; margin: 2px 0 0; }
  .stage h2 { margin-bottom: 6px; }
  .proof { grid-template-columns: 1fr; }
  footer { display: grid; }
}
`;

const renderPreview = (): string => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="A safe, read-only preview of the Flow autonomous software delivery lifecycle.">
  <title>Flow — Delivery lifecycle preview</title>
  <link rel="stylesheet" href="/preview/styles.css">
</head>
<body>
  <div class="shell">
    <header class="masthead">
      <div>
        <p class="eyebrow">Flow / public preview</p>
        <h1>From feedback to tested code.</h1>
        <span class="status">Preview service healthy</span>
      </div>
      <p class="lede">A read-only view of the delivery system that turns a business request into a reviewed pull request, a working demo, and evidence for human approval.</p>
    </header>
    <main>
      <section class="lifecycle" aria-labelledby="lifecycle-heading">
        <div class="section-heading">
          <div><p class="kicker">Autonomous delivery loop</p><h2 id="lifecycle-heading">One request. Six accountable stages.</h2></div>
          <p>Every stage leaves a record in GitHub. Production credentials and integrations are intentionally disabled in this preview.</p>
        </div>
        <ol class="stage-list">
          ${PREVIEW_STAGES.map((stage) => `<li class="stage"><span class="stage-number">${stage.label}</span><div><h2>${stage.name}</h2><p>${stage.detail}</p></div></li>`).join("")}
        </ol>
      </section>
      <section class="proof" aria-labelledby="proof-heading">
        <article><strong id="proof-heading">Functional proof</strong><p>Real health checks, live routes, and acceptance journeys run against the deployed service.</p></article>
        <article><strong>Visual proof</strong><p>Desktop and mobile captures check layout, typography, overflow, and design-language consistency.</p></article>
        <article><strong>Human control</strong><p>The final merge stays protected until a person reviews the implementation and its evidence.</p></article>
      </section>
    </main>
    <footer><span>Flow preview mode</span><span>No secrets · no mutations · no webhooks</span></footer>
  </div>
</body>
</html>`;

const setSecurityHeaders = (reply: { header(name: string, value: string): unknown }): void => {
  reply.header("Content-Security-Policy", "default-src 'none'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  reply.header("Referrer-Policy", "no-referrer");
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("X-Frame-Options", "DENY");
};

export const buildPreviewServer = (): FastifyInstance => {
  const server = Fastify({ logger: false });
  server.addHook("onSend", async (_request, reply) => setSecurityHeaders(reply));
  server.get("/", async (_request, reply) => reply.type("text/html; charset=utf-8").send(renderPreview()));
  server.get("/preview/styles.css", async (_request, reply) => reply.type("text/css; charset=utf-8").send(PREVIEW_STYLES));
  server.get("/health/live", async () => ({ ok: true }));
  server.get("/health/ready", async () => ({ ok: true }));
  return server;
};
