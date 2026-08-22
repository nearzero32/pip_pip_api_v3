import { describe, expect, test } from "bun:test";
import {
  buildExcelWorkbook,
  percentFromInteger,
  reopenExcelWorkbook,
  sanitizeExcelText,
} from "../../src/modules/dashboard-export/xlsx";
import {
  GRANTABLE_PERMISSION_CODES,
  SUPER_ADMIN_EXPORT_PERMISSION_CODES,
} from "../../src/modules/auth/staff/permissions";

describe("dashboard Excel sanitization", () => {
  test("prefixes formula-like text and leaves ordinary text", () => {
    expect(sanitizeExcelText("=HYPERLINK(\"http://evil\")")).toBe(
      "'=HYPERLINK(\"http://evil\")",
    );
    expect(sanitizeExcelText("+SUM(1,2)")).toBe("'+SUM(1,2)");
    expect(sanitizeExcelText("@command")).toBe("'@command");
    expect(sanitizeExcelText("-1+1")).toBe("'-1+1");
    expect(sanitizeExcelText("\t=cmd")).toBe("'\t=cmd");
    expect(sanitizeExcelText("\r=cmd")).toBe("' =cmd");
    expect(sanitizeExcelText("   =SUM(1,2)")).toBe("'   =SUM(1,2)");
    expect(sanitizeExcelText("Store")).toBe("Store");
    expect(sanitizeExcelText("مطاعم")).toBe("مطاعم");
  });

  test("global export codes are not grantable to city employees", () => {
    expect(GRANTABLE_PERMISSION_CODES).toContain(
      "stores.commission.history.export",
    );
    expect(GRANTABLE_PERMISSION_CODES).not.toContain("governorates.export");
    expect(SUPER_ADMIN_EXPORT_PERMISSION_CODES).toEqual([
      "governorates.export",
      "cities.export",
      "admins.export",
      "delivery_pricing.versions.export",
      "main_categories.export",
    ]);
  });

  test("converts integer percent 15 to Excel 0.15", () => {
    expect(percentFromInteger(15)).toBe(0.15);
    expect(percentFromInteger(0)).toBe(0);
    expect(percentFromInteger(100)).toBe(1);
  });

  test("embeds sanitized formulas as inline strings, not Excel formulas", () => {
    const bytes = buildExcelWorkbook({
      sheetName: "نسب",
      columns: [
        { key: "name", header: "الاسم", type: "text" },
        { key: "rate", header: "النسبة", type: "percent" },
        { key: "amount", header: "المبلغ", type: "integer" },
      ],
      rows: [
        {
          name: "=HYPERLINK(\"http://evil\")",
          rate: 15,
          amount: 2500,
        },
        { name: "+SUM(A1)", rate: 0, amount: 0 },
        { name: "@cmd", rate: 25, amount: 1 },
        { name: "-1+1", rate: 10, amount: 2 },
      ],
    });
    const reopened = reopenExcelWorkbook(bytes);
    expect(reopened.files["xl/workbook.xml"]).toBeTruthy();
    expect(reopened.dataRowCount).toBe(4);
    expect(reopened.sheetXml).toContain("t=\"inlineStr\"");
    expect(reopened.sheetXml).toContain("&apos;=HYPERLINK");
    expect(reopened.sheetXml).toContain("&apos;+SUM(A1)");
    expect(reopened.sheetXml).toContain("&apos;@cmd");
    expect(reopened.sheetXml).toContain("&apos;-1+1");
    expect(reopened.sheetXml).not.toMatch(/<f>/);
    expect(reopened.sheetXml).toContain("<v>0.15</v>");
    expect(reopened.sheetXml).toContain("rightToLeft=\"1\"");
    expect(reopened.sheetXml).toContain("state=\"frozen\"");
    expect(reopened.sheetXml).toContain("autoFilter");
    expect(new TextDecoder().decode(bytes)).toContain("numFmtId=\"164\"");
  });
});
