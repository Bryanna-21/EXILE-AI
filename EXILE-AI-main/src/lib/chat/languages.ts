/** Language identification for code blocks: canonical id, display label and file extension. */

export interface LanguageInfo {
  id: string;
  label: string;
  ext: string;
}

const TABLE: Record<string, LanguageInfo> = {
  text: { id: "text", label: "Plain text", ext: "txt" },
  javascript: { id: "javascript", label: "JavaScript", ext: "js" },
  typescript: { id: "typescript", label: "TypeScript", ext: "ts" },
  jsx: { id: "jsx", label: "JSX", ext: "jsx" },
  tsx: { id: "tsx", label: "TSX", ext: "tsx" },
  python: { id: "python", label: "Python", ext: "py" },
  html: { id: "html", label: "HTML", ext: "html" },
  css: { id: "css", label: "CSS", ext: "css" },
  json: { id: "json", label: "JSON", ext: "json" },
  bash: { id: "bash", label: "Shell", ext: "sh" },
  sql: { id: "sql", label: "SQL", ext: "sql" },
  java: { id: "java", label: "Java", ext: "java" },
  c: { id: "c", label: "C", ext: "c" },
  cpp: { id: "cpp", label: "C++", ext: "cpp" },
  csharp: { id: "csharp", label: "C#", ext: "cs" },
  go: { id: "go", label: "Go", ext: "go" },
  rust: { id: "rust", label: "Rust", ext: "rs" },
  php: { id: "php", label: "PHP", ext: "php" },
  yaml: { id: "yaml", label: "YAML", ext: "yml" },
  markdown: { id: "markdown", label: "Markdown", ext: "md" },
  xml: { id: "xml", label: "XML", ext: "xml" },
  powershell: { id: "powershell", label: "PowerShell", ext: "ps1" },
  ruby: { id: "ruby", label: "Ruby", ext: "rb" },
  kotlin: { id: "kotlin", label: "Kotlin", ext: "kt" },
  swift: { id: "swift", label: "Swift", ext: "swift" },
};

const ALIASES: Record<string, string> = {
  js: "javascript", mjs: "javascript", cjs: "javascript", node: "javascript",
  ts: "typescript", py: "python", python3: "python",
  sh: "bash", shell: "bash", zsh: "bash", console: "bash", terminal: "bash",
  yml: "yaml", md: "markdown", "c++": "cpp", cxx: "cpp", cc: "cpp", "c#": "csharp", cs: "csharp",
  golang: "go", rs: "rust", htm: "html", ps1: "powershell", pwsh: "powershell", rb: "ruby", kt: "kotlin",
  plaintext: "text", txt: "text", "": "",
};

/** Resolve the language of a block from its fence hint, falling back to light content checks. */
export function languageInfo(hint: string, code = ""): LanguageInfo {
  const key = hint.trim().toLowerCase();
  const id = ALIASES[key] ?? key;
  if (TABLE[id]) return TABLE[id];

  if (key && !TABLE[id]) {
    // Unknown but named language: show its name honestly, keep a safe extension.
    const ext = /^[a-z0-9]{1,6}$/.test(key) ? key : "txt";
    return { id: "text", label: hint.trim().slice(0, 24), ext };
  }

  const head = code.trimStart();
  if (/^#!.*\b(ba|z)?sh\b/.test(head)) return TABLE.bash;
  if (/^<!doctype\s+html|^<html[\s>]/i.test(head)) return TABLE.html;
  if (/^[{[]/.test(head)) {
    try {
      JSON.parse(code);
      return TABLE.json;
    } catch {
      /* not JSON */
    }
  }
  return TABLE.text;
}
