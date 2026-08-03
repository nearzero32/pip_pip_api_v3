import { CryptoHasher, type SQL } from "bun";

interface JournalEntry { idx: number; when: number; tag: string; breakpoints: boolean }
interface Journal { entries: JournalEntry[] }

const migrationLockId = 7_204_903_221;

/** Applies generated Drizzle SQL in journal order, one transaction per file.
 * PostgreSQL requires this commit boundary before a newly added enum value is used.
 */
export async function applyMigrations(client: SQL, folder = "./drizzle"): Promise<void> {
  await client`create schema if not exists drizzle`;
  await client`create table if not exists drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint)`;
  await client`select pg_advisory_lock(${migrationLockId})`;
  try {
    const journal = await Bun.file(`${folder}/meta/_journal.json`).json() as Journal;
    const [latest] = await client<{created_at:string|null}[]>`select created_at::text created_at from drizzle.__drizzle_migrations order by created_at desc limit 1`;
    const lastApplied = Number(latest?.created_at ?? 0);
    for (const entry of [...journal.entries].sort((left,right)=>left.idx-right.idx)) {
      if (entry.when <= lastApplied) continue;
      const contents = await Bun.file(`${folder}/${entry.tag}.sql`).text();
      const statements = entry.breakpoints ? contents.split("--> statement-breakpoint") : [contents];
      const hash = new CryptoHasher("sha256").update(contents).digest("hex");
      await client.begin(async transaction => {
        for (const statement of statements.map(value=>value.trim()).filter(Boolean)) await transaction.unsafe(statement);
        await transaction`insert into drizzle.__drizzle_migrations(hash,created_at) values(${hash},${entry.when})`;
      });
    }
  } finally {
    await client`select pg_advisory_unlock(${migrationLockId})`;
  }
}
