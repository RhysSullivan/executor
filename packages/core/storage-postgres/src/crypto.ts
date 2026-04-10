import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

/**
 * Derive a 32-byte key from the provided encryption key string.
 * Uses SHA-256 to normalize any length input to exactly 32 bytes.
 */
const deriveKey = (key: string): Buffer => {
  return createHash("sha256").update(key).digest();
};

export const encrypt = (
  plaintext: string,
  encryptionKey: string,
): { encrypted: Buffer; iv: Buffer } => {
  const key = deriveKey(encryptionKey);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return { encrypted, iv };
};

export const decrypt = (encrypted: Buffer, iv: Buffer, encryptionKey: string): string => {
  const key = deriveKey(encryptionKey);
  const authTag = encrypted.subarray(encrypted.length - AUTH_TAG_LENGTH);
  const ciphertext = encrypted.subarray(0, encrypted.length - AUTH_TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);
  return decipher.update(ciphertext) + decipher.final("utf8");
};
