import { describe, expect, test } from "bun:test";

describe("order commission snapshot writes", () => {
  test("mutations do not assign store_commission_rate_snapshot after insert", async () => {
    const orderService = await Bun.file(
      "src/modules/orders/order.service.ts",
    ).text();
    const opsService = await Bun.file(
      "src/modules/orders/order-ops.service.ts",
    ).text();
    const lifecycleService = await Bun.file(
      "src/modules/orders/order-lifecycle.service.ts",
    ).text();
    expect(opsService).not.toContain("store_commission_rate_snapshot");
    expect(lifecycleService).not.toContain("store_commission_rate_snapshot");
    const updates = [
      ...orderService.matchAll(/update\s+orders[\s\S]*?where/gi),
    ].map((match) => match[0]!);
    expect(updates.length).toBeGreaterThan(0);
    for (const sql of updates)
      expect(sql).not.toContain("store_commission_rate_snapshot");
    expect(orderService).toContain(
      "insert into orders(",
    );
    expect(orderService).toContain("store_commission_rate_snapshot");
  });
});
