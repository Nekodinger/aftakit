// Runtime configuration. Public values only (Supabase anon/publishable key is public by design; RLS protects data).
export const CONFIG = {
  supabaseUrl: import.meta.env.VITE_SUPABASE_URL || '',
  supabaseKey: import.meta.env.VITE_SUPABASE_KEY || '',
  compileUrl: import.meta.env.VITE_COMPILE_URL || '',
};
