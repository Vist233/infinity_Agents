import type { Env } from "./env";

const PREFIX = "auth.v1";

export function isEncryptedAuthToken(value: string): boolean {
  return value.startsWith(`${PREFIX}.`);
}

function encode(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function decode(value: string): Uint8Array | null {
  try {
    const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(normalized + "=".repeat((4 - (normalized.length % 4)) % 4));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

async function key(env: Env): Promise<CryptoKey> {
  const raw = decode(String(env.AUTH_SESSION_ENCRYPTION_KEY ?? "").trim());
  if (!raw || raw.byteLength !== 32) throw new Error("AUTH_SESSION_ENCRYPTION_KEY must be a base64url-encoded 32-byte key");
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

function aad(sid: string, field: "access" | "refresh"): Uint8Array {
  return new TextEncoder().encode(`auth-session:${sid}:${field}`);
}

export async function encryptAuthToken(value: string, env: Env, sid: string, field: "access" | "refresh"): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad(sid, field) },
    await key(env),
    new TextEncoder().encode(value),
  );
  return `${PREFIX}.${encode(iv)}.${encode(new Uint8Array(ciphertext))}`;
}

export async function decryptAuthToken(value: string, env: Env, sid: string, field: "access" | "refresh"): Promise<string> {
  // Existing sessions are migrated lazily. New and refreshed sessions are
  // always encrypted; plaintext compatibility can be removed after their TTL.
  if (!isEncryptedAuthToken(value)) return value;
  const [, , ivText, ciphertextText] = value.split(".");
  const iv = decode(ivText ?? "");
  const ciphertext = decode(ciphertextText ?? "");
  if (!iv || iv.byteLength !== 12 || !ciphertext) throw new Error("Invalid encrypted auth token");
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv, additionalData: aad(sid, field) },
    await key(env),
    ciphertext,
  );
  return new TextDecoder().decode(plaintext);
}
