/**
 * A small, dependency-free Markdown subset parser shared by every document generator.
 * Supported: headings (1-4 hashes), paragraphs, dash/star/plus and numbered lists
 * (with indentation), pipe tables, fenced code, quotes, horizontal rules, and inline
 * bold, italic, code and [text](url) links. Anything else is kept as literal text.
 */

export const MAX_CONTENT_CHARS = 200_000;

/** Remove an outer code fence the model may have wrapped around the whole document. */
export function stripOuterFence(text) {
  const t = String(text ?? "").replace(/\r\n?/g, "\n").trim();
  const m = /^```[a-z0-9_-]*\s*\n([\s\S]*?)\n```$/i.exec(t);
  return m ? m[1].trim() : t;
}

export function cleanContent(content, { max = MAX_CONTENT_CHARS } = {}) {
  const text = stripOuterFence(content);
  if (!text.trim()) {
    const err = new Error("The document content is empty.");
    err.code = "INVALID_INPUT";
    throw err;
  }
  return text.slice(0, max);
}

const SAFE_URL = /^(?:https?:\/\/|mailto:)[^\s<>"']+$/i;
export const isSafeUrl = (url) => SAFE_URL.test(String(url || "").trim());

export function parseInline(text) {
  const runs = [];
  const s = String(text ?? "");
  let i = 0;
  let buf = "";
  const flush = () => { if (buf) { runs.push({ text: buf }); buf = ""; } };
  while (i < s.length) {
    const rest = s.slice(i);
    let m;
    if ((m = /^`([^`\n]+)`/.exec(rest))) {
      flush(); runs.push({ text: m[1], code: true }); i += m[0].length; continue;
    }
    if ((m = /^(\*\*|__)(?=\S)([\s\S]+?)(?<=\S)\1/.exec(rest))) {
      flush(); for (const r of parseInline(m[2])) runs.push({ ...r, bold: true }); i += m[0].length; continue;
    }
    if ((m = /^(\*|_)(?=\S)([^*_\n]+?)(?<=\S)\1(?![A-Za-z0-9])/.exec(rest)) && (i === 0 || !/[A-Za-z0-9]/.test(s[i - 1]))) {
      flush(); for (const r of parseInline(m[2])) runs.push({ ...r, italic: true }); i += m[0].length; continue;
    }
    if ((m = /^\[([^\]\n]+)\]\(([^)\s]+)\)/.exec(rest))) {
      flush();
      if (isSafeUrl(m[2])) runs.push({ text: m[1], href: m[2] });
      else runs.push({ text: `${m[1]} (${m[2]})` });
      i += m[0].length; continue;
    }
    buf += s[i];
    i += 1;
  }
  flush();
  return runs.length ? runs : [{ text: "" }];
}

export const runsToText = (runs) => runs.map((r) => r.text).join("");

function splitTableRow(line) {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|")) t = t.slice(0, -1);
  return t.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, "|").trim());
}

const isTableDivider = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line) && line.includes("-");

export function parseMarkdown(markdown) {
  const lines = cleanContent(markdown).split("\n");
  const blocks = [];
  let i = 0;
  let para = [];
  const flushPara = () => {
    if (para.length) {
      blocks.push({ type: "paragraph", runs: parseInline(para.join(" ")) });
      para = [];
    }
  };

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) { flushPara(); i++; continue; }

    let m;
    if ((m = /^(```|~~~)\s*([A-Za-z0-9_+-]*)\s*$/.exec(trimmed))) {
      flushPara();
      const fence = m[1];
      const code = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence)) { code.push(lines[i]); i++; }
      i++;
      blocks.push({ type: "code", lang: m[2] || "", text: code.join("\n") });
      continue;
    }
    if ((m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(trimmed))) {
      flushPara();
      blocks.push({ type: "heading", level: Math.min(m[1].length, 4), runs: parseInline(m[2]) });
      i++; continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) { flushPara(); blocks.push({ type: "hr" }); i++; continue; }
    if (trimmed.startsWith("|") && i + 1 < lines.length && isTableDivider(lines[i + 1])) {
      flushPara();
      const header = splitTableRow(trimmed).map(parseInline);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        const cells = splitTableRow(lines[i]).map(parseInline);
        while (cells.length < header.length) cells.push([{ text: "" }]);
        rows.push(cells.slice(0, header.length));
        i++;
      }
      blocks.push({ type: "table", header, rows });
      continue;
    }
    if (/^>\s?/.test(trimmed)) {
      flushPara();
      const quote = [];
      while (i < lines.length && /^>\s?/.test(lines[i].trim())) { quote.push(lines[i].trim().replace(/^>\s?/, "")); i++; }
      blocks.push({ type: "quote", runs: parseInline(quote.join(" ")) });
      continue;
    }
    if (/^([-*+]|\d+[.)])\s+/.test(trimmed)) {
      flushPara();
      const ordered = /^\d/.test(trimmed);
      const items = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
        const indent = lines[i].match(/^\s*/)[0].replace(/\t/g, "    ").length;
        // A top-level marker of the other kind starts a new list.
        if (indent < 2 && /^\s*\d/.test(lines[i]) !== ordered) break;
        const body = lines[i].trim().replace(/^([-*+]|\d+[.)])\s+/, "");
        items.push({ level: Math.min(2, Math.floor(indent / 2)), runs: parseInline(body) });
        i++;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }
    para.push(trimmed);
    i++;
  }
  flushPara();
  return blocks;
}

/** Plain text rendering of blocks (used for txt previews, checks and PDF fallbacks). */
export function blocksToPlainText(blocks) {
  const out = [];
  for (const b of blocks) {
    if (b.type === "heading" || b.type === "paragraph" || b.type === "quote") out.push(runsToText(b.runs), "");
    else if (b.type === "list") {
      b.items.forEach((it, n) => out.push(`${"  ".repeat(it.level)}${b.ordered ? `${n + 1}.` : "-"} ${runsToText(it.runs)}`));
      out.push("");
    } else if (b.type === "table") {
      out.push(b.header.map(runsToText).join(" | "));
      for (const r of b.rows) out.push(r.map(runsToText).join(" | "));
      out.push("");
    } else if (b.type === "code") out.push(b.text, "");
    else if (b.type === "hr") out.push("-----", "");
  }
  return out.join("\n").trim();
}

/** The first H1/H2 heading, used as a default document title. */
export function firstHeading(blocks) {
  const h = blocks.find((b) => b.type === "heading");
  return h ? runsToText(h.runs) : null;
}

/** Heuristic WinAnsi-safe text for the standard PDF fonts. */
export function toWinAnsi(input) {
  const map = {
    "‘": "‘", "’": "’", "“": "“", "”": "”",
    "–": "–", "—": "—", "•": "•", "…": "…",
    " ": " ", "→": "->", "←": "<-", "✓": "v", "✔": "v", "✗": "x",
    "−": "-", " ": " ", "​": "", "﻿": "", "\t": "    ", "\r": "",
  };
  return String(input).replace(/[^\n\x20-\x7e¡-ÿ]/gu, (ch) => {
    if (Object.hasOwn(map, ch)) return map[ch];
    const norm = ch.normalize("NFKD").replace(/[̀-ͯ]/g, "");
    return /^[\x20-\x7e]+$/.test(norm) ? norm : "?";
  });
}
