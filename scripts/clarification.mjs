/* global Buffer, console, process */

import { readFileSync, writeFileSync } from "node:fs";

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

const readArtifact = (path) => {
  let value;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail("Clarification artifact must be valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("Clarification artifact must be an object");
  const keys = Object.keys(value);
  if (keys.some((key) => !["version", "question", "context"].includes(key))) fail("Clarification artifact has unknown fields");
  if (value.version !== 1) fail("Clarification artifact version must be 1");
  if (typeof value.question !== "string" || value.question.trim().length < 3 || value.question.trim().length > 1000) {
    fail("Clarification question must contain 3-1000 characters");
  }
  if (value.context !== undefined && (
    typeof value.context !== "string"
    || value.context.trim().length < 1
    || value.context.trim().length > 2000
  )) fail("Clarification context must contain 1-2000 characters");
  return {
    version: 1,
    question: value.question.trim(),
    ...(value.context === undefined ? {} : { context: value.context.trim() }),
  };
};

const escapeHtml = (value) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const [command, inputPath, outputPath, requestId] = process.argv.slice(2);
if (!command || !inputPath || !outputPath) fail("Usage: clarification.mjs <validate|render> <input> <output> [request-id]");
const artifact = readArtifact(inputPath);

if (command === "validate") {
  writeFileSync(outputPath, `${JSON.stringify(artifact)}\n`, { mode: 0o600 });
} else if (command === "render") {
  if (!requestId || requestId.length > 200) fail("A request id of at most 200 characters is required");
  const request = { ...artifact, id: requestId, source: "builder" };
  const marker = Buffer.from(JSON.stringify(request), "utf8").toString("base64url");
  const context = artifact.context ? `\n\nContext: ${escapeHtml(artifact.context)}` : "";
  const body = `## Flow clarification needed\n\n${escapeHtml(artifact.question)}${context}\n\nReply in this issue as a collaborator with write access, or use \`/answer ISSUE_NUMBER your answer\` in the connected Telegram topic.\n\n<!-- flow-clarification:v1:${marker} -->\n`;
  writeFileSync(outputPath, body, { mode: 0o600 });
} else {
  fail("Unknown clarification command");
}
