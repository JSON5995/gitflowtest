import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { parse } from "yaml";
import { afterEach, describe, expect, it } from "vitest";

type Workflow = {
  on: Record<string, { types?: string[] } | unknown>;
  concurrency?: { group?: string; "cancel-in-progress"?: boolean };
  jobs: Record<string, {
    name?: string;
    permissions?: Record<string, string>;
    "runs-on"?: string;
    "timeout-minutes"?: number;
    steps?: Array<{ uses?: string; run?: string; with?: Record<string, unknown> }>;
  }>;
};

const workflow = (name: string): Workflow =>
  parse(readFileSync(resolve("repo-kit/.github/workflows", name), "utf8")) as Workflow;

const actionUses = (value: string | undefined, repository: string): boolean =>
  Boolean(value?.startsWith(`${repository}@`) && /@[a-f0-9]{40}$/.test(value));

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("build workflow", () => {
  it("claims one ready issue and uses a sandboxed Codex builder", () => {
    const value = workflow("flow-build.yml");
    const job = value.jobs.build!;

    expect(Object.keys(value.on)).toEqual(expect.arrayContaining(["issues", "workflow_dispatch"]));
    expect(value.concurrency?.group).toContain("issue");
    expect(job["runs-on"]).toBe("ubuntu-latest");
    expect(job["timeout-minutes"]).toBeLessThanOrEqual(45);
    expect(job.permissions).toMatchObject({ contents: "write", issues: "write", "pull-requests": "write" });
    expect(job.steps?.some((step) => actionUses(step.uses, "openai/codex-action"))).toBe(true);
    const codex = job.steps?.find((step) => step.uses?.startsWith("openai/codex-action@"));
    expect(codex?.with?.["permission-profile"]).toBe(":workspace");
    expect(Object.keys(value.on)).not.toContain("pull_request_target");
  });
});

describe("review workflow", () => {
  it("runs an independently structured Claude review for each PR head", () => {
    const value = workflow("flow-review.yml");
    const job = value.jobs.review!;
    const trigger = value.on.pull_request as { types: string[] };

    expect(trigger.types).toEqual(expect.arrayContaining(["opened", "synchronize", "reopened", "ready_for_review"]));
    expect(value.concurrency?.["cancel-in-progress"]).toBe(true);
    expect(value.concurrency?.group).toContain("pull_request");
    expect(job.permissions).toMatchObject({ contents: "read", "pull-requests": "write" });
    expect(job.steps?.some((step) => actionUses(step.uses, "anthropics/claude-code-action"))).toBe(true);
    const claude = job.steps?.find((step) => step.uses?.startsWith("anthropics/claude-code-action@"));
    expect(String(claude?.with?.claude_args)).toContain("--json-schema");
    const commands = job.steps?.map((step) => step.run ?? "").join("\n") ?? "";
    expect(commands).toContain("github.event.pull_request.base.sha");
    expect(commands).toContain("base-check-review.mjs");
  });

  it("fails the review gate for a medium finding", () => {
    const directory = mkdtempSync(join(tmpdir(), "gitflow-review-"));
    cleanupPaths.push(directory);
    const output = join(directory, "review.md");
    const result = spawnSync(process.execPath, [resolve("repo-kit/scripts/check-review.mjs")], {
      encoding: "utf8",
      env: {
        ...process.env,
        FLOW_REVIEW_PATH: output,
        FLOW_REVIEW_JSON: JSON.stringify({
          verdict: "changes_required",
          summary: "One correctness problem.",
          findings: [{
            severity: "medium",
            path: "src/cart.ts",
            line: 12,
            problem: "Quantity can be negative.",
            recommendedFix: "Reject negative quantities.",
          }],
        }),
      },
    });

    expect(result.status).toBe(1);
    expect(readFileSync(output, "utf8")).toContain("Quantity can be negative.");
  });
});

describe("QA workflow", () => {
  it("executes the base commit contract and uploads evidence", () => {
    const value = workflow("flow-qa.yml");
    const job = value.jobs.qa!;
    const commands = job.steps?.map((step) => step.run ?? "").join("\n") ?? "";

    expect(job.permissions).toEqual({ contents: "read" });
    expect(commands).toContain("github.event.pull_request.base.sha");
    expect(commands).toContain("base-flow-config.json");
    expect(commands).toContain("run-contract.mjs");
    expect(commands).toContain("healthUrl");
    expect(commands).toContain("run-contract.mjs\" start");
    expect(job.steps?.some((step) => actionUses(step.uses, "actions/upload-artifact"))).toBe(true);
    expect(Object.keys(value.on)).not.toContain("pull_request_target");
  });
});
