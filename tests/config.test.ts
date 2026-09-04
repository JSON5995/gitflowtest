import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { validEnv } from "./helpers.js";

describe("loadConfig", () => {
  it("rejects identical builder and reviewer providers", () => {
    expect(() =>
      loadConfig(validEnv({ FLOW_BUILDER: "codex", FLOW_REVIEWER: "codex" })),
    ).toThrow(/must differ/);
  });

  it("allows one explicitly selected agent to own every AI role", () => {
    const config = loadConfig(validEnv({
      FLOW_AGENT: "codex",
      FLOW_BUILDER: undefined,
      FLOW_REVIEWER: undefined,
    }));

    expect(config.flow).toMatchObject({ builder: "codex", reviewer: "codex", qa: "codex" });
  });

  it("does not require an unused Anthropic credential in single-Codex mode", () => {
    expect(() => loadConfig(validEnv({
      FLOW_AGENT: "codex",
      FLOW_BUILDER: undefined,
      FLOW_REVIEWER: undefined,
      ANTHROPIC_API_KEY: undefined,
    }))).not.toThrow();
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

  it("allows Cursor to review when its headless CLI credential is present", () => {
    const config = loadConfig(validEnv({
      FLOW_AGENT: "cursor",
      FLOW_BUILDER: undefined,
      FLOW_REVIEWER: undefined,
      CURSOR_API_KEY: "cursor-key",
    }));

    expect(config.flow).toMatchObject({ builder: "cursor", reviewer: "cursor", qa: "cursor" });
  });

  it("parses limits and Telegram administrator IDs", () => {
    const config = loadConfig(validEnv());

    expect(config.telegram.adminIds).toEqual(["123", "456"]);
    expect(config.flow).toMatchObject({
      builder: "codex",
      reviewer: "claude",
      codeowners: ["@acme/platform", "@release-owner"],
      maxFixRounds: 2,
    });
  });

  it("requires explicit GitHub users or teams for human approval", () => {
    expect(() => loadConfig(validEnv({ FLOW_CODEOWNERS: "platform-team" }))).toThrow(/FLOW_CODEOWNERS/);
  });

  it("requires a strong admin console password", () => {
    expect(() => loadConfig(validEnv({ FLOW_ADMIN_PASSWORD: undefined }))).toThrow(/FLOW_ADMIN_PASSWORD/);
    expect(() => loadConfig(validEnv({ FLOW_ADMIN_PASSWORD: "short" }))).toThrow(/FLOW_ADMIN_PASSWORD/);
  });
});
