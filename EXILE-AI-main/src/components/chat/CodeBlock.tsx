import { useMemo, useState } from "react";
import { Check, Copy, Download, Maximize2 } from "lucide-react";
import { toast } from "sonner";
import CodeCanvas from "@/components/CodeCanvas";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { languageInfo } from "@/lib/chat/languages";
import { highlightCode } from "@/lib/chat/highlight";
import { copyText, downloadText } from "@/lib/chat/dom";
import { safeFilename } from "@/lib/chat/files";

interface Props {
  code: string;
  language: string;
  filename: string | null;
  /** False while the closing fence has not arrived yet (reply still streaming). */
  complete: boolean;
}

const btn =
  "inline-flex h-7 items-center gap-1 rounded-md border border-cyan-500/30 px-2 text-[11px] text-cyan-100 transition hover:bg-cyan-500/15 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300";

/** A code block with language label, highlighting, and a Copy code button that copies only the code. */
const CodeBlock = ({ code, language, filename, complete }: Props) => {
  const info = useMemo(() => languageInfo(language, code), [language, code]);
  const segments = useMemo(() => highlightCode(code, info.id), [code, info.id]);
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const onCopy = async () => {
    if (await copyText(code)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } else {
      toast.error("Copy was blocked by the browser. Select the code and copy it manually.");
    }
  };
  const downloadName = safeFilename(filename ?? `snippet.${info.ext}`);

  return (
    <div className="chat-code my-2 overflow-hidden rounded-lg border border-cyan-500/25 bg-slate-950/90 text-left" data-testid="code-block" data-language={info.id}>
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5 border-b border-cyan-500/20 bg-slate-900/80 px-2.5 py-1.5">
        <div className="flex min-w-0 max-w-full items-center gap-2 text-[11px] text-cyan-200/80">
          <span className="shrink-0 whitespace-nowrap rounded bg-cyan-500/15 px-1.5 py-0.5 font-medium tracking-wide text-cyan-200" data-testid="code-language">{info.label}</span>
          {filename && <span className="truncate text-slate-300/80">{filename}</span>}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button type="button" className={btn} onClick={() => void onCopy()} disabled={!complete} aria-label="Copy code" data-testid="copy-code">
            {copied ? <Check className="h-3.5 w-3.5 text-emerald-300" /> : <Copy className="h-3.5 w-3.5" />}
            <span>{copied ? "Copied" : "Copy code"}</span>
          </button>
          <button type="button" className={btn} onClick={() => downloadText(code, downloadName)} disabled={!complete} aria-label={`Download ${downloadName}`} title={`Download ${downloadName}`}>
            <Download className="h-3.5 w-3.5" />
          </button>
          <button type="button" className={btn} onClick={() => setExpanded(true)} disabled={!complete} aria-label="Open in code editor" title="Open in editor">
            <Maximize2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <pre className="chat-code-body m-0 max-h-[26rem] overflow-auto p-3 text-[12.5px] leading-5 text-slate-100" tabIndex={0} aria-label={`${info.label} code`}>
        <code className="block whitespace-pre font-mono">
          {segments.map((s, i) => (s.cls ? <span key={i} className={s.cls}>{s.text}</span> : s.text))}
        </code>
      </pre>
      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent className="max-h-[90vh] w-[95vw] max-w-4xl overflow-auto border-cyan-500/30 bg-slate-950 p-3 text-cyan-100">
          <DialogHeader>
            <DialogTitle className="text-sm tracking-widest">{filename ?? info.label}</DialogTitle>
            <DialogDescription className="text-[11px] text-slate-400">Editable copy. Changes here do not alter the message.</DialogDescription>
          </DialogHeader>
          <CodeCanvas code={code} language={info.id} filename={downloadName} />
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default CodeBlock;
