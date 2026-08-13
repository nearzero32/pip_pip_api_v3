import { describe, expect, test } from "bun:test";
import {
  buildExcelWorkbook,
  percentFromInteger,
  sanitizeExcelText,
} from "../../src/modules/dashboard-export/xlsx";

describe("dashboard Excel sanitization", () => {
  test("prefixes formula-like text and leaves ordinary text", () => {
    expect(sanitizeExcelText("=HYPERLINK(\"http://evil\")")).toBe(
      "'=HYPERLINK(\"http://evil\")",
    );
    expect(sanitizeExcelText("+SUM(A1)")).toBe("'+SUM(A1)");
    expect(sanitizeExcelText("@cmd")).toBe("'@cmd");
    expect(sanitizeExcelText("-1+1")).toBe("'-1+1");
    expect(sanitizeExcelText("Store")).toBe("Store");
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
    const xml = new TextDecoder().decode(bytes);
    expect(xml).toContain("spreadsheetml");
    expect(xml).toContain("t=\"inlineStr\"");
    expect(xml).toContain("&apos;=HYPERLINK");
    expect(xml).toContain("&apos;+SUM(A1)");
    expect(xml).toContain("&apos;@cmd");
    expect(xml).toContain("&apos;-1+1");
    expect(xml).not.toMatch(/<f>/);
    expect(xml).toContain("<v>0.15</v>");
    expect(xml).toContain("numFmtId=\"164\"");
    expect(xml).toContain("rightToLeft=\"1\"");
    expect(xml).toContain("state=\"frozen\"");
    expect(xml).toContain("autoFilter");
  });
});
