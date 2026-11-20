/**
 * Data generators: CSV, JSON, XML and XLSX, each with a validator that reads the
 * produced file back and compares it with what was requested.
 */
import ExcelJS from "exceljs";
import { XMLBuilder, XMLParser, XMLValidator } from "fast-xml-parser";
import { parseMarkdown, runsToText, stripOuterFence } from "./markdown.mjs";
import { invalid } from "./errors.mjs";
import { validateOoxml } from "./documents.mjs";
import { convertWithOffice } from "./render.mjs";

const MAX_ROWS = 50_000;
const MAX_COLS = 200;
const MAX_CELLS = 1_000_000;

// ------------------------------------------------------------------ CSV core

export function parseCsv(text, delimiter = ",") {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  let i = 0;
  const s = String(text).replace(/^﻿/, "");
  while (i < s.length) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"' && field === "") { quoted = true; i++; continue; }
    if (ch === delimiter) { row.push(field); field = ""; i++; continue; }
    if (ch === "\r") { i++; continue; }
    if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
    field += ch; i++;
  }
  if (quoted) throw invalid("CSV has an unterminated quoted field.");
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

export function sniffDelimiter(text) {
  const lines = String(text).replace(/^﻿/, "").split(/\r?\n/).filter(Boolean).slice(0, 8);
  let best = ",";
  let bestScore = -1;
  for (const d of [",", ";", "\t", "|"]) {
    let counts;
    try { counts = parseCsv(lines.join("\n"), d).map((r) => r.length); } catch { continue; }
    if (!counts.length || counts[0] < 2) continue;
    const consistent = counts.filter((c) => c === counts[0]).length;
    const score = consistent * 100 + counts[0];
    if (score > bestScore) { best = d; bestScore = score; }
  }
  return best;
}

const NUMERIC = /^[-+]?(\d+([.,]\d+)*|\.\d+)(e[-+]?\d+)?%?$/i;

/** Neutralise spreadsheet formula injection in text cells. */
export function neutralizeFormula(value) {
  if (typeof value !== "string" || !value) return value;
  if (/^[=+\-@\t\r]/.test(value) && !NUMERIC.test(value.trim())) return `'${value}`;
  return value;
}

