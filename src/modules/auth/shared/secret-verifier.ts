import { encodeBase64Url } from "./encoding";

export class HmacSecretVerifier {
  private keyPromise: Promise<CryptoKey>;
  constructor(readonly keyVersion: string, secret: string) {
    this.keyPromise = crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  }
  async create(value: string): Promise<string> {
    const signature = await crypto.subtle.sign("HMAC", await this.keyPromise, new TextEncoder().encode(value));
    return encodeBase64Url(new Uint8Array(signature));
  }
  async verify(value: string, expected: string): Promise<boolean> {
    const actual = await this.create(value);
    const left = Buffer.from(actual); const right = Buffer.from(expected);
    return left.length === right.length && crypto.timingSafeEqual(left, right);
  }
}
