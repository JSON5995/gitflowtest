import { readFileSync, writeFileSync } from "node:fs";
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
    steps?: Array<{ name?: string; uses?: string; run?: string; env?: Record<string, unknown>; with?: Record<string, unknown> }>;
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
    const verify = value.jobs.verify!;
    const push = value.jobs.push!;
    const publishClarification = value.jobs.publish_clarification!;

    expect(Object.keys(value.on)).toEqual(["workflow_dispatch"]);
    expect(value.concurrency?.group).toContain("issue");
    expect(job["runs-on"]).toBe("ubuntu-latest");
    expect(job["timeout-minutes"]).toBeLessThanOrEqual(45);
    expect(job.permissions).toEqual({ contents: "read" });
    expect(push.permissions).toEqual({ contents: "write" });
    expect(job.steps?.some((step) => actionUses(step.uses, "openai/codex-action"))).toBe(true);
    expect(job.steps?.some((step) => actionUses(step.uses, "anthropics/claude-code-action"))).toBe(true);
    expect(job.steps?.map((step) => step.run ?? "").join("\n")).toContain("cursor-agent");
    const codex = job.steps?.find((step) => step.uses?.startsWith("openai/codex-action@"));
    expect(codex?.with?.["permission-profile"]).toBe(":workspace");
    expect(codex?.with?.["safety-strategy"]).toBe("drop-sudo");
    const claude = job.steps?.find((step) => step.uses?.startsWith("anthropics/claude-code-action@"));
    expect(String(claude?.with?.claude_args)).not.toContain("Bash(");
    expect(job.steps?.some((step) => step.uses?.startsWith("actions/create-github-app-token@"))).toBe(false);
    expect(JSON.stringify(job)).not.toContain("FLOW_GITHUB_APP_PRIVATE_KEY");
    expect(JSON.stringify(value)).toContain("Flow Build · Issue #");
    expect(JSON.stringify(value)).toContain("Validate route inputs before any AI action");
    expect(JSON.stringify(value.jobs.prepare)).toContain("^[A-Za-z0-9._:/-]{1,200}$");
    expect(job.steps?.map((step) => step.run ?? "").join("\n")).not.toContain("gh pr create");
    expect(job.steps?.map((step) => step.run ?? "").join("\n")).not.toMatch(/run-contract\.mjs" (?:install|checks)/);
    expect(verify.steps?.map((step) => step.run ?? "").join("\n")).toContain("run-contract.mjs\" guard");
    expect(verify.steps?.map((step) => step.run ?? "").join("\n")).toContain("run-contract.mjs\" checks");
    expect(verify.permissions).toEqual({ contents: "read" });
    expect(push.steps?.map((step) => step.run ?? "").join("\n")).not.toMatch(/npm|pnpm|yarn/);
    expect(JSON.stringify(push)).not.toContain("API_KEY");
    expect(publishClarification.permissions).toEqual({ contents: "read", issues: "write" });
    expect(JSON.stringify(job)).toContain(".flow-clarification.json");
    expect(JSON.stringify(job)).toContain("clarification.mjs");
    expect(JSON.stringify(publishClarification)).toContain("gh issue comment");
    expect(JSON.stringify(publishClarification)).toContain("flow:blocked");
    expect(JSON.stringify(job)).not.toContain('issues":"write');
    expect(Object.keys(value.on)).not.toContain("pull_request_target");
  });
});

describe("CI workflow", () => {
  it("runs the trusted repository contract as the ci check", () => {
    const value = workflow("flow-ci.yml");
    const job = value.jobs.ci!;
    const commands = job.steps?.map((step) => step.run ?? "").join("\n") ?? "";
    expect(value.on.workflow_dispatch).toMatchObject({ inputs: { pr_number: expect.any(Object) } });
    expect(value.on.workflow_dispatch).toMatchObject({ inputs: { head_sha: expect.any(Object) } });
    expect(JSON.stringify(value)).toContain("Flow CI · PR #");
    expect(job.name).toBe("ci");
    expect(job.permissions).toEqual({ contents: "read" });
    expect(commands).toContain("base-flow-config.json");
    expect(commands).toContain("run-contract.mjs\" checks");
  });
});

