// ============================================================
// Service Account JWT authentication via Web Crypto API
// ============================================================

interface ServiceAccountInfo {
  client_email: string;
  private_key: string;
  project_id: string;
}

/** Cached tokens: SA email → { token, expiresAt } */
const tokenCache = new Map<
  string,
  { token: string; expiresAt: number }
>();

/**
 * Get an OAuth2 access token for a Service Account using JWT assertion.
 * Uses Web Crypto API for RSA-SHA256 signing (compatible with CF Workers).
 */
export async function getServiceAccountToken(
  sa: ServiceAccountInfo
): Promise<string> {
  // Check cache
  const cached = tokenCache.get(sa.client_email);
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.token;
  }

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: sa.client_email,
    sub: sa.client_email,
    aud: "https://oauth2.googleapis.com/token",
    scope: "https://www.googleapis.com/auth/cloud-platform",
    iat: now,
    exp: now + 3600,
  };

  // Base64url encode header and claims
  const headerB64 = base64urlEncode(JSON.stringify(header));
  const claimsB64 = base64urlEncode(JSON.stringify(claims));
  const signingInput = `${headerB64}.${claimsB64}`;

  // Import the private key and sign
  const privateKey = await importPrivateKey(sa.private_key);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(signingInput)
  );
  const signatureB64 = base64urlEncodeBuffer(signature);
  const jwt = `${signingInput}.${signatureB64}`;

  // Exchange JWT for access token
  const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  if (!tokenResp.ok) {
    const errText = await tokenResp.text();
    throw new Error(
      `Failed to get SA token for ${sa.client_email}: ${tokenResp.status} ${errText}`
    );
  }

  const tokenData = (await tokenResp.json()) as {
    access_token: string;
    expires_in: number;
  };

  // Cache the token
  tokenCache.set(sa.client_email, {
    token: tokenData.access_token,
    expiresAt: Date.now() + tokenData.expires_in * 1000,
  });

  return tokenData.access_token;
}

/**
 * Import a PEM-encoded RSA private key for use with Web Crypto API.
 */
async function importPrivateKey(pem: string): Promise<CryptoKey> {
  // Strip PEM headers and whitespace
  const pemBody = pem
    .replace(/-----BEGIN (?:RSA )?PRIVATE KEY-----/g, "")
    .replace(/-----END (?:RSA )?PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");

  const binaryDer = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));

  return crypto.subtle.importKey(
    "pkcs8",
    binaryDer.buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

function base64urlEncode(str: string): string {
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlEncodeBuffer(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
