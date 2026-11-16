/**
 * Lightweight syntax highlighting for chat code blocks.
 * Uses the Lezer parsers already shipped with the editor language packs (no editor is mounted),
 * and returns token segments with `tok-*` class names. Languages without a parser render as plain text.
 */

import { highlightTree, classHighlighter } from "@lezer/highlight";
import type { Parser } from "@lezer/common";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { json } from "@codemirror/lang-json";
import { sql } from "@codemirror/lang-sql";
import { java } from "@codemirror/lang-java";
import { cpp } from "@codemirror/lang-cpp";
import { go } from "@codemirror/lang-go";
import { rust } from "@codemirror/lang-rust";
import { yaml } from "@codemirror/lang-yaml";
import { markdown } from "@codemirror/lang-markdown";

export interface Segment {
  text: string;
  cls: string;
}

/** Inputs larger than this are shown plain so a huge paste can never freeze the page. */
export const MAX_HIGHLIGHT_CHARS = 60_000;

const parsers: Record<string, () => Parser> = {
  javascript: () => javascript().language.parser,
  jsx: () => javascript({ jsx: true }).language.parser,
  typescript: () => javascript({ typescript: true }).language.parser,
  tsx: () => javascript({ jsx: true, typescript: true }).language.parser,
  python: () => python().language.parser,
  html: () => html().language.parser,
  xml: () => html().language.parser,
  css: () => css().language.parser,
  json: () => json().language.parser,
  sql: () => sql().language.parser,
  java: () => java().language.parser,
  c: () => cpp().language.parser,
  cpp: () => cpp().language.parser,
  go: () => go().language.parser,
  rust: () => rust().language.parser,
  yaml: () => yaml().language.parser,
  markdown: () => markdown().language.parser,
};

const cache = new Map<string, Parser>();

export const canHighlight = (lang: string) => lang in parsers;

export function highlightCode(code: string, lang: string): Segment[] {
  const make = parsers[lang];
  if (!make || !code || code.length > MAX_HIGHLIGHT_CHARS) return [{ text: code, cls: "" }];
  try {
    let parser = cache.get(lang);
    if (!parser) cache.set(lang, (parser = make()));
    const out: Segment[] = [];
    let pos = 0;
    const push = (to: number, cls: string) => {
      if (to > pos) out.push({ text: code.slice(pos, to), cls });
      pos = to;
    };
    highlightTree(parser.parse(code), classHighlighter, (from, to, cls) => {
      push(from, "");
      push(to, cls);
    });
    push(code.length, "");
    return out;
  } catch {
    return [{ text: code, cls: "" }];
  }
}