export function serializeCsv(rows, { delimiter = ",", bom = false, allowFormulas = false } = {}) {
  const q = (cell) => {
    let v = cell === null || cell === undefined ? "" : cell instanceof Date ? cell.toISOString() : String(cell);
    if (!allowFormulas) v = neutralizeFormula(v);
    return /["\n\r]/.test(v) || v.includes(delimiter) || /^\s|\s$/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  };
  const text = rows.map((r) => r.map(q).join(delimiter)).join("\r\n") + "\r\n";
  return Buffer.from((bom ? "﻿" : "") + text, "utf8");
}

/** Turn any supported tabular input into { header?, rows } of plain arrays. */
function tabular(spec) {
  let rows;
  let repaired = 0;
  if (typeof spec.content === "string") {
    const text = stripOuterFence(spec.content);
    if (!text.trim()) throw invalid("The CSV content is empty.");
    rows = parseCsv(text, spec.delimiter || sniffDelimiter(text));
  } else if (Array.isArray(spec.rows)) {
    rows = spec.rows;
    if (rows.length && rows.every((r) => r && typeof r === "object" && !Array.isArray(r))) {
      const columns = Array.isArray(spec.columns) && spec.columns.length ? spec.columns.map(String) : [...new Set(rows.flatMap((r) => Object.keys(r)))];
      rows = [columns, ...rows.map((r) => columns.map((c) => r[c] ?? ""))];
    } else if (rows.some((r) => !Array.isArray(r))) {
      throw invalid("rows must be an array of arrays or an array of objects.");
    } else if (Array.isArray(spec.columns) && spec.columns.length) {
      rows = [spec.columns.map(String), ...rows];
    }
  } else {
    throw invalid("Provide either `content` (CSV text) or `rows`.");
  }
  if (!rows.length) throw invalid("There are no rows to write.");
  if (rows.length > MAX_ROWS) throw invalid(`At most ${MAX_ROWS} rows are supported.`);
  const width = Math.max(...rows.map((r) => r.length));
  if (width < 1 || width > MAX_COLS) throw invalid(`Tables must have between 1 and ${MAX_COLS} columns.`);
  if (rows.length * width > MAX_CELLS) throw invalid(`At most ${MAX_CELLS} cells are supported.`);
  // Model-written CSV is often ragged. Pad short rows; refuse rows wider than the header.
  const headerWidth = rows[0].length;
  const out = rows.map((r) => {
    if (r.length > headerWidth && typeof spec.content === "string") {
      throw invalid("A CSV row has more fields than the header row.");
    }
    if (r.length < width) { repaired++; return [...r, ...Array(width - r.length).fill("")]; }
    return r;
  });
  return { rows: out, repaired, delimiter: spec.delimiter || (typeof spec.content === "string" ? sniffDelimiter(spec.content) : ",") };
}

async function generateCsv(spec) {
  const t = tabular(spec);
  const bom = spec.bom === true;
  const buffer = serializeCsv(t.rows, { delimiter: ",", bom, allowFormulas: false });
  return { buffer, metadata: { rows: t.rows.length, columns: t.rows[0].length, paddedRows: t.repaired } };
}

async function validateCsv(buffer, spec) {
  const checks = [];
  const failures = [];
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    checks.push("Valid UTF-8");
  } catch {
    return { checks, failures: ["CSV is not valid UTF-8."], skipped: [] };
  }
  let rows;
  try {
    rows = parseCsv(text, ",");
  } catch (error) {
    return { checks, failures: [error.message], skipped: [] };
  }
  if (!rows.length) failures.push("CSV has no rows.");
  else {
    checks.push(`CSV parses (${rows.length} rows)`);
    const widths = new Set(rows.map((r) => r.length));
    if (widths.size !== 1) failures.push(`Inconsistent column counts: ${[...widths].join(", ")}.`);
    else checks.push(`Every row has ${[...widths][0]} columns`);
  }
  if (spec) {
    try {
      const expected = tabular(spec);
      if (rows.length !== expected.rows.length) failures.push(`Expected ${expected.rows.length} rows but found ${rows.length}.`);
      else checks.push("Row count matches the request");
    } catch { /* the spec itself was checked at generation time */ }
  }
  const risky = rows.flat().filter((c) => /^[=+\-@]/.test(c) && !NUMERIC.test(c.trim()));
  if (risky.length) failures.push("CSV contains cells that spreadsheet software would run as formulas.");
  else checks.push("No formula-injection cells");
  return { checks, failures, skipped: [] };
}

// ---------------------------------------------------------------------- JSON

export function validateJsonSchema(value, schema, path = "$", errors = []) {
  if (!schema || typeof schema !== "object") return errors;
  const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);
  if (schema.type !== undefined) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = typeOf(value);
    const ok = allowed.some((t) => t === actual || (t === "number" && actual === "integer"));
    if (!ok) { errors.push(`${path}: expected ${allowed.join("|")}, found ${actual}`); return errors; }
  }
  if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) errors.push(`${path}: not one of the allowed values`);
  if (schema.const !== undefined && JSON.stringify(schema.const) !== JSON.stringify(value)) errors.push(`${path}: does not equal the required constant`);
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}: shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path}: longer than ${schema.maxLength}`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: below ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: above ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: more than ${schema.maxItems} items`);
    if (schema.items) value.slice(0, 1000).forEach((v, i) => validateJsonSchema(v, schema.items, `${path}[${i}]`, errors));
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) errors.push(`${path}: missing required "${key}"`);
    const props = schema.properties || {};
    for (const [key, sub] of Object.entries(props)) if (Object.hasOwn(value, key)) validateJsonSchema(value[key], sub, `${path}.${key}`, errors);
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) if (!Object.hasOwn(props, key)) errors.push(`${path}: unexpected property "${key}"`);
    }
  }
  return errors.slice(0, 50);
}

function jsonValue(spec) {
  if (spec.data !== undefined) return spec.data;
  if (typeof spec.content === "string") {
    try {
      return JSON.parse(stripOuterFence(spec.content));
    } catch (error) {
      throw invalid(`The JSON content does not parse: ${error.message}`);
    }
  }
  throw invalid("Provide `data` or `content` for a JSON file.");
}

async function generateJson(spec) {
  const value = jsonValue(spec);
  if (spec.schema) {
    const errors = validateJsonSchema(value, spec.schema);
    if (errors.length) throw invalid(`The data does not match the requested schema: ${errors.slice(0, 5).join("; ")}`);
  }
  const text = JSON.stringify(value, null, 2);
  if (text === undefined) throw invalid("The value cannot be represented as JSON.");
  return { buffer: Buffer.from(`${text}\n`, "utf8"), metadata: { topLevel: Array.isArray(value) ? "array" : typeof value } };
}

