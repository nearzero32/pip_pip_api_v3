import { AppError } from "../../errors/app-error";

const STORE_STATUSES = ["DRAFT", "ACTIVE", "INACTIVE", "ARCHIVED"] as const;

export const parseOptionalSearch = (value?: string): string | null =>
  value?.trim() || null;

export const parseStoreStatusFilter = (status?: string): string | null => {
  const value = status?.trim() || null;
  if (value && !STORE_STATUSES.includes(value as (typeof STORE_STATUSES)[number]))
    throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
  return value;
};

export const parseOptionalUuid = (value?: string): string | null =>
  value?.trim() || null;

/** Shared store-list WHERE used by dashboard list and Excel export. */
export const STORE_LIST_WHERE_SQL = `
  s.city_id = $1::uuid
  and ($2::text is null or s.status = $2::store_status)
  and ($2::text is not null or s.status <> 'ARCHIVED')
  and ($3::uuid is null or s.main_category_id = $3::uuid)
  and ($4::text is null or s.name ilike ('%' || $4 || '%'))
`;

/** Shared commission-page WHERE (no main-category filter). */
export const COMMISSION_STORE_WHERE_SQL = `
  s.city_id = $1::uuid
  and ($2::text is null or s.status = $2::store_status)
  and ($2::text is not null or s.status <> 'ARCHIVED')
  and ($3::text is null or s.name ilike ('%' || $3 || '%'))
`;
