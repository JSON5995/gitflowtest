import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";

const servers: Array<ReturnType<typeof buildServer>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("health endpoints", () => {
  it("redirects the root URL to the Admin interface", async () => {
    const server = buildServer({ isReady: () => true, admin: {} as never });
    servers.push(server);

    const response = await server.inject({ method: "GET", url: "/" });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("/admin");
  });

  it("reports liveness without consulting dependencies", async () => {
    const server = buildServer({ isReady: () => false });
    servers.push(server);

    const response = await server.inject({ method: "GET", url: "/health/live" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
  });

  it("returns 503 when persistent storage is not ready", async () => {
    const server = buildServer({ isReady: () => false });
    servers.push(server);

    const response = await server.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ ok: false });
  });
});
