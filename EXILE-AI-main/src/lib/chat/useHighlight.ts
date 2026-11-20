import { useEffect, useMemo, useState } from "react";
import type { Segment } from "./highlight";

// The syntax-highlighting parsers are large (~500 KB). Load them on first use, not at startup.
type HighlightModule = typeof import("./highlight");
let highlightModule: HighlightModule | null = null;
let highlightLoading: Promise<HighlightModule> | null = null;

/** Plain text immediately; highlighted once the highlighter chunk has loaded (then cached for every caller). */
export function useHighlightedSegments(code: string, lang: string, enabled = true): Segment[] {
  const [mod, setMod] = useState<HighlightModule | null>(highlightModule);
  useEffect(() => {
    if (mod || !code || !enabled) return;
    highlightLoading ??= import("./highlight").then((m) => (highlightModule = m));
    let live = true;
    highlightLoading.then((m) => { if (live) setMod(m); }).catch(() => { highlightLoading = null; });
    return () => { live = false; };
  }, [mod, code, enabled]);
  return useMemo(() => (mod && enabled ? mod.highlightCode(code, lang) : [{ text: code, cls: "" }]), [mod, code, lang, enabled]);
}
