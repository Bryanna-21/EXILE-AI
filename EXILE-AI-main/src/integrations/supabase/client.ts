import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './types';
import { getSupabaseConfig } from '@/lib/env';

// Import the supabase client like this:
// import { supabase } from "@/integrations/supabase/client";
//
// The client is created on first use so the app can start (and run against the local
// EXILE server) without Supabase configured. Using it while unconfigured throws an
// EnvConfigError that names the missing variables; no placeholder values are invented.
let instance: SupabaseClient<Database> | null = null;

function getClient(): SupabaseClient<Database> {
  if (!instance) {
    const { url, publishableKey } = getSupabaseConfig(import.meta.env);
    instance = createClient<Database>(url, publishableKey, {
      auth: {
        storage: localStorage,
        persistSession: true,
        autoRefreshToken: true,
      },
    });
  }
  return instance;
}

export const supabase: SupabaseClient<Database> = new Proxy({} as SupabaseClient<Database>, {
  get(_target, prop) {
    const client = getClient();
    const value = Reflect.get(client, prop, client);
    return typeof value === 'function' ? value.bind(client) : value;
  },
});
