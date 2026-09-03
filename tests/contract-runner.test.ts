import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const cleanupPaths: string[] = [];
const runner = resolve("repo-kit/scripts/run-contract.mjs");

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const runContract = (config: unknown, target: "install" | "checks" | "qa" | "start") => {
  const directory = mkdtempSync(join(tmpdir(), "gitflow-contract-"));
  cleanupPaths.push(directory);
  const path = join(directory, "config.json");
  writeFileSync(path, JSON.stringify(config));
  return spawnSync(process.execPath, [runner, target, "--config", path], {
    cwd: directory,
    encoding: "utf8",
  });
};

const validConfig = (overrides: Record<string, unknown> = {}) => ({
  version: 1,
  install: ["node", "-e", "process.stdout.write('installed')"],
  checks: [["node", "-e", "process.stdout.write(process.argv[1])", "$HOME;echo hacked"]],
  qa: [["node", "-e", "process.exit(0)"]],
  start: ["node", "-e", "setInterval(() => {}, 1000)"],
  healthUrl: "http://127.0.0.1:3000/health",
  maxParallelBuilds: 2,
  protectedPaths: [".github/workflows/", ".flow/"],
  ...overrides,
});

describe("repository contract runner", () => {
  it("passes metacharacters and environment references literally", () => {
    const result = runContract(validConfig(), "checks");

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("$HOME;echo hacked");
  });

  it("rejects shell-string commands", () => {
    const result = runContract(validConfig({ checks: ["npm test"] }), "checks");

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("command arrays");
  });

  it("rejects empty commands", () => {
    const result = runContract(validConfig({ checks: [[]] }), "checks");

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("non-empty");
  });

  it("returns the first failing command exit code", () => {
    const result = runContract(validConfig({
      checks: [
        ["node", "-e", "process.exit(7)"],
        ["node", "-e", "process.exit(0)"],
      ],
    }), "checks");

    expect(result.status).toBe(7);
  });
});
