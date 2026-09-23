#!/usr/bin/env node
/* global process */

import { writeFileSync } from "node:fs";

const allowedSeverities = new Set(["critical", "high", "medium", "low"]);
const blockingSeverities = new Set(["critical", "high", "medium"]);
const reviewPath = process.env.FLOW_REVIEW_PATH;
const raw = process.env.FLOW_REVIEW_JSON;

if (!reviewPath || !raw) {
  process.stderr.write("FLOW_REVIEW_PATH and FLOW_REVIEW_JSON are required\n");
  process.exit(2);
}

let review;
try {
  review = JSON.parse(raw);
} catch {
  process.stderr.write("Review output is not valid JSON\n");
  process.exit(2);
}

if (
  !["pass", "changes_required"].includes(review.verdict) ||
  typeof review.summary !== "string" ||
  !Array.isArray(review.findings) ||
  review.findings.some((finding) =>
    !allowedSeverities.has(finding?.severity) ||
    typeof finding.path !== "string" ||
    !Number.isInteger(finding.line) ||
    finding.line < 1 ||
    typeof finding.problem !== "string" ||
    typeof finding.recommendedFix !== "string"
  )
) {
  process.stderr.write("Review output does not match the required schema\n");
  process.exit(2);
}

const findingText = review.findings.length === 0
  ? "No blocking findings."
  : review.findings.map((finding) =>
      `- **${finding.severity.toUpperCase()}** \`${finding.path}:${finding.line}\` — ${finding.problem}\n  - Fix: ${finding.recommendedFix}`
    ).join("\n");

writeFileSync(reviewPath, `## Independent AI review\n\n${review.summary}\n\n${findingText}\n`);

const blocked =
  review.verdict === "changes_required" ||
  review.findings.some((finding) => blockingSeverities.has(finding.severity));
process.exit(blocked ? 1 : 0);