describe("review workflow", () => {
  it("runs an independently structured Claude review for each PR head", () => {
    const value = workflow("flow-review.yml");
    const job = value.jobs.review!;
    const collect = value.jobs.collect!;
    const publish = value.jobs.publish!;
    const trigger = value.on.workflow_dispatch as { inputs: Record<string, unknown> };

    expect(trigger.inputs).toHaveProperty("pr_number");
    expect(trigger.inputs).toHaveProperty("head_sha");
    expect(JSON.stringify(value)).toContain("AI Review · PR #");
    expect(JSON.stringify(value)).toContain("Validate route inputs before any AI action");
    expect(value.concurrency?.["cancel-in-progress"]).toBe(true);
    expect(value.concurrency?.group).toContain("pull_request");
    expect(job.permissions).toEqual({ contents: "read" });
    expect(publish.permissions).toMatchObject({ contents: "read", "pull-requests": "write" });
    expect(job.steps?.some((step) => actionUses(step.uses, "anthropics/claude-code-action"))).toBe(true);
    expect(job.steps?.some((step) => actionUses(step.uses, "openai/codex-action"))).toBe(true);
    const claude = job.steps?.find((step) => step.uses?.startsWith("anthropics/claude-code-action@"));
    expect(String(claude?.with?.claude_args)).toContain("--json-schema");
    const codex = job.steps?.find((step) => step.uses?.startsWith("openai/codex-action@"));
    expect(codex?.with?.["permission-profile"]).toBe(":read-only");
    expect(codex?.with?.["output-schema-file"]).toContain("flow-review-input/review-schema.json");
    const commands = job.steps?.map((step) => step.run ?? "").join("\n") ?? "";
    const collectCommands = collect.steps?.map((step) => step.run ?? "").join("\n") ?? "";
    expect(commands).toContain("cursor-agent");
    expect(commands).toContain("parse-cursor-result.mjs");
    expect(collectCommands).toContain("gh api");
    expect(collectCommands).toContain("^[A-Za-z0-9._:/-]{1,200}$");
    expect(commands).toContain("flow-review-input/check-review.mjs");
    expect(JSON.stringify(collect)).not.toContain("API_KEY");
    expect(JSON.stringify(job)).toContain("needs.collect.outputs.base_sha");
    expect(commands).toContain("$RUNNER_TEMP/flow-review-input/parse-cursor-result.mjs");
    expect(JSON.stringify(publish)).not.toContain("API_KEY");
    expect(publish.steps?.map((step) => step.run ?? "").join("\n")).toContain("gh pr comment");
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

  it("unwraps strict Cursor CLI JSON before applying the review gate", () => {
    const directory = mkdtempSync(join(tmpdir(), "gitflow-cursor-review-"));
    cleanupPaths.push(directory);
    const input = join(directory, "cursor.json");
    const output = join(directory, "review.json");
    writeFileSync(input, JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: JSON.stringify({ verdict: "pass", summary: "Safe.", findings: [] }),
    }));

    const result = spawnSync(process.execPath, [
      resolve("repo-kit/scripts/parse-cursor-result.mjs"), input, output,
    ], { encoding: "utf8" });

    expect(result.status).toBe(0);
    expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({ verdict: "pass" });
  });
});

describe("QA workflow", () => {
  it("runs real API and browser QA at mobile and desktop sizes, then visually reviews evidence", () => {
    const value = workflow("flow-qa.yml");
    const candidate = value.jobs.candidate!;
    const preview = value.jobs.preview!;
    const visual = value.jobs.visual!;
    const commands = Object.values(value.jobs).flatMap((job) => job.steps ?? []).map((step) => step.run ?? "").join("\n");

    expect(candidate.permissions).toMatchObject({ contents: "read", "pull-requests": "read" });
    expect(value.on.workflow_dispatch).toMatchObject({ inputs: { pr_number: expect.any(Object) } });
    expect(value.on.workflow_dispatch).toMatchObject({ inputs: { head_sha: expect.any(Object) } });
    expect(JSON.stringify(value)).toContain("Flow QA · PR #");
    expect(commands).toContain("gh api");
    expect(commands).toContain("base-flow-config.json");
    expect(commands).toContain("base-qa-config.json");
    expect(commands).toContain("run-contract.mjs");
    expect(commands).toContain("run-real-qa.mjs");
    expect(commands).toContain("@browserbasehq/stagehand@3.7.3");
    expect(commands).toContain("playwright@1.62.1");
    expect(commands).toContain("--prefix \"$RUNNER_TEMP/flow-qa-tools\"");
    expect(commands).toContain("install --with-deps chromium");
    expect(commands).toContain("healthUrl");
    expect(JSON.stringify(value)).toContain("Validate route inputs before any AI action");
    expect(commands).toContain("^[A-Za-z0-9._:/-]{1,200}$");
    expect(commands).toContain("/flow/run-contract.mjs start");
    expect(commands).toContain("docker run --rm");
    expect(commands).toContain(":/flow/run-contract.mjs:ro");
    expect(commands).toContain("$RUNNER_TEMP/flow-qa-evidence");
    expect(visual.steps?.some((step) => actionUses(step.uses, "anthropics/claude-code-action"))).toBe(true);
    expect(visual.steps?.some((step) => actionUses(step.uses, "openai/codex-action"))).toBe(true);
    expect(commands).toContain("cursor-agent");
    const local = candidate.steps?.find((step) => step.name === "Test the local application without credentials");
    expect(JSON.stringify(local)).not.toContain("API_KEY");
    expect(JSON.stringify(local)).not.toContain("PASSWORD");
    expect(JSON.stringify(candidate)).not.toContain("API_KEY");
    expect(JSON.stringify(preview)).toContain("FLOW_QA_PASSWORD");
    expect(JSON.stringify(preview)).toContain("needs.candidate.outputs.base_sha");
    expect(visual.steps?.some((step) => actionUses(step.uses, "actions/upload-artifact"))).toBe(true);
    expect(Object.keys(value.on)).not.toContain("pull_request_target");
  });
});
