import type { SQL } from "bun";
import { AppError } from "../../errors/app-error";
import { dateValue } from "../geography/shared";

/** Integer IQD (1 IQD = 1 unit). Matches orders.total / products_subtotal / delivery_fee. */
export const COLLECTION_AMOUNT_MAX = 99_999_999;

export type CollectionConfirmationSource = "DRIVER_APP" | "DASHBOARD_OVERRIDE";

export type OrderCollectionDto = {
  expectedAmount: number;
  collectedAmount: number;
  differenceAmount: number;
  currency: "IQD";
  assignmentId: string;
  collectingDriverId: string;
  confirmationSource: CollectionConfirmationSource;
  collectedAt: string;
};

export type OrderCollectionRow = {
  id: string;
  order_id: string;
  assignment_id: string;
  collecting_driver_id: string;
  expected_amount: number;
  collected_amount: number;
  difference_amount: number;
  currency: string;
  confirmed_by_account_id: string;
  confirmation_source: string;
  order_event_id: string;
  collected_at: Date | string;
};

const uniqueConstraint = (error: unknown): string | null => {
  const record = error as {
    code?: string;
    constraint?: string;
    constraintName?: string;
    message?: string;
    cause?: { code?: string; constraint?: string; constraintName?: string; message?: string };
  };
  const blob = `${record.code ?? ""} ${record.constraint ?? ""} ${record.constraintName ?? ""} ${record.message ?? ""} ${record.cause?.code ?? ""} ${record.cause?.constraint ?? ""} ${record.cause?.constraintName ?? ""} ${record.cause?.message ?? ""}`;
  if (!blob.includes("23505") && !blob.includes("order_collections_order_uidx") && !blob.toLowerCase().includes("duplicate"))
    return null;
  return (
    record.constraint ??
    record.constraintName ??
    record.cause?.constraint ??
    record.cause?.constraintName ??
    blob
  );
};

export const parseCollectedAmount = (raw: unknown): number => {
  if (raw === undefined || raw === null)
    throw new AppError(
      422,
      "COLLECTED_AMOUNT_REQUIRED",
      "collectedAmount is required",
    );
  if (
    typeof raw !== "number" ||
    !Number.isInteger(raw) ||
    !Number.isSafeInteger(raw) ||
    raw < 0 ||
    raw > COLLECTION_AMOUNT_MAX
  )
    throw new AppError(
      422,
      "COLLECTED_AMOUNT_INVALID",
      "collectedAmount must be a non-negative integer IQD amount",
    );
  return raw;
};

export const expectedCollectionAmountOf = (total: unknown): number => {
  if (
    typeof total !== "number" ||
    !Number.isInteger(total) ||
    !Number.isSafeInteger(total) ||
    total < 0
  )
    throw new AppError(
      409,
      "ORDER_EXPECTED_COLLECTION_UNAVAILABLE",
      "Expected collection amount is unavailable",
    );
  return total;
};

export const assertCollectedMeetsExpected = (
  collectedAmount: number,
  expectedAmount: number,
) => {
  if (collectedAmount >= expectedAmount) return;
  throw new AppError(
    409,
    "COLLECTED_AMOUNT_BELOW_EXPECTED",
    "Collected amount is below the expected collection amount",
    undefined,
    undefined,
    {
      expectedCollectionAmount: expectedAmount,
      collectedAmount,
      shortfallAmount: expectedAmount - collectedAmount,
    },
  );
};

export const mapOrderCollection = (
  row: OrderCollectionRow,
): OrderCollectionDto => ({
  expectedAmount: Number(row.expected_amount),
  collectedAmount: Number(row.collected_amount),
  differenceAmount: Number(row.difference_amount),
  currency: "IQD",
  assignmentId: String(row.assignment_id),
  collectingDriverId: String(row.collecting_driver_id),
  confirmationSource: row.confirmation_source as CollectionConfirmationSource,
  collectedAt: dateValue(row.collected_at)!,
});

export const loadOrderCollection = async (
  executor: SQL,
  orderId: string,
): Promise<OrderCollectionDto | null> => {
  const [row] = await executor<OrderCollectionRow[]>`
    select id::text, order_id::text, assignment_id::text, collecting_driver_id::text,
           expected_amount, collected_amount, difference_amount, currency,
           confirmed_by_account_id::text, confirmation_source::text,
           order_event_id::text, collected_at
    from order_collections where order_id = ${orderId}`;
  return row ? mapOrderCollection(row) : null;
};

export const insertOrderCollection = async (
  tx: SQL,
  input: {
    id: string;
    orderId: string;
    assignmentId: string;
    collectingDriverId: string;
    expectedAmount: number;
    collectedAmount: number;
    confirmedByAccountId: string;
    confirmationSource: CollectionConfirmationSource;
    orderEventId: string;
    collectedAt: Date;
  },
): Promise<OrderCollectionDto> => {
  const differenceAmount = input.collectedAmount - input.expectedAmount;
  try {
    const [row] = await tx<OrderCollectionRow[]>`
      insert into order_collections (
        id, order_id, assignment_id, collecting_driver_id,
        expected_amount, collected_amount, difference_amount, currency,
        confirmed_by_account_id, confirmation_source, order_event_id, collected_at
      ) values (
        ${input.id}, ${input.orderId}, ${input.assignmentId}, ${input.collectingDriverId},
        ${input.expectedAmount}, ${input.collectedAmount}, ${differenceAmount}, 'IQD',
        ${input.confirmedByAccountId}, ${input.confirmationSource},
        ${input.orderEventId}, ${input.collectedAt}
      )
      returning id::text, order_id::text, assignment_id::text, collecting_driver_id::text,
                expected_amount, collected_amount, difference_amount, currency,
                confirmed_by_account_id::text, confirmation_source::text,
                order_event_id::text, collected_at`;
    return mapOrderCollection(row!);
  } catch (error) {
    const constraint = uniqueConstraint(error);
    if (
      constraint?.includes("order_collections_order_uidx") ||
      constraint?.includes("23505") ||
      constraint?.toLowerCase().includes("duplicate")
    )
      throw new AppError(
        409,
        "ORDER_COLLECTION_ALREADY_RECORDED",
        "A successful collection is already recorded for this order",
      );
    const record = error as { code?: string; cause?: { code?: string } };
    const code = String(record.code ?? record.cause?.code ?? "");
    if (code === "23503")
      throw new AppError(
        409,
        "ORDER_COLLECTION_ASSIGNMENT_MISMATCH",
        "Collection must reference the delivering assignment and its driver",
      );
    throw error;
  }
};

export const collectionEventMetadata = (input: {
  collectionId: string;
  expectedAmount: number;
  collectedAmount: number;
  differenceAmount: number;
  assignmentId: string;
  collectingDriverId: string;
  confirmationSource: CollectionConfirmationSource;
  confirmedByAccountId: string;
  note?: string | null;
}): Record<string, unknown> => ({
  collectionId: input.collectionId,
  expectedAmount: input.expectedAmount,
  collectedAmount: input.collectedAmount,
  differenceAmount: input.differenceAmount,
  currency: "IQD",
  assignmentId: input.assignmentId,
  collectingDriverId: input.collectingDriverId,
  confirmationSource: input.confirmationSource,
  confirmedByAccountId: input.confirmedByAccountId,
  ...(input.note ? { note: input.note } : {}),
});
