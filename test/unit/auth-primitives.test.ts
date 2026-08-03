import { describe, expect, test } from "bun:test";
import { generateOtp } from "../../src/modules/auth/phone/otp";
import { InMemoryRateLimiter, rateLimitKey } from "../../src/modules/auth/rate-limit/rate-limiter";
import { normalizeEmail, normalizePhone } from "../../src/modules/auth/shared/normalization";
import { randomOpaqueToken } from "../../src/modules/auth/shared/encoding";
import { HmacSecretVerifier } from "../../src/modules/auth/shared/secret-verifier";
import { Argon2PasswordHasher } from "../../src/modules/auth/staff/password";
import { Ed25519AccessTokenService } from "../../src/modules/auth/tokens/access-token";
import { redact } from "../../src/shared/redaction/redact";

const privateKey = "MC4CAQAwBQYDK2VwBCIEIOhYjslG5wawzghWHcQbYCMjFp8kzMYLVFZoKEOBzTA4";
const publicKey = "MCowBQYDK2VwAyEA+ly2CeP4N1AQ5vNUEt226L6GtOMU/uLE2rjFfo4OBCE=";

describe("M2 security primitives", () => {
  test("normalizes E.164 phones and emails", () => {
    expect(normalizePhone("+964 770 000 0000")).toBe("+9647700000000");
    expect(() => normalizePhone("07700000000")).toThrow();
    expect(normalizeEmail(" Staff@Example.COM ")).toBe("staff@example.com");
  });
  test("generates secure six digit OTPs and 256-bit refresh tokens", () => {
    for (let index=0; index<100; index++) expect(generateOtp()).toMatch(/^\d{6}$/);
    expect(Buffer.from(randomOpaqueToken(32), "base64url").byteLength).toBe(32);
  });
  test("creates versioned constant-time HMAC verifiers", async () => {
    const verifier = new HmacSecretVerifier("v7", "a-secret-key-with-at-least-thirty-two-characters");
    const stored = await verifier.create("secret-value");
    expect(verifier.keyVersion).toBe("v7");
    expect(await verifier.verify("secret-value", stored)).toBeTrue();
    expect(await verifier.verify("wrong", stored)).toBeFalse();
  });
  test("hashes and verifies Argon2id and detects rehash needs", async () => {
    const hasher = new Argon2PasswordHasher({ memoryCost: 19456, timeCost: 2, parallelism: 1 });
    const hash = await hasher.hash("correct horse battery staple");
    expect(hash.startsWith("$argon2id$")).toBeTrue();
    expect(await hasher.verify("correct horse battery staple", hash)).toBeTrue();
    expect(await hasher.verify("incorrect", hash)).toBeFalse();
    expect(hasher.needsRehash(hash)).toBeFalse();
    expect(new Argon2PasswordHasher({memoryCost:19456,timeCost:3,parallelism:1}).needsRehash(hash)).toBeTrue();
  });
  test("signs and strictly validates EdDSA issuer audience expiry and application", async () => {
    const service = new Ed25519AccessTokenService({issuer:"issuer",keyId:"kid",privateKeyBase64:privateKey,publicKeyBase64:publicKey,lifetimeSeconds:600});
    const signed = await service.sign({accountId:crypto.randomUUID(),sessionId:crypto.randomUUID(),applicationType:"CUSTOMER_APP",roles:["SUPER_ADMIN"]},1000);
    const verified = await service.verify(signed.token,"CUSTOMER_APP",1001);
    expect(verified.applicationType).toBe("CUSTOMER_APP");
    expect(verified.roles).toEqual([]);
    await expect(service.verify(signed.token,"DRIVER_APP",1001)).rejects.toThrow();
    await expect(service.verify(signed.token,"CUSTOMER_APP",1600)).rejects.toThrow();
    const wrongIssuer = new Ed25519AccessTokenService({issuer:"other",keyId:"kid",privateKeyBase64:privateKey,publicKeyBase64:publicKey,lifetimeSeconds:600});
    await expect(wrongIssuer.verify(signed.token,"CUSTOMER_APP",1001)).rejects.toThrow();
  });
  test("embeds Dashboard role claims and rejects forged or cross-audience role use", async () => {
    const service = new Ed25519AccessTokenService({issuer:"issuer",keyId:"kid",privateKeyBase64:privateKey,publicKeyBase64:publicKey,lifetimeSeconds:600});
    const accountId = crypto.randomUUID(), sessionId = crypto.randomUUID();
    const dashboard = await service.sign({accountId,sessionId,applicationType:"DASHBOARD",roles:["SUPER_ADMIN","SUPPORT"]},1000);
    expect((await service.verify(dashboard.token,"DASHBOARD",1001)).roles).toEqual(["SUPER_ADMIN","SUPPORT"]);
    await expect(service.verify(dashboard.token,"CUSTOMER_APP",1001)).rejects.toThrow();
    const forgedPayload = Buffer.from(JSON.stringify({iss:"issuer",aud:"dashboard",sub:accountId,sid:sessionId,app:"DASHBOARD",roles:["SUPER_ADMIN"],iat:1000,exp:1600,jti:crypto.randomUUID()})).toString("base64url");
    const [header] = dashboard.token.split(".");
    await expect(service.verify(`${header}.${forgedPayload}.AAAA`, "DASHBOARD", 1001)).rejects.toThrow();
    const customer = await service.sign({accountId,sessionId,applicationType:"CUSTOMER_APP",roles:[]},1000);
    expect((await service.verify(customer.token,"CUSTOMER_APP",1001)).roles).toEqual([]);
  });
  test("rate limiter is deterministic and honors TTL", async () => {
    let now=0; const limiter=new InMemoryRateLimiter(()=>now); const policy={limit:2,windowSeconds:10};
    expect((await limiter.consume("key",policy)).allowed).toBeTrue(); expect((await limiter.consume("key",policy)).allowed).toBeTrue(); expect((await limiter.consume("key",policy)).allowed).toBeFalse();
    now=10_001; expect((await limiter.consume("key",policy)).allowed).toBeTrue();
    expect(rateLimitKey("customer","otp","phone","digest")).toStartWith("auth:customer:otp:");
    expect(rateLimitKey("driver","login","phone","digest")).not.toBe(rateLimitKey("customer","login","phone","digest"));
  });
  test("recursively redacts nested arrays, aliases, headers, cookies, and error metadata", () => {
    const value=redact({Password:"x",accessCode:"001927",accessCodeHash:"hash",otpCode:"123456",accessToken:"a",apiKey:"b",nested:[{refresh_token:"y",Authorization:"Bearer z",cookie:"sid=x"}],error:{databaseUrl:"postgres://secret",clientSecret:"c",safe:"ok"}}) as Record<string,unknown>;
    expect(JSON.stringify(value)).not.toContain("Bearer z"); expect(JSON.stringify(value)).not.toContain("001927"); expect(JSON.stringify(value)).not.toContain("123456"); expect(JSON.stringify(value)).not.toContain("postgres://secret"); expect(JSON.stringify(value)).toContain("[REDACTED]"); expect(JSON.stringify(value)).toContain("ok");
  });
});
