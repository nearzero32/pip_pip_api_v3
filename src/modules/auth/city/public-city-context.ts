import type { SQL } from "bun";
import { AppError } from "../../../errors/app-error";

export const PUBLIC_CITY_HEADER = "x-city-id";

export type PublicCityContext = {
  city: { id: string };
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Canonical public/mobile City selection context (`X-City-Id`).
 * Not an authentication credential and must never override Dashboard City scope.
 */
export async function requirePublicCityContext(
  client: SQL,
  request: Request,
): Promise<PublicCityContext> {
  let headerPresent = false;
  let headerValue = "";
  request.headers.forEach((value, key) => {
    if (key.toLowerCase() !== PUBLIC_CITY_HEADER) return;
    headerPresent = true;
    headerValue = value;
  });
  if (!headerPresent)
    throw new AppError(400, "CITY_CONTEXT_REQUIRED", "City context is required");
  if (headerValue.trim() === "")
    throw new AppError(400, "INVALID_CITY_CONTEXT", "City context is invalid");

  const values = headerValue
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (values.length !== 1)
    throw new AppError(400, "INVALID_CITY_CONTEXT", "City context is invalid");
  const cityId = values[0]!;
  if (!UUID_RE.test(cityId))
    throw new AppError(400, "INVALID_CITY_CONTEXT", "City context is invalid");

  const [row] = await client<
    { id: string; city_status: string; governorate_status: string }[]
  >`select c.id::text as id, c.status::text as city_status, g.status::text as governorate_status
    from cities c
    join governorates g on g.id = c.governorate_id
    where c.id = ${cityId}`;
  if (!row) throw new AppError(404, "CITY_NOT_FOUND", "City not found");
  if (row.city_status !== "ACTIVE" || row.governorate_status !== "ACTIVE")
    throw new AppError(409, "CITY_NOT_ACTIVE", "City is not active");
  return { city: { id: row.id } };
}
