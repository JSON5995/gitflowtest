import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import {
  formatClarificationAnswerComment,
  formatClarificationComment,
  parseClarificationAnswerComment,
  parseClarificationComment,
  sanitizeFlowComment,
} from "../src/clarification.js";
import { redactSecrets } from "../src/intake.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("clarification protocol", () => {
  it("round-trips a clearly marked machine-readable question", () => {
    const request = {
      version: 1 as const,
      id: "builder:123:17",
      source: "builder" as const,
      question: "Which account role should see the control?",
      context: "The acceptance criteria name two roles.",
    };

    const comment = formatClarificationComment(request);

    expect(comment).toContain("## Flow clarification needed");
    expect(comment).not.toContain("builder:123:17");
    expect(parseClarificationComment(comment)).toEqual(request);
  });

  it("ignores malformed or oversized markers", () => {
    expect(parseClarificationComment("ordinary comment")).toBeNull();
    expect(parseClarificationComment("<!-- flow-clarification:v1:not-base64 -->")).toBeNull();
  });

  it("redacts valid clarification and answer payloads without breaking their markers", () => {
    const secret = "github_pat_abcdefghijklmnopqrstuv";
    const clarification = sanitizeFlowComment(formatClarificationComment({
      version: 1,
      id: "builder:123:17",
      source: "builder",
      question: `Should we rotate ${secret}?`,
      context: `The screenshot contains ${secret}.`,
    }), redactSecrets);
    const answer = sanitizeFlowComment(formatClarificationAnswerComment({
      version: 1,
      id: "telegram:101",
      answer: `Use ${secret} for now.`,
    }), redactSecrets);

    expect(clarification).not.toContain(secret);
    expect(answer).not.toContain(secret);
    expect(parseClarificationComment(clarification)).toEqual({
      version: 1,
      id: "builder:123:17",
      source: "builder",
      question: "Should we rotate [REDACTED TOKEN]?",
      context: "The screenshot contains [REDACTED TOKEN].",
    });
    expect(parseClarificationAnswerComment(answer)).toEqual({
      version: 1,
      id: "telegram:101",
      answer: "Use [REDACTED TOKEN] for now.",
    });
  });

  it("removes malformed marker-shaped payloads instead of shielding them", () => {
    const secret = "github_pat_abcdefghijklmnopqrstuv";
    const encoded = Buffer.from(JSON.stringify({
      version: 1,
      id: "telegram:101",
      answer: secret,
      unexpected: true,
    })).toString("base64url");

    const sanitized = sanitizeFlowComment(
      `before <!-- flow-answer:v1:${encoded} --> after`,
      redactSecrets,
    );

    expect(sanitized).not.toContain(encoded);
    expect(sanitized).not.toContain(secret);
    expect(parseClarificationAnswerComment(sanitized)).toBeNull();
  });

  it("validates and renders the provider artifact with the trusted repository script", () => {
    const directory = mkdtempSync(join(tmpdir(), "flow-clarification-"));
    cleanup.push(directory);
    const input = join(directory, "input.json");
    const normalized = join(directory, "normalized.json");
    const comment = join(directory, "comment.md");
    writeFileSync(input, JSON.stringify({
      version: 1,
      question: "Should archived projects appear in search?",
      context: "The issue does not define archive visibility.",
    }));

    const validate = spawnSync(process.execPath, [
      resolve("repo-kit/scripts/clarification.mjs"),
      "validate",
      input,
      normalized,
    ], { encoding: "utf8" });
    const render = spawnSync(process.execPath, [
      resolve("repo-kit/scripts/clarification.mjs"),
      "render",
      normalized,
      comment,
      "builder:123:17",
    ], { encoding: "utf8" });

    expect(validate.status).toBe(0);
    expect(render.status).toBe(0);
    expect(readFileSync(comment, "utf8")).toContain("Should archived projects appear in search?");
  });
});
