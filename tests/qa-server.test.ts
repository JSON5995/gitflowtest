import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { buildQaServer } from "../src/qa-server.js";

const servers: Array<ReturnType<typeof buildQaServer>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("credential-free QA server", () => {
  it("serves every checked-in base QA probe without production credentials or redirects", async () => {
    const server = buildQaServer();
    servers.push(server);

    const qaContract = JSON.parse(await readFile(
      new URL("../.flow/qa.json", import.meta.url),
      "utf8",
    )) as {
      apiProbes: Array<{
        method?: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
        path: string;
        status: number;
      }>;
    };
    for (const probe of qaContract.apiProbes) {
      const response = await server.inject({ method: probe.method ?? "GET", url: probe.path });
      expect(response.statusCode).toBe(probe.status);
      expect(response.headers.location).toBeUndefined();
    }

    const live = await server.inject({ method: "GET", url: "/health/live" });
    const ready = await server.inject({ method: "GET", url: "/health/ready" });

    expect(live.statusCode).toBe(200);
    expect(live.json()).toEqual({ ok: true });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ ok: true });
  });
});
