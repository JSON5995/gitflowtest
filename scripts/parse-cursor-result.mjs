#!/usr/bin/env node
/* global process */

import { readFileSync, writeFileSync } from "node:fs";

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) {
  process.stderr.write("Usage: parse-cursor-result.mjs INPUT OUTPUT\n");
  process.exit(2);
}

try {
  const wrapper = JSON.parse(readFileSync(inputPath, "utf8"));
  if (wrapper.type !== "result" || wrapper.subtype !== "success" || wrapper.is_error !== false) {
    throw new Error("Cursor did not return a successful result");
  }
  const raw = String(wrapper.result ?? "").trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const review = JSON.parse(raw);
  writeFileSync(outputPath, `${JSON.stringify(review)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
}