async function validateJson(buffer, spec) {
  const checks = [];
  const failures = [];
  let parsed;
  try {
    parsed = JSON.parse(buffer.toString("utf8"));
    checks.push("JSON parses");
  } catch (error) {
    return { checks, failures: [`JSON does not parse: ${error.message}`], skipped: [] };
  }
  if (spec?.schema) {
    const errors = validateJsonSchema(parsed, spec.schema);
    if (errors.length) failures.push(...errors.slice(0, 5)); else checks.push("Matches the requested schema");
  }
  if (spec) {
    try {
      if (JSON.stringify(parsed) !== JSON.stringify(jsonValue(spec))) failures.push("Stored JSON differs from the requested data.");
      else checks.push("Round trip equals the requested data");
    } catch { /* spec problems surface at generation time */ }
  }
  return { checks, failures, skipped: [] };
}

// ----------------------------------------------------------------------- XML

const XML_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;

function assertXmlNames(node, depth = 0) {
  if (depth > 40) throw invalid("XML data is nested too deeply.");
  if (node && typeof node === "object" && !Array.isArray(node)) {
    for (const [k, v] of Object.entries(node)) {
      if (k === "_text") continue;
      const name = k.startsWith("@") ? k.slice(1) : k;
      if (!XML_NAME.test(name)) throw invalid(`"${k}" is not a valid XML name.`);
      assertXmlNames(v, depth + 1);
    }
  } else if (Array.isArray(node)) node.forEach((n) => assertXmlNames(n, depth + 1));
}

const xmlParserOptions = { ignoreAttributes: false, attributeNamePrefix: "@", textNodeName: "_text", parseTagValue: false, parseAttributeValue: false, processEntities: true, trimValues: true };

function xmlText(spec) {
  const declaration = '<?xml version="1.0" encoding="UTF-8"?>\n';
  if (typeof spec.content === "string") {
    const raw = stripOuterFence(spec.content).replace(/^﻿/, "").trim();
    if (/<!DOCTYPE|<!ENTITY/i.test(raw)) throw invalid("XML with DOCTYPE or ENTITY declarations is not allowed.");
    const ok = XMLValidator.validate(raw);
    if (ok !== true) throw invalid(`The XML content is not well-formed: ${ok.err.msg}`);
    return raw.startsWith("<?xml") ? `${raw}\n` : `${declaration}${raw}\n`;
  }
  if (spec.data === undefined) throw invalid("Provide `data` or `content` for an XML file.");
  const root = String(spec.root || "root");
  if (!XML_NAME.test(root)) throw invalid("The XML root element name is not valid.");
  assertXmlNames(spec.data);
  const builder = new XMLBuilder({ ignoreAttributes: false, attributeNamePrefix: "@", textNodeName: "_text", format: true, indentBy: "  ", suppressEmptyNode: true, processEntities: true });
  return `${declaration}${builder.build({ [root]: spec.data })}`;
}

async function generateXml(spec) {
  const text = xmlText(spec);
  return { buffer: Buffer.from(text, "utf8"), metadata: { characters: text.length } };
}

async function validateXml(buffer, spec) {
  const checks = [];
  const failures = [];
  const text = buffer.toString("utf8");
  const ok = XMLValidator.validate(text);
  if (ok !== true) return { checks, failures: [`XML is not well-formed: ${ok.err.msg}`], skipped: [] };
  checks.push("XML is well-formed");
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) failures.push("XML contains a DOCTYPE or ENTITY declaration."); else checks.push("No DOCTYPE or ENTITY declarations");
  const parsed = new XMLParser(xmlParserOptions).parse(text);
  const roots = Object.keys(parsed).filter((k) => k !== "?xml");
  if (roots.length !== 1) failures.push(`XML must have exactly one root element (found ${roots.length}).`); else checks.push(`Single root element <${roots[0]}>`);
  if (spec?.root && roots[0] !== spec.root && spec.data !== undefined) failures.push("XML root element does not match the request.");
  return { checks, failures, skipped: [] };
}

// ---------------------------------------------------------------------- XLSX

const SAFE_FUNCTIONS = new Set([
  "SUM", "AVERAGE", "MIN", "MAX", "COUNT", "COUNTA", "ROUND", "ROUNDUP", "ROUNDDOWN", "IF", "ABS", "AND", "OR", "NOT",
  "IFERROR", "SUMIF", "COUNTIF", "AVERAGEIF", "MEDIAN", "PRODUCT", "CONCAT", "LEN", "UPPER", "LOWER", "TRIM", "TODAY", "NOW",
]);

