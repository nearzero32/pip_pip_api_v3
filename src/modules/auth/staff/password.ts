export interface Argon2Configuration { memoryCost: number; timeCost: number; parallelism: number }

export class Argon2PasswordHasher {
  constructor(private readonly config: Argon2Configuration) {}
  hash(password: string): Promise<string> {
    return Bun.password.hash(password, { algorithm: "argon2id", ...this.config });
  }
  verify(password: string, encodedHash: string): Promise<boolean> { return Bun.password.verify(password, encodedHash, "argon2id"); }
  needsRehash(hash: string): boolean {
    const match = hash.match(/m=(\d+),t=(\d+),p=(\d+)/);
    return !match || Number(match[1]) !== this.config.memoryCost || Number(match[2]) !== this.config.timeCost || Number(match[3]) !== this.config.parallelism;
  }
}
