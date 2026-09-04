import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { validEnv } from "./helpers.js";

describe("loadConfig", () => {
  it("allows Admin to configure one provider for every role after startup", () => {
    expect(() => loadConfig(validEnv({
      FLOW_BUILDER: "codex",
      FLOW_REVIEWER: "codex",
      OPENAI_API_KEY: undefined,
      ANTHROPIC_API_KEY: undefined,
    }))).not.toThrow();
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
    expect(() => loadConfig(validEnv({
      NODE_ENV: "production",
      PUBLIC_URL: "https://flow.example.com",
    }))).toThrow(/placeholder/);
    expect(() => loadConfig(validEnv({
      NODE_ENV: "development",
      PUBLIC_URL: "http://localhost:3000",
    }))).not.toThrow();
    expect(() => loadConfig(validEnv({
      NODE_ENV: "production",
      PUBLIC_URL: "https://user:secret@flow.example.test/path?token=secret",
    }))).toThrow(/bare public origin/);
  });

  it("starts without provider credentials so they can be connected in Admin", () => {
    const config = loadConfig(validEnv({
      OPENAI_API_KEY: undefined,
      ANTHROPIC_API_KEY: undefined,
      CURSOR_API_KEY: undefined,
    }));
    expect(config.providers).toEqual({});
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

  it("validates optional legacy CLI CODEOWNERS when provided", () => {
    expect(() => loadConfig(validEnv({ FLOW_CODEOWNERS: "platform-team" }))).toThrow(/FLOW_CODEOWNERS/);
    expect(loadConfig(validEnv({ FLOW_CODEOWNERS: undefined })).flow.codeowners).toEqual([]);
  });

  it("requires a strong admin console password", () => {
    expect(() => loadConfig(validEnv({ FLOW_ADMIN_PASSWORD: undefined }))).toThrow(/FLOW_ADMIN_PASSWORD/);
    expect(() => loadConfig(validEnv({ FLOW_ADMIN_PASSWORD: "short" }))).toThrow(/FLOW_ADMIN_PASSWORD/);
  });

  it("requires a 256-bit host credential-encryption key", () => {
    expect(() => loadConfig(validEnv({ FLOW_CREDENTIAL_KEY: undefined }))).toThrow(/FLOW_CREDENTIAL_KEY/);
    expect(() => loadConfig(validEnv({ FLOW_CREDENTIAL_KEY: Buffer.alloc(31).toString("base64url") })))
      .toThrow(/FLOW_CREDENTIAL_KEY/);
    expect(loadConfig(validEnv()).credentialKey).toHaveLength(32);
  });
});
