import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { validEnv } from "./helpers.js";

describe("loadConfig", () => {
  it("rejects identical builder and reviewer providers", () => {
    expect(() =>
      loadConfig(validEnv({ FLOW_BUILDER: "codex", FLOW_REVIEWER: "codex" })),
    ).toThrow(/must differ/);
  });

  it("requires an HTTPS public URL outside tests", () => {
    expect(() =>
      loadConfig(validEnv({ NODE_ENV: "production", PUBLIC_URL: "http://example.com" })),
    ).toThrow(/HTTPS/);
  });

  it("requires a Cursor key when Cursor is selected", () => {
    expect(() =>
      loadConfig(validEnv({ FLOW_BUILDER: "cursor", CURSOR_API_KEY: undefined })),
    ).toThrow(/CURSOR_API_KEY/);
  });

  it("parses limits and Telegram administrator IDs", () => {
    const config = loadConfig(validEnv());

    expect(config.telegram.adminIds).toEqual(["123", "456"]);
    expect(config.flow).toMatchObject({
      builder: "codex",
      reviewer: "claude",
      maxIssueCostUsd: 25,
      maxFixRounds: 2,
    });
  });
});