export function assertSafeFormula(formula) {
  const f = String(formula).replace(/^=/, "").trim();
  if (!f || f.length > 200) throw invalid("A formula is empty or too long.");
  if (!/^[A-Za-z0-9_ .,:;+\-*/^%<>=()$"&']+$/.test(f)) throw invalid("A formula contains characters that are not allowed.");
  for (const m of f.matchAll(/([A-Za-z_][A-Za-z0-9_.]*)\s*\(/g)) {
    if (!SAFE_FUNCTIONS.has(m[1].toUpperCase())) throw invalid(`The function ${m[1].toUpperCase()} is not allowed in generated formulas.`);
  }
  return f;
}

function sanitizeSheetName(name, used) {
  let base = String(name || "Sheet").replace(/[\\/?*[\]:]/g, "_").replace(/^'+|'+$/g, "").trim().slice(0, 31) || "Sheet";
  let candidate = base;
  let n = 2;
  while (used.has(candidate.toLowerCase())) { candidate = `${base.slice(0, 31 - String(n).length - 1)}_${n}`; n++; }
  used.add(candidate.toLowerCase());
  return candidate;
}

/** Normalize the many accepted workbook inputs into { sheets: [{ name, rows, header, formulas }] }. */
export function prepareWorkbook(spec) {
  const allowFormulas = spec.allowFormulas === true;
  const used = new Set();
  let rawSheets;
  if (Array.isArray(spec.sheets)) rawSheets = spec.sheets;
  else if (typeof spec.content === "string") {
    const text = stripOuterFence(spec.content);
    const tables = text.includes("|") ? parseMarkdown(text).filter((b) => b.type === "table") : [];
    if (tables.length) {
      rawSheets = tables.map((t, i) => ({ name: `Table ${i + 1}`, rows: [t.header.map(runsToText), ...t.rows.map((r) => r.map(runsToText))] }));
    } else {
      rawSheets = [{ name: spec.title || "Sheet1", content: text }];
    }
  } else if (Array.isArray(spec.rows)) rawSheets = [{ name: spec.title || "Sheet1", rows: spec.rows, columns: spec.columns }];
  else throw invalid("Provide `sheets`, `rows` or `content` for a workbook.");
  if (!rawSheets.length || rawSheets.length > 50) throw invalid("A workbook needs between 1 and 50 sheets.");

  let cells = 0;
  const sheets = rawSheets.map((s, idx) => {
    const t = tabular(s);
    const rows = t.rows.map((r) => r.map((cell) => {
      if (cell && typeof cell === "object" && !(cell instanceof Date)) {
        if (typeof cell.formula === "string") {
          if (!allowFormulas) throw invalid("Formulas are disabled for this request. Set allowFormulas to true to include them.");
          return { formula: assertSafeFormula(cell.formula) };
        }
        throw invalid("Cell objects must be { formula } objects.");
      }
      return cell;
    }));
    cells += rows.length * rows[0].length;
    if (cells > MAX_CELLS) throw invalid(`At most ${MAX_CELLS} cells are supported per workbook.`);
    return {
      name: sanitizeSheetName(s.name || `Sheet${idx + 1}`, used),
      rows,
      header: s.header !== false,
      numFmt: Array.isArray(s.numFmt) ? s.numFmt : [],
    };
  });
  return { sheets, allowFormulas };
}

const isNumericText = (v) => typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim()) && v.trim().length < 16;

async function generateXlsx(spec) {
  const { sheets } = prepareWorkbook(spec);
  const wb = new ExcelJS.Workbook();
  wb.creator = String(spec.author || "EXILE AI").slice(0, 100);
  wb.title = String(spec.title || "EXILE AI workbook").slice(0, 200);
  wb.created = new Date();
  wb.calcProperties.fullCalcOnLoad = true;
  let formulas = 0;
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name);
    const widths = [];
    s.rows.forEach((row, r) => {
      const wsRow = ws.getRow(r + 1);
      row.forEach((value, c) => {
        const cell = wsRow.getCell(c + 1);
        let v = value;
        if (v && typeof v === "object" && "formula" in v) { formulas++; cell.value = { formula: v.formula }; }
        else {
          // CSV-style input often carries numbers as text; store them as numbers when unambiguous.
          if (isNumericText(v) && !(r === 0 && s.header)) v = Number(v);
          cell.value = v === "" ? null : v;
        }
        const len = v && typeof v === "object" && "formula" in v ? 10 : String(v ?? "").length;
        widths[c] = Math.max(widths[c] || 8, Math.min(60, len + 2));
        if (r > 0 && s.numFmt[c] && /^[0#.,%$ "A-Za-z\-/:]{1,40}$/.test(s.numFmt[c])) cell.numFmt = s.numFmt[c];
      });
      if (r === 0 && s.header) {
        wsRow.font = { bold: true };
        wsRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE6EDF7" } };
      }
    });
    widths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });
    if (s.header && s.rows.length > 1) {
      ws.views = [{ state: "frozen", ySplit: 1 }];
      ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: s.rows[0].length } };
    }
  }
  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  return { buffer, metadata: { sheets: sheets.map((s) => ({ name: s.name, rows: s.rows.length, columns: s.rows[0].length })), formulas } };
}

