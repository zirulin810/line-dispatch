// 簽章驗證（LINE 與 GitHub 都是 HMAC-SHA256，只是編碼不同）

const encoder = new TextEncoder();

async function hmacSha256(secret, body) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(body)));
}

function toBase64(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function toHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// 長度相同時逐字比對、不提早結束，避免用回應時間猜出正確簽章
function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** LINE：x-line-signature = base64(HMAC-SHA256(channel secret, body)) */
export async function verifyLineSignature(secret, body, signature) {
  if (!secret || !signature) return false;
  return timingSafeEqual(toBase64(await hmacSha256(secret, body)), signature);
}

/** GitHub：x-hub-signature-256 = "sha256=" + hex(HMAC-SHA256(webhook secret, body)) */
export async function verifyGithubSignature(secret, body, signature) {
  if (!secret || !signature) return false;
  return timingSafeEqual("sha256=" + toHex(await hmacSha256(secret, body)), signature);
}

// 測試用：產生簽章
export async function signLine(secret, body) {
  return toBase64(await hmacSha256(secret, body));
}
export async function signGithub(secret, body) {
  return "sha256=" + toHex(await hmacSha256(secret, body));
}
