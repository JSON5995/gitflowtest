import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

export type CredentialVault = {
  seal(plaintext: string): string;
  open(envelope: string): string;
};

const decodePart = (value: string): Buffer => {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid encrypted credential envelope");
  return Buffer.from(value, "base64url");
};

export const createCredentialVault = (key: Buffer): CredentialVault => {
  if (key.length !== 32) throw new Error("Credential encryption key must be exactly 32 bytes");
  const keyMaterial = Buffer.from(key);

  return {
    seal(plaintext) {
      if (!plaintext) throw new Error("Credential cannot be empty");
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", keyMaterial, iv);
      cipher.setAAD(Buffer.from(VERSION));
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      return [VERSION, iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
    },

    open(envelope) {
      try {
        const parts = envelope.split(".");
        if (parts.length !== 4 || parts[0] !== VERSION) throw new Error("unsupported envelope");
        const iv = decodePart(parts[1] ?? "");
        const tag = decodePart(parts[2] ?? "");
        const ciphertext = decodePart(parts[3] ?? "");
        if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES || ciphertext.length === 0) {
          throw new Error("invalid envelope lengths");
        }
        const decipher = createDecipheriv("aes-256-gcm", keyMaterial, iv);
        decipher.setAAD(Buffer.from(VERSION));
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
      } catch {
        throw new Error("Encrypted credential could not be authenticated");
      }
    },
  };
};