async function validateXlsx(buffer, spec, ctx) {
  const base = await validateOoxml(buffer, {
    required: ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml"], mainPart: "xl/workbook.xml", ext: "xlsx",
  }, ctx);
  const { checks, failures, skipped } = base;
  if (failures.length) return { checks, failures, skipped };
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer);
    checks.push(`Workbook loads (${wb.worksheets.length} sheet${wb.worksheets.length === 1 ? "" : "s"})`);
  } catch (error) {
    return { checks, failures: [`Workbook could not be opened: ${error.message}`], skipped };
  }
  let expectedFormulas = 0;
  if (spec) {
    let expected;
    try { expected = prepareWorkbook(spec); } catch (error) { return { checks, failures: [error.message], skipped }; }
    if (wb.worksheets.length !== expected.sheets.length) failures.push(`Expected ${expected.sheets.length} sheets but found ${wb.worksheets.length}.`);
    else {
      let mismatches = 0;
      let compared = 0;
      expected.sheets.forEach((s, i) => {
        const ws = wb.worksheets[i];
        if (ws.name !== s.name) failures.push(`Sheet ${i + 1} is named "${ws.name}", expected "${s.name}".`);
        if (ws.actualRowCount !== s.rows.filter((r) => r.some((c) => c !== "" && c !== null && c !== undefined)).length) failures.push(`Sheet "${s.name}" has ${ws.actualRowCount} populated rows, expected a different count.`);
        s.rows.forEach((row, r) => row.forEach((value, c) => {
          if (compared >= 5000) return;
          compared++;
          const cell = ws.getCell(r + 1, c + 1).value;
          if (value && typeof value === "object" && "formula" in value) {
            expectedFormulas++;
            if (!cell || typeof cell !== "object" || (cell.formula ?? "") !== value.formula) mismatches++;
          } else if (value === "" || value === null || value === undefined) {
            if (cell !== null && cell !== undefined && cell !== "") mismatches++;
          } else {
            const want = isNumericText(value) && !(r === 0 && s.header) ? Number(value) : value;
            const got = cell instanceof Date ? cell.toISOString() : cell;
            const wantNorm = want instanceof Date ? want.toISOString() : want;
            if (got !== wantNorm && String(got) !== String(wantNorm)) mismatches++;
          }
        }));
      });
      if (mismatches) failures.push(`${mismatches} cell value${mismatches === 1 ? "" : "s"} differ from the requested data.`);
      else checks.push(`Cell values match the request (${compared} compared)`);
    }
  }
  if (expectedFormulas > 0) {
    checks.push(`${expectedFormulas} formula${expectedFormulas === 1 ? "" : "s"} stored`);
    // Let a real spreadsheet engine evaluate them: any error value means a bad formula.
    const calc = await convertWithOffice(buffer, "xlsx", "csv", ctx.tempDir);
    if (calc.available) {
      const text = calc.output.toString("utf8");
      if (/(^|,)"?#(NAME\?|REF!|VALUE!|DIV\/0!|N\/A|NUM!|NULL!)|Err:\d+/m.test(text)) failures.push("A formula evaluates to a spreadsheet error.");
      else checks.push("Formulas evaluate without errors in LibreOffice");
    } else skipped.push(`formula evaluation (${calc.reason})`);
  }
  return { checks, failures, skipped };
}

export const dataGenerators = {
  csv: { generate: generateCsv, validate: validateCsv },
  json: { generate: generateJson, validate: validateJson },
  xml: { generate: generateXml, validate: validateXml },
  xlsx: { generate: generateXlsx, validate: validateXlsx },
};
