import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

describe("deployment package", () => {
  it("runs one non-root service with durable storage and health checks", () => {
    const dockerfile = readFileSync("Dockerfile", "utf8");
    const entrypoint = readFileSync("docker-entrypoint.sh", "utf8");
    const compose = parse(readFileSync("compose.yml", "utf8")) as {
      services: Record<string, Record<string, unknown>>;
      volumes: Record<string, unknown>;
    };
    const service = compose.services.flow!;

    expect(dockerfile).toContain("USER node");
    expect(dockerfile).toContain("ENTRYPOINT [\"/usr/local/bin/docker-entrypoint.sh\"]");
    expect(entrypoint).toContain("chown node:node /data");
    expect(entrypoint).toContain("exec gosu node");
    expect(dockerfile).toContain("HEALTHCHECK");
    expect(service).toMatchObject({ restart: "unless-stopped", init: true });
    expect(service).toHaveProperty("healthcheck");
    expect(service).not.toHaveProperty("privileged");
    expect(JSON.stringify(service.volumes)).toContain("flow-data:/data");
    expect(JSON.stringify(service.ports)).toContain("127.0.0.1");
    expect(compose.volumes).toHaveProperty("flow-data");
  });

  it("documents the full operator path and GitHub App permissions", () => {
    const readme = readFileSync("README.md", "utf8");

    expect(readme).toContain("flow-ai setup");
    expect(readme).toContain("flow-ai repo add OWNER/REPO");
    expect(readme).toContain("docker compose up -d --build");
    expect(readme).toContain("Workflow run");
    expect(readme).toContain("| Checks | Read and write |");
    expect(readme).toContain("human approval");
    expect(readme).toContain("One service handles many repositories");
    expect(readme).toContain("fly volumes create flow_data");
  });
});
