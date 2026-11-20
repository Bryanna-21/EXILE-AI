import type { Provider } from '@supabase/supabase-js';
import { supabase } from './client';

export type OAuthProvider = 'google' | 'apple' | 'microsoft';

// Supabase names Microsoft's provider "azure".
const PROVIDER_MAP: Record<OAuthProvider, Provider> = { google: 'google', apple: 'apple', microsoft: 'azure' };

export interface SignInOptions {
  redirect_uri?: string;
  extraParams?: Record<string, string>;
}

/**
 * Supabase-direct OAuth sign-in (replaces the previous third-party auth adapter).
 * The provider must be enabled in the Supabase dashboard; otherwise Supabase returns an error,
 * which is passed through rather than hidden.
 */
export const auth = {
  signInWithOAuth: async (provider: OAuthProvider, opts?: SignInOptions) => {
    try {
      const { data, error } = await supabase.auth.signInWithOAuth({
        provider: PROVIDER_MAP[provider],
        options: {
          redirectTo: opts?.redirect_uri ?? window.location.origin,
          queryParams: opts?.extraParams,
        },
      });
      if (error) return { error };
      return { redirected: true as const, url: data.url };
    } catch (e) {
      return { error: e instanceof Error ? e : new Error(String(e)) };
    }
  },
};
