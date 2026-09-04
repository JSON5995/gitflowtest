import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("real QA contract", () => {
  it("requires live API probes, mobile and desktop browser journeys, and design checks", () => {
    const config = JSON.parse(readFileSync("repo-kit/.flow/qa.json", "utf8")) as {
      baseUrl: string;
      apiProbes: unknown[];
      journeys: unknown[];
      viewports: Array<{ name: string }>;
      design: { allowedFonts: string[]; minInteractiveSize: number };
    };

    expect(config.baseUrl).toMatch(/^https?:\/\//);
    expect(config.apiProbes.length).toBeGreaterThan(0);
    expect(config.journeys.length).toBeGreaterThan(0);
    expect(config.viewports.map((viewport) => viewport.name)).toEqual(expect.arrayContaining(["mobile", "desktop"]));
    expect(config.design.allowedFonts.length).toBeGreaterThan(0);
    expect(config.design.minInteractiveSize).toBeGreaterThanOrEqual(24);
  });

  it("validates the trusted contract without launching a browser", () => {
    const result = spawnSync(process.execPath, [
      resolve("repo-kit/scripts/run-real-qa.mjs"),
      "--validate",
      "--config",
      resolve("repo-kit/.flow/qa.json"),
    ], { encoding: "utf8" });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("valid");
  });

  it("fails closed when a real endpoint probe is omitted", () => {
    const directory = mkdtempSync(join(tmpdir(), "gitflow-real-qa-"));
    cleanupPaths.push(directory);
    const configPath = join(directory, "qa.json");
    const config = JSON.parse(readFileSync("repo-kit/.flow/qa.json", "utf8")) as Record<string, unknown>;
    writeFileSync(configPath, JSON.stringify({ ...config, apiProbes: [] }));

    const result = spawnSync(process.execPath, [
      resolve("repo-kit/scripts/run-real-qa.mjs"), "--validate", "--config", configPath,
    ], { encoding: "utf8" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("apiProbes");
  });
});
