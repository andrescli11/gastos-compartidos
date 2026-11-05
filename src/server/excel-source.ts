import { inflateRawSync } from "node:zlib";
import { CSV_LIMITS, type CsvTable, type CsvCell } from "../domain/csv.ts";

/** A deliberately restricted, deterministic OOXML reader. No formulas, links or code execute.
 * Numeric cell literals remain decimal strings, so amounts never round-trip through JS numbers.
 */
export const EXCEL_LIMITS = {
  bytes: CSV_LIMITS.bytes,
  expandedBytes: 30 * 1024 * 1024,
  entryBytes: 16 * 1024 * 1024,
  entries: 500,
  sheets: 10,
  rows: CSV_LIMITS.rows,
  columns: CSV_LIMITS.columns,
  cells: CSV_LIMITS.rows * CSV_LIMITS.columns,
  sharedStrings: 20000,
} as const;
export class ExcelSourceError extends Error {
  constructor() {
    super(
      "El archivo Excel está protegido, contiene contenido no admitido, está dañado o supera los límites. Usa un archivo .xlsx sin macros ni vínculos externos.",
    );
    this.name = "ExcelSourceError";
  }
}
function check(value: unknown): asserts value {
  if (!value) throw new ExcelSourceError();
}
const crcTable = Array.from({ length: 256 }, (_, value) => {
  let current = value;
  for (let bit = 0; bit < 8; bit++)
    current = (current >>> 1) ^ (current & 1 ? 0xedb88320 : 0);
  return current >>> 0;
});
function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}
function unzip(source: Uint8Array): Map<string, Buffer> {
  check(source.byteLength > 22 && source.byteLength <= EXCEL_LIMITS.bytes);
  const input = Buffer.from(
    source.buffer,
    source.byteOffset,
    source.byteLength,
  );
  check(input.readUInt32LE(0) === 0x04034b50); // Reject OLE/encrypted .xls and arbitrary MIME spoofing.
  let end = -1;
  for (
    let at = input.length - 22;
    at >= Math.max(0, input.length - 65557);
    at--
  ) {
    if (
      input.readUInt32LE(at) === 0x06054b50 &&
      at + 22 + input.readUInt16LE(at + 20) === input.length
    ) {
      end = at;
      break;
    }
  }
  check(end >= 0);
  check(input.readUInt16LE(end + 4) === 0 && input.readUInt16LE(end + 6) === 0);
  const count = input.readUInt16LE(end + 10),
    size = input.readUInt32LE(end + 12),
    start = input.readUInt32LE(end + 16);
  check(
    count > 0 &&
      count <= EXCEL_LIMITS.entries &&
      input.readUInt16LE(end + 8) === count,
  );
  check(start + size === end && start >= 0);
  const output = new Map<string, Buffer>(),
    names = new Set<string>();
  let at = start,
    total = 0;
  const occupied: [number, number][] = [];
  for (let index = 0; index < count; index++) {
    check(at + 46 <= end && input.readUInt32LE(at) === 0x02014b50);
    const flags = input.readUInt16LE(at + 8),
      method = input.readUInt16LE(at + 10);
    const crc = input.readUInt32LE(at + 16),
      packed = input.readUInt32LE(at + 20),
      expanded = input.readUInt32LE(at + 24);
    const nameLength = input.readUInt16LE(at + 28),
      extra = input.readUInt16LE(at + 30),
      comment = input.readUInt16LE(at + 32);
    const offset = input.readUInt32LE(at + 42);
    check(
      at + 46 + nameLength + extra + comment <= end &&
        nameLength > 0 &&
        nameLength < 256,
    );
    check(!(flags & 0x41) && [0, 8].includes(method)); // no encryption; stored or deflate only
    check(
      input.readUInt16LE(at + 34) === 0 &&
        ((input.readUInt32LE(at + 38) >>> 16) & 0xf000) !== 0xa000,
    );
    const name = input.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    check(
      !name.includes("\ufffd") &&
        !/[\\\u0000-\u001f]/.test(name) &&
        !name.startsWith("/") &&
        !name.includes(":"),
    );
    check(
      name
        .split("/")
        .every(
          (part, i, parts) =>
            part !== "." &&
            part !== ".." &&
            (part !== "" || i === parts.length - 1),
        ),
    );
    check(!names.has(name.toLowerCase()));
    names.add(name.toLowerCase());
    check(
      !/\.(bin|exe|js|vbs)$/i.test(name) &&
        !/(?:^|\/)(?:externallinks|activex|embeddings|customui)(?:\/|$)/i.test(
          name,
        ),
    );
    check(
      expanded <= EXCEL_LIMITS.entryBytes &&
        expanded <= Math.max(1024, packed * 100),
    );
    total += expanded;
    check(total <= EXCEL_LIMITS.expandedBytes);
    check(offset + 30 <= start && input.readUInt32LE(offset) === 0x04034b50);
    check(
      input.readUInt16LE(offset + 6) === flags &&
        input.readUInt16LE(offset + 8) === method,
    );
    const localNameLength = input.readUInt16LE(offset + 26),
      localExtra = input.readUInt16LE(offset + 28);
    const dataStart = offset + 30 + localNameLength + localExtra,
      dataEnd = dataStart + packed;
    check(
      dataStart <= start &&
        dataEnd <= start &&
        input
          .subarray(offset + 30, offset + 30 + localNameLength)
          .toString("utf8") === name,
    );
    check(!occupied.some(([a, b]) => offset < b && dataEnd > a));
    occupied.push([offset, dataEnd]);
    if (!name.endsWith("/")) {
      const compressed = input.subarray(dataStart, dataEnd);
      let bytes: Buffer;
      try {
        bytes =
          method === 0
            ? Buffer.from(compressed)
            : inflateRawSync(compressed, {
                maxOutputLength: Math.max(1, expanded),
              });
      } catch {
        throw new ExcelSourceError();
      }
      check(bytes.length === expanded && crc32(bytes) === crc);
      output.set(name, bytes);
    }
    at += 46 + nameLength + extra + comment;
  }
  check(at === end);
  return output;
}
function entities(value: string): string {
  check(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value));
  return value.replace(
    /&([^;]{1,20});|&/g,
    (whole, entity: string | undefined) => {
      const known: Record<string, string> = {
        amp: "&",
        lt: "<",
        gt: ">",
        quot: '"',
        apos: "'",
      };
      if (entity && known[entity]) return known[entity];
      check(entity && /^#(?:[0-9]+|x[0-9a-fA-F]+)$/.test(entity));
      const point = entity.startsWith("#x")
        ? parseInt(entity.slice(2), 16)
        : Number(entity.slice(1));
      check(
        Number.isSafeInteger(point) &&
          point > 0 &&
          point <= 0x10ffff &&
          !(point >= 0xd800 && point <= 0xdfff) &&
          (point >= 32 || [9, 10, 13].includes(point)),
      );
      return String.fromCodePoint(point);
    },
  );
}
type XmlHandler = {
  start?: (name: string, attrs: Record<string, string>) => void;
  end?: (name: string) => void;
  text?: (value: string) => void;
};
/** No DOM, no external entities, bounded nesting/tokens. Unknown extensions are ignored as data. */
function xml(bytes: Buffer, handler: XmlHandler) {
  const text = bytes.toString("utf8").replace(/^\ufeff/, "");
  check(!text.includes("\ufffd") && !/<!DOCTYPE|<!ENTITY/i.test(text));
  function* tokens() {
    let at = 0,
      count = 0;
    while (at < text.length) {
      check(++count <= 1200000);
      let end: number;
      if (text[at] !== "<") {
        const next = text.indexOf("<", at);
        end = next < 0 ? text.length : next;
      } else if (text.startsWith("<!--", at)) {
        const close = text.indexOf("-->", at + 4);
        check(close >= 0);
        end = close + 3;
      } else if (text.startsWith("<![CDATA[", at)) {
        const close = text.indexOf("]]>", at + 9);
        check(close >= 0);
        end = close + 3;
      } else if (text.startsWith("<?", at)) {
        const close = text.indexOf("?>", at + 2);
        check(close >= 0);
        end = close + 2;
      } else {
        end = at + 1;
        let quote = "";
        for (; end < text.length; end++) {
          const char = text[end];
          check(char !== "<");
          if (quote) {
            if (char === quote) quote = "";
          } else if (char === "'" || char === '"') quote = char;
          else if (char === ">") break;
          check(end - at <= 65536);
        }
        check(end < text.length && !quote);
        end++;
      }
      yield text.slice(at, end);
      at = end;
    }
  }
  const stack: string[] = [];
  let roots = 0;
  for (const token of tokens()) {
    if (token.startsWith("<!--")) {
      check(!token.slice(4, -3).includes("--"));
      continue;
    }
    if (token.startsWith("<?")) {
      check(/^<\?xml\s[^?]*\?>$/.test(token) && roots === 0);
      continue;
    }
    if (token.startsWith("<![CDATA[")) {
      check(stack.length > 0);
      handler.text?.(token.slice(9, -3));
      continue;
    }
    if (token.startsWith("</")) {
      const match = /^<\/([A-Za-z_][\w.:-]*)\s*>$/.exec(token);
      check(match && stack.pop() === match[1]);
      handler.end?.(match[1].split(":").at(-1)!);
      continue;
    }
    if (token.startsWith("<")) {
      const match = /^<([A-Za-z_][\w.:-]*)([\s\S]*?)(\/?)>$/.exec(token);
      check(match);
      const attrs: Record<string, string> = Object.create(null);
      let tail = match[2];
      let attributeCount = 0;
      while (tail.trim()) {
        check(++attributeCount <= 100);
        const attr =
          /^\s+([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/.exec(tail);
        check(attr && !(attr[1] in attrs));
        attrs[attr[1]] = entities(attr[2] ?? attr[3]);
        tail = tail.slice(attr[0].length);
      }
      if (!stack.length) {
        roots++;
        check(roots === 1);
      }
      const local = match[1].split(":").at(-1)!;
      handler.start?.(local, attrs);
      if (match[3]) handler.end?.(local);
      else {
        stack.push(match[1]);
        check(stack.length <= 64);
      }
      continue;
    }
    if (!stack.length) check(!token.trim());
    else handler.text?.(entities(token));
  }
  check(!stack.length && roots === 1);
}
function decimal(value: string) {
  // Exact expansion of Excel numeric lexical form; not monetary arithmetic in Number.
  const match = /^(-?)(\d+)(?:\.(\d*))?(?:[Ee]([+-]?\d{1,3}))?$/.exec(value);
  check(match);
  const digits = match[2] + (match[3] || ""),
    scale = (match[3]?.length || 0) - Number(match[4] || 0);
  check(digits.length <= 100 && Math.abs(scale) <= 100);
  const raw =
    scale <= 0
      ? digits + "0".repeat(-scale)
      : scale >= digits.length
        ? "0." + "0".repeat(scale - digits.length) + digits
        : digits.slice(0, -scale) + "." + digits.slice(-scale);
  return match[1] + raw.replace(/^0+(?=\d)/, "");
}
function address(value: string): { row: number; column: number } {
  const match = /^([A-Z]{1,3})([1-9]\d{0,6})$/.exec(value);
  check(match);
  let column = 0;
  for (const char of match[1]) column = column * 26 + char.charCodeAt(0) - 64;
  const row = Number(match[2]);
  check(row <= EXCEL_LIMITS.rows && column <= EXCEL_LIMITS.columns);
  return { row, column };
}
export type ExcelSheet = {
  id: string;
  name: string;
  table: CsvTable;
  warnings: string[];
};
export type ExcelSource = { sheets: ExcelSheet[]; warnings: string[] };
export function parseXlsx(source: Uint8Array): ExcelSource {
  try {
    return readXlsx(source);
  } catch {
    throw new ExcelSourceError();
  }
}
function readXlsx(source: Uint8Array): ExcelSource {
  const files = unzip(source);
  const required = (name: string) => {
    const bytes = files.get(name);
    check(bytes);
    return bytes;
  };
  let validContentType = false;
  xml(required("[Content_Types].xml"), {
    start(name, attrs) {
      if (name === "Override" && attrs.PartName === "/xl/workbook.xml")
        validContentType =
          attrs.ContentType ===
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml";
      check(
        !/macroEnabled|vbaProject|activeX|oleObject/i.test(
          attrs.ContentType || "",
        ),
      );
    },
  });
  check(validContentType);
  for (const [name, bytes] of files)
    if (name.endsWith(".rels"))
      xml(bytes, {
        start(tag, attrs) {
          if (tag === "Relationship")
            check(
              attrs.TargetMode !== "External" &&
                !/^[a-z]+:|^\/\//i.test(attrs.Target || ""),
            );
        },
      });
  const relationships = new Map<string, string>();
  xml(required("xl/_rels/workbook.xml.rels"), {
    start(name, attrs) {
      if (name !== "Relationship" || !attrs.Type?.endsWith("/worksheet"))
        return;
      check(attrs.Id && attrs.Target && !relationships.has(attrs.Id));
      const target = attrs.Target.startsWith("/")
        ? attrs.Target.slice(1)
        : "xl/" + attrs.Target;
      check(/^xl\/worksheets\/[A-Za-z0-9_.-]+\.xml$/.test(target));
      relationships.set(attrs.Id, target);
    },
  });
  const definitions: { id: string; name: string }[] = [];
  let date1904 = false;
  xml(required("xl/workbook.xml"), {
    start(name, attrs) {
      check(name !== "workbookProtection");
      if (name === "workbookPr")
        date1904 = attrs.date1904 === "1" || attrs.date1904 === "true";
      if (name === "sheet") {
        check(
          attrs["r:id"] &&
            attrs.name &&
            attrs.name.length <= 100 &&
            definitions.length < EXCEL_LIMITS.sheets,
        );
        check(
          !definitions.some(
            (s) => s.id === attrs["r:id"] || s.name === attrs.name,
          ),
        );
        definitions.push({ id: attrs["r:id"], name: attrs.name });
      }
    },
  });
  check(definitions.length > 0);
  const strings: string[] = [];
  let shared: string | null = null,
    inText = false;
  if (files.has("xl/sharedStrings.xml"))
    xml(required("xl/sharedStrings.xml"), {
      start(name) {
        if (name === "si") {
          check(shared === null);
          shared = "";
        }
        if (name === "t") inText = true;
      },
      end(name) {
        if (name === "t") inText = false;
        if (name === "si") {
          check(shared !== null && strings.length < EXCEL_LIMITS.sharedStrings);
          strings.push(shared);
          shared = null;
        }
      },
      text(value) {
        if (shared !== null && inText) {
          shared += value;
          check(shared.length <= CSV_LIMITS.cellCharacters);
        }
      },
    });
  const dateStyles = new Set<number>();
  const customFormats = new Map<number, string>();
  let inCellFormats = false,
    styleIndex = 0;
  if (files.has("xl/styles.xml"))
    xml(required("xl/styles.xml"), {
      start(name, attrs) {
        if (name === "numFmt") {
          check(customFormats.size < 1000);
          customFormats.set(Number(attrs.numFmtId), attrs.formatCode || "");
        }
        if (name === "cellXfs") inCellFormats = true;
        if (name === "xf" && inCellFormats) {
          check(styleIndex < 10000);
          const id = Number(attrs.numFmtId || 0),
            format = customFormats
              .get(id)
              ?.replace(/"[^"]*"|\\.|\[[^\]]*\]/g, "");
          if (
            [14, 15, 16, 17, 22].includes(id) ||
            (format && /d/i.test(format) && /y/i.test(format))
          )
            dateStyles.add(styleIndex);
          styleIndex++;
        }
      },
      end(name) {
        if (name === "cellXfs") inCellFormats = false;
      },
    });
  let totalRows = 0,
    totalCells = 0;
  const sheets = definitions.map((def) => {
    const path = relationships.get(def.id);
    check(path);
    const rows = new Map<number, Map<number, CsvCell>>(),
      warnings = new Set<string>();
    let current: {
      row: number;
      column: number;
      type: string;
      style: number;
      value: string;
      inline: string;
      formula: string;
      hasFormula: boolean;
      hasValue: boolean;
    } | null = null;
    let capturing: "value" | "inline" | "formula" | null = null;
    xml(required(path), {
      start(name, attrs) {
        check(!["sheetProtection", "externalLink", "oleObject"].includes(name));
        if (name === "c") {
          check(current === null && attrs.r);
          const pos = address(attrs.r);
          current = {
            ...pos,
            type: attrs.t || "n",
            style: Number(attrs.s || 0),
            value: "",
            inline: "",
            formula: "",
            hasFormula: false,
            hasValue: false,
          };
        }
        if (current && name === "v") {
          check(!current.hasValue);
          current.hasValue = true;
          capturing = "value";
        }
        if (current && name === "t") capturing = "inline";
        if (current && name === "f") {
          check(!current.hasFormula);
          current.hasFormula = true;
          capturing = "formula";
        }
      },
      text(value) {
        if (current && capturing) {
          current[capturing] += value;
          check(current[capturing].length <= CSV_LIMITS.cellCharacters);
        }
      },
      end(name) {
        if (["v", "t", "f"].includes(name)) capturing = null;
        if (name !== "c") return;
        check(current);
        const cell = current;
        current = null;
        let text = cell.value;
        if (cell.type === "s") {
          check(/^\d+$/.test(text));
          const value = strings[Number(text)];
          check(value !== undefined);
          text = value;
        } else if (cell.type === "inlineStr") text = cell.inline;
        else if (cell.type === "n" && text) text = decimal(text);
        else check(["n", "str", "d", "b", "e"].includes(cell.type));
        if (cell.type === "n" && text && dateStyles.has(cell.style)) {
          check(/^\d+(?:\.\d+)?$/.test(text));
          const serial = Number(text);
          // Reject Excel's fictitious 1900-02-29 rather than silently changing its date.
          check(
            Number.isFinite(serial) &&
              serial >= 0 &&
              serial < 2958466 &&
              (date1904 || Math.floor(serial) !== 60),
          );
          const date = new Date(
            Date.UTC(
              date1904 ? 1904 : 1899,
              date1904 ? 0 : 11,
              date1904 ? 1 : 31,
            ) +
              (Math.floor(serial) - (!date1904 && serial >= 60 ? 1 : 0)) *
                86400000,
          );
          text = date.toISOString().slice(0, 10);
        }
        if (
          cell.type === "d" &&
          /^\d{4}-\d{2}-\d{2}(?:T00:00:00(?:\.000)?Z)?$/.test(text)
        )
          text = text.slice(0, 10);
        if (cell.type === "e")
          warnings.add(
            "El libro contiene celdas con error de Excel; requieren corrección.",
          );
        if (cell.hasFormula)
          warnings.add(
            "Hay fórmulas: solo se muestra su valor almacenado, sin ejecutarlas. Las fórmulas sin resultado requieren corrección manual.",
          );
        let row = rows.get(cell.row);
        if (!row) {
          row = new Map();
          rows.set(cell.row, row);
          totalRows++;
          check(totalRows <= EXCEL_LIMITS.rows);
        }
        check(!row.has(cell.column));
        totalCells++;
        check(totalCells <= EXCEL_LIMITS.cells);
        row.set(cell.column, {
          row: cell.row,
          column: cell.column,
          columnIndex: cell.column,
          text,
          literal: cell.hasFormula
            ? "=" + cell.formula
            : cell.type === "s" || cell.type === "inlineStr"
              ? text
              : cell.value,
          ...(cell.hasFormula ? { formula: true } : {}),
        });
      },
    });
    let columns = 0;
    for (const row of rows.values())
      for (const column of row.keys()) columns = Math.max(columns, column);
    return {
      id: def.id,
      name: def.name,
      warnings: [...warnings],
      table: {
        hadBom: false,
        separator: "\t" as const,
        rows: [...rows.entries()]
          .sort(([a], [b]) => a - b)
          .map(([row, cells]) => ({
            row,
            cells: Array.from(
              { length: columns },
              (_, i) =>
                cells.get(i + 1) ?? {
                  row,
                  column: i + 1,
                  columnIndex: i + 1,
                  text: "",
                  literal: "",
                },
            ),
          })),
      },
    };
  });
  return {
    sheets,
    warnings: [
      "Solo se interpretan valores de celdas; se omiten dibujos, gráficos, formatos visuales y comentarios. Ninguna fórmula se ejecuta.",
    ],
  };
}
