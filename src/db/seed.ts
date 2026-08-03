import { SQL } from "bun";
import { loadDatabaseConfig } from "../config/env";

export const GOVERNORATE_SEED = [
  ["11111111-1111-4111-8111-000000000001", "بغداد", "Baghdad"], ["11111111-1111-4111-8111-000000000002", "البصرة", "Basra"],
  ["11111111-1111-4111-8111-000000000003", "ميسان", "Maysan"], ["11111111-1111-4111-8111-000000000004", "ذي قار", "Dhi Qar"],
  ["11111111-1111-4111-8111-000000000005", "المثنى", "Al Muthanna"], ["11111111-1111-4111-8111-000000000006", "القادسية", "Al-Qadisiyah"],
  ["11111111-1111-4111-8111-000000000007", "النجف", "Najaf"], ["11111111-1111-4111-8111-000000000008", "كربلاء", "Karbala"],
  ["11111111-1111-4111-8111-000000000009", "بابل", "Babil"], ["11111111-1111-4111-8111-000000000010", "واسط", "Wasit"],
  ["11111111-1111-4111-8111-000000000011", "ديالى", "Diyala"], ["11111111-1111-4111-8111-000000000012", "صلاح الدين", "Salah Al-Din"],
  ["11111111-1111-4111-8111-000000000013", "كركوك", "Kirkuk"], ["11111111-1111-4111-8111-000000000014", "نينوى", "Nineveh"],
  ["11111111-1111-4111-8111-000000000015", "الأنبار", "Al Anbar"], ["11111111-1111-4111-8111-000000000016", "أربيل", "Erbil"],
  ["11111111-1111-4111-8111-000000000017", "دهوك", "Duhok"], ["11111111-1111-4111-8111-000000000018", "السليمانية", "Sulaymaniyah"],
] as const;

export async function seedGovernorates(db: SQL): Promise<void> {
  await db.begin(async (tx) => {
    for (const [index, [id, nameAr, nameEn]] of GOVERNORATE_SEED.entries()) {
      await tx`insert into governorates(id,name_ar,name_en,status,display_order) values(${id},${nameAr},${nameEn},'ACTIVE',${index + 1}) on conflict (id) do nothing`;
    }
  });
}

if (import.meta.main) {
  const config = loadDatabaseConfig();
  const db = new SQL(config.databaseUrl, { max: config.databasePoolSize, idleTimeout: 30, connectionTimeout: config.databaseConnectionTimeoutMs / 1000 });
  try { await seedGovernorates(db); } finally { await db.close(); }
}
