import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createCredentialVault } from "../src/credential-vault.js";

describe("credential vault", () => {
  it("round-trips a credential without embedding plaintext in its envelope", () => {
    const vault = createCredentialVault(randomBytes(32));
    const plaintext = "sk-live-never-store-plaintext";

    const sealed = vault.seal(plaintext);

    expect(sealed).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(sealed).not.toContain(plaintext);
    expect(vault.open(sealed)).toBe(plaintext);
  });

  it("rejects tampered envelopes and the wrong encryption key", () => {
    const vault = createCredentialVault(randomBytes(32));
    const sealed = vault.seal("anthropic-secret");
    const parts = sealed.split(".");
    parts[2] = `${parts[2]?.startsWith("A") ? "B" : "A"}${parts[2]?.slice(1)}`;
    const tampered = parts.join(".");

    expect(() => vault.open(tampered)).toThrow(/credential/i);
    expect(() => createCredentialVault(randomBytes(32)).open(sealed)).toThrow(/credential/i);
  });

  it("requires exactly 256 bits of key material", () => {
    expect(() => createCredentialVault(randomBytes(31))).toThrow(/32 bytes/);
    expect(() => createCredentialVault(randomBytes(33))).toThrow(/32 bytes/);
  });
});
