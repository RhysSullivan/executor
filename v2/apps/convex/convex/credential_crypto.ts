const encryptedPrefix = "enc:v1:";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
};

const base64ToBytes = (base64: string): Uint8Array => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

const resolveEncryptionPassphrase = (): string => {
  const passphrase = process.env.CREDENTIAL_ENCRYPTION_KEY?.trim() ?? "";
  if (passphrase.length === 0) {
    throw new Error("Encrypted credential storage requires CREDENTIAL_ENCRYPTION_KEY");
  }

  return passphrase;
};

const deriveAesKey = async (): Promise<CryptoKey> => {
  const passphraseBytes = encoder.encode(resolveEncryptionPassphrase());
  const hashBuffer = await crypto.subtle.digest("SHA-256", passphraseBytes);
  return await crypto.subtle.importKey(
    "raw",
    hashBuffer,
    {
      name: "AES-GCM",
    },
    false,
    ["encrypt", "decrypt"],
  );
};

const parseEncryptedValue = (value: string): { iv: Uint8Array; cipher: Uint8Array } | null => {
  if (!value.startsWith(encryptedPrefix)) {
    return null;
  }

  const payload = value.slice(encryptedPrefix.length);
  const parts = payload.split(":");
  if (parts.length !== 2) {
    return null;
  }

  try {
    return {
      iv: base64ToBytes(parts[0] ?? ""),
      cipher: base64ToBytes(parts[1] ?? ""),
    };
  } catch {
    return null;
  }
};

export const isEncryptedSecret = (value: string): boolean =>
  value.startsWith(encryptedPrefix);

export const encryptSecretValue = async (plainText: string): Promise<string> => {
  const key = await deriveAesKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
    },
    key,
    encoder.encode(plainText),
  );

  return `${encryptedPrefix}${bytesToBase64(iv)}:${bytesToBase64(new Uint8Array(encrypted))}`;
};

export const decryptSecretValue = async (storedValue: string): Promise<string> => {
  const parsed = parseEncryptedValue(storedValue);
  if (parsed === null) {
    throw new Error("Credential secret is not encrypted");
  }

  const key = await deriveAesKey();
  const decrypted = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: parsed.iv as unknown as BufferSource,
    },
    key,
    parsed.cipher as unknown as BufferSource,
  );

  return decoder.decode(decrypted);
};
