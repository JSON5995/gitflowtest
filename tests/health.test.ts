import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";

const servers: Array<ReturnType<typeof buildServer>> = [];
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("health endpoints", () => {
  it("redirects the root URL to the Admin interface", async () => {
    const server = buildServer({ isReady: () => true });
    servers.push(server);

    const response = await server.inject({ method: "GET", url: "/" });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("/admin");
  });

  it("reports the exact safe service identity without consulting dependencies", async () => {
    const server = buildServer({ isReady: () => false });
    servers.push(server);

    const response = await server.inject({ method: "GET", url: "/health/live" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toMatch(/^application\/json/);
    expect(response.json()).toEqual({ ok: true, service: "flow", version });
  });

  it("returns 503 when persistent storage is not ready", async () => {
    const server = buildServer({ isReady: () => false });
    servers.push(server);

    const response = await server.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ ok: false });
  });
});
