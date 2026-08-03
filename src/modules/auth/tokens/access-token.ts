import { decodeBase64Url, encodeBase64Url } from "../shared/encoding";
import type { AuthApplication } from "../core/context";

export type { AuthApplication } from "../core/context";

const audiences: Record<AuthApplication, string> = {
  CUSTOMER_APP: "customer-app",
  DRIVER_APP: "driver-app",
  DASHBOARD: "dashboard",
};

export const DASHBOARD_ROLE_CODES = [
  "SUPER_ADMIN",
  "ADMIN",
  "OPERATIONS",
  "ACCOUNTANT",
  "SUPPORT",
] as const;

export type DashboardRoleCode = (typeof DASHBOARD_ROLE_CODES)[number];
const dashboardRoleSet = new Set<string>(DASHBOARD_ROLE_CODES);

export interface AccessTokenClaims {
  accountId: string;
  sessionId: string;
  applicationType: AuthApplication;
  roles: string[];
}

export interface VerifiedAccessToken extends AccessTokenClaims {
  tokenId: string;
  expiresAt: number;
}

const isDashboardRoleCode = (value: unknown): value is DashboardRoleCode =>
  typeof value === "string" && dashboardRoleSet.has(value);

const parseRolesClaim = (
  value: unknown,
  applicationType: AuthApplication,
): string[] => {
  if (applicationType !== "DASHBOARD") return [];
  if (!Array.isArray(value)) throw new Error("INVALID_TOKEN");
  if (!value.every(isDashboardRoleCode)) throw new Error("INVALID_TOKEN");
  return [...value];
};

export class Ed25519AccessTokenService {
  private privateKey: Promise<CryptoKey>;
  private publicKey: Promise<CryptoKey>;

  constructor(
    private config: {
      issuer: string;
      keyId: string;
      privateKeyBase64: string;
      publicKeyBase64: string;
      lifetimeSeconds: number;
    },
  ) {
    this.privateKey = crypto.subtle.importKey(
      "pkcs8",
      Uint8Array.fromBase64(config.privateKeyBase64),
      "Ed25519",
      false,
      ["sign"],
    );
    this.publicKey = crypto.subtle.importKey(
      "spki",
      Uint8Array.fromBase64(config.publicKeyBase64),
      "Ed25519",
      false,
      ["verify"],
    );
  }

  async sign(
    input: AccessTokenClaims,
    now = Math.floor(Date.now() / 1000),
  ): Promise<{ token: string; expiresAt: number }> {
    const expiresAt = now + this.config.lifetimeSeconds;
    const roles =
      input.applicationType === "DASHBOARD"
        ? input.roles.filter(isDashboardRoleCode)
        : [];
    const header = encodeBase64Url(
      JSON.stringify({ alg: "EdDSA", typ: "JWT", kid: this.config.keyId }),
    );
    const payload = encodeBase64Url(
      JSON.stringify({
        iss: this.config.issuer,
        aud: audiences[input.applicationType],
        sub: input.accountId,
        sid: input.sessionId,
        app: input.applicationType,
        roles,
        iat: now,
        exp: expiresAt,
        jti: crypto.randomUUID(),
      }),
    );
    const data = `${header}.${payload}`;
    const signature = await crypto.subtle.sign(
      "Ed25519",
      await this.privateKey,
      new TextEncoder().encode(data),
    );
    return {
      token: `${data}.${encodeBase64Url(new Uint8Array(signature))}`,
      expiresAt,
    };
  }

  async verify(
    token: string,
    expectedApplication: AuthApplication,
    now = Math.floor(Date.now() / 1000),
  ): Promise<VerifiedAccessToken> {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("INVALID_TOKEN");
    const [rawHeader, rawPayload, rawSignature] = parts as [
      string,
      string,
      string,
    ];
    const header = JSON.parse(
      new TextDecoder().decode(decodeBase64Url(rawHeader)),
    ) as Record<string, unknown>;
    if (
      header.alg !== "EdDSA" ||
      header.typ !== "JWT" ||
      header.kid !== this.config.keyId
    )
      throw new Error("INVALID_TOKEN");
    if (
      !(await crypto.subtle.verify(
        "Ed25519",
        await this.publicKey,
        decodeBase64Url(rawSignature).buffer as ArrayBuffer,
        new TextEncoder().encode(`${rawHeader}.${rawPayload}`),
      ))
    )
      throw new Error("INVALID_TOKEN");
    const p = JSON.parse(
      new TextDecoder().decode(decodeBase64Url(rawPayload)),
    ) as Record<string, unknown>;
    if (p.aud !== audiences[expectedApplication]) throw new Error("INVALID_TOKEN");
    if (
      p.iss !== this.config.issuer ||
      p.app !== expectedApplication ||
      typeof p.exp !== "number" ||
      p.exp <= now ||
      typeof p.iat !== "number" ||
      p.iat > now + 30 ||
      p.exp - p.iat !== this.config.lifetimeSeconds ||
      typeof p.sub !== "string" ||
      typeof p.sid !== "string" ||
      typeof p.jti !== "string"
    )
      throw new Error("INVALID_TOKEN");
    const roles = parseRolesClaim(p.roles, expectedApplication);
    return {
      accountId: p.sub,
      sessionId: p.sid,
      applicationType: expectedApplication,
      roles,
      tokenId: p.jti,
      expiresAt: p.exp,
    };
  }
}
