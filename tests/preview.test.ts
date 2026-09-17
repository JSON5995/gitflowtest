import { afterEach, describe, expect, it } from "vitest";
import { DESIGN_TOKENS } from "../src/design.js";
import { buildPreviewServer, PREVIEW_STAGES, PREVIEW_STYLES } from "../src/preview.js";

const servers: Array<ReturnType<typeof buildPreviewServer>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("preview mode", () => {
  it("serves a healthy read-only lifecycle without integration routes", async () => {
    const server = buildPreviewServer();
    servers.push(server);

    const page = await server.inject({ method: "GET", url: "/" });
    const ready = await server.inject({ method: "GET", url: "/health/ready" });
    const stylesheet = await server.inject({ method: "GET", url: "/preview/styles.css" });

    expect(page.statusCode).toBe(200);
    expect(page.headers["content-type"]).toContain("text/html");
    expect(page.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ ok: true });
    expect(stylesheet.statusCode).toBe(200);
    expect(stylesheet.body).toContain("--blue: #165dcc");

    let previousStage = -1;
    for (const stage of PREVIEW_STAGES) {
      const position = page.body.indexOf(`<h2>${stage.name}</h2>`);
      expect(position).toBeGreaterThan(previousStage);
      previousStage = position;
    }

    for (const [method, url] of [
      ["GET", "/admin"],
      ["GET", "/api/admin/summary"],
      ["POST", "/webhooks/telegram"],
      ["POST", "/webhooks/github"],
      ["POST", "/admin/providers/codex"],
    ] as const) {
      expect((await server.inject({ method, url })).statusCode).toBe(404);
    }
  });

  it("contains semantic static content with no mutation controls or scripts", async () => {
    const server = buildPreviewServer();
    servers.push(server);
    const html = (await server.inject({ method: "GET", url: "/" })).body;

    expect(html).toContain('<html lang="en">');
    expect(html).toContain("<header");
    expect(html).toContain("<main");
    expect(html).toContain("<ol");
    expect(html).toContain("<footer");
    expect(html).toContain("aria-labelledby");
    expect(html).not.toMatch(/<(?:a|button|form|input|select|textarea)\b/i);
    expect(html).not.toMatch(/<script\b/i);
  });

  it("reuses design tokens and defines overflow-safe mobile and desktop layouts", () => {
    expect(DESIGN_TOKENS).toContain('font-family: "Avenir Next", "Segoe UI", sans-serif');
    expect(PREVIEW_STYLES).toContain("grid-template-columns: repeat(6, minmax(0, 1fr))");
    expect(PREVIEW_STYLES).toContain("@media (max-width: 760px)");
    expect(PREVIEW_STYLES).toContain("min-width: 0");
    expect(PREVIEW_STYLES).toContain("overflow-x: hidden");
    expect(PREVIEW_STYLES).not.toMatch(/(?:^|[;{])\s*width:\s*[4-9]\d{2,}px/m);
  });
});
