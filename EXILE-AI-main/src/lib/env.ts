/**
 * Build-time configuration validation.
 *
 * Supabase settings come from Vite env vars (see .env.example). We never invent
 * defaults: if a value is missing or malformed the caller gets an error that names
 * the variable and says where to set it, instead of a cryptic library failure.
 */
export interface EnvSource {
  VITE_SUPABASE_URL?: string;
  VITE_SUPABASE_PUBLISHABLE_KEY?: string;
  [key: string]: unknown;
}

export interface SupabaseConfig {
  url: string;
  publishableKey: string;
}

export class EnvConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(
      `Supabase is not configured: ${problems.join("; ")}. ` +
        "Copy .env.example to .env and set these values (Supabase dashboard → Project Settings → API), then restart. " +
        "Features that only use the local EXILE server work without Supabase.",
    );
    this.name = "EnvConfigError";
    this.problems = problems;
  }
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** Returns the problems with the Supabase configuration; an empty array means it is usable. */
export function supabaseConfigProblems(env: EnvSource): string[] {
  const problems: string[] = [];
  const url = str(env.VITE_SUPABASE_URL);
  const key = str(env.VITE_SUPABASE_PUBLISHABLE_KEY);
  if (!url) problems.push("VITE_SUPABASE_URL is missing");
  else {
    try {
      const u = new URL(url);
      if (u.protocol !== "https:" && u.protocol !== "http:") problems.push("VITE_SUPABASE_URL must be an http(s) URL");
    } catch {
      problems.push("VITE_SUPABASE_URL is not a valid URL");
    }
  }
  if (!key) problems.push("VITE_SUPABASE_PUBLISHABLE_KEY is missing");
  else if (/service_role/i.test(key)) problems.push("VITE_SUPABASE_PUBLISHABLE_KEY looks like a service-role key; never ship one to the browser");
  return problems;
}

export function isSupabaseConfigured(env: EnvSource): boolean {
  return supabaseConfigProblems(env).length === 0;
}

export function getSupabaseConfig(env: EnvSource): SupabaseConfig {
  const problems = supabaseConfigProblems(env);
  if (problems.length) throw new EnvConfigError(problems);
  return { url: str(env.VITE_SUPABASE_URL), publishableKey: str(env.VITE_SUPABASE_PUBLISHABLE_KEY) };
}
