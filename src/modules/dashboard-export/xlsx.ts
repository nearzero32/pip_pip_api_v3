const FORMULA_PREFIX = /^[=+\-@]/;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

const crc32 = (data: Uint8Array): number => {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++)
    c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const concat = (parts: Uint8Array[]): Uint8Array => {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

const u16 = (value: number) => {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value, true);
  return bytes;
};

const u32 = (value: number) => {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
};

const zipStore = (files: { name: string; data: Uint8Array }[]): Uint8Array => {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  const encoder = new TextEncoder();
  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const crc = crc32(file.data);
    const local = concat([
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(file.data.length),
      u32(file.data.length),
      u16(nameBytes.length),
      u16(0),
      nameBytes,
      file.data,
    ]);
    locals.push(local);
    centrals.push(
      concat([
        u32(0x02014b50),
        u16(20),
        u16(20),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(crc),
        u32(file.data.length),
        u32(file.data.length),
        u16(nameBytes.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(offset),
        nameBytes,
      ]),
    );
    offset += local.length;
  }
  const centralDir = concat(centrals);
  return concat([
    ...locals,
    centralDir,
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(files.length),
    u16(files.length),
    u32(centralDir.length),
    u32(offset),
    u16(0),
  ]);
};

export const sanitizeExcelText = (value: string): string => {
  const text = value.replace(/\r\n|\r|\n/g, " ");
  if (FORMULA_PREFIX.test(text) || text.startsWith("\t")) return `'${text}`;
  return text;
};

export const percentFromInteger = (rate: number): number => rate / 100;

const xmlEscape = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

const columnLetter = (index: number): string => {
  let n = index + 1;
  let letters = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
};

export type ExcelValueType = "text" | "integer" | "number" | "percent" | "datetime";

export type ExcelColumn = {
  key: string;
  header: string;
  width?: number;
  type: ExcelValueType;
};

export type ExcelCell = string | number | null | Date;

const formatIso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : String(value);

const cellXml = (
  ref: string,
  value: ExcelCell,
  type: ExcelValueType,
): string => {
  if (value == null || value === "")
    return `<c r="${ref}"/>`;
  if (type === "integer" || type === "number") {
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n))
      return `<c r="${ref}" t="inlineStr"><is><t>${xmlEscape(sanitizeExcelText(String(value)))}</t></is></c>`;
    return `<c r="${ref}" s="2"><v>${n}</v></c>`;
  }
  if (type === "percent") {
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n))
      return `<c r="${ref}" t="inlineStr"><is><t>${xmlEscape(sanitizeExcelText(String(value)))}</t></is></c>`;
    return `<c r="${ref}" s="3"><v>${percentFromInteger(n)}</v></c>`;
  }
  const text =
    type === "datetime"
      ? formatIso(value as Date | string)
      : sanitizeExcelText(String(value));
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(text)}</t></is></c>`;
};

export const buildExcelWorkbook = (input: {
  sheetName: string;
  columns: ExcelColumn[];
  rows: Array<Record<string, ExcelCell>>;
}): Uint8Array => {
  const encoder = new TextEncoder();
  const lastCol = columnLetter(Math.max(0, input.columns.length - 1));
  const lastRow = Math.max(1, input.rows.length + 1);
  const colsXml = input.columns
    .map((column, index) => {
      const width = column.width ?? Math.max(12, Math.min(40, column.header.length + 4));
      return `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`;
    })
    .join("");
  const headerCells = input.columns
    .map(
      (column, index) =>
        `<c r="${columnLetter(index)}1" t="inlineStr" s="1"><is><t>${xmlEscape(column.header)}</t></is></c>`,
    )
    .join("");
  const dataRows = input.rows
    .map((row, rowIndex) => {
      const r = rowIndex + 2;
      const cells = input.columns
        .map((column, colIndex) =>
          cellXml(
            `${columnLetter(colIndex)}${r}`,
            row[column.key] ?? null,
            column.type,
          ),
        )
        .join("");
      return `<row r="${r}">${cells}</row>`;
    })
    .join("");
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheetViews>
    <sheetView workbookViewId="0" rightToLeft="1">
      <pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>
    </sheetView>
  </sheetViews>
  <cols>${colsXml}</cols>
  <sheetData>
    <row r="1">${headerCells}</row>
    ${dataRows}
  </sheetData>
  <autoFilter ref="A1:${lastCol}${lastRow}"/>
</worksheet>`;
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="${xmlEscape(input.sheetName.slice(0, 31))}" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="1">
    <numFmt numFmtId="164" formatCode="0%"/>
  </numFmts>
  <fonts count="2">
    <font><sz val="11"/><name val="Calibri"/></font>
    <font><b/><sz val="11"/><name val="Calibri"/></font>
  </fonts>
  <fills count="1"><fill><patternFill patternType="none"/></fill></fills>
  <borders count="1"><border/></borders>
  <cellStyleXfs count="1"><xf/></cellStyleXfs>
  <cellXfs count="4">
    <xf xfId="0"/>
    <xf xfId="0" fontId="1" applyFont="1"/>
    <xf xfId="0" applyNumberFormat="1" numFmtId="1"/>
    <xf xfId="0" applyNumberFormat="1" numFmtId="164"/>
  </cellXfs>
</styleSheet>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;
  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;
  return zipStore([
    { name: "[Content_Types].xml", data: encoder.encode(contentTypes) },
    { name: "_rels/.rels", data: encoder.encode(rels) },
    { name: "xl/workbook.xml", data: encoder.encode(workbook) },
    { name: "xl/_rels/workbook.xml.rels", data: encoder.encode(workbookRels) },
    { name: "xl/styles.xml", data: encoder.encode(styles) },
    { name: "xl/worksheets/sheet1.xml", data: encoder.encode(sheet) },
  ]);
};

export const excelFileResponse = (filename: string, bytes: Uint8Array) =>
  new Response(Buffer.from(bytes), {
    status: 200,
    headers: {
      "content-type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
    },
  });
