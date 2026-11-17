// Supabase connection. Leave empty to run in local demo mode (seeded data, multi-tab sync).
// You can also paste the URL + anon key at runtime in Settings → "חיבור לענן" (stored only on this device).
export const SUPABASE_URL = 'https://uyvvqwcnbefpgqbfpmsd.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV5dnZxd2NuYmVmcGdxYmZwbXNkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQ5MjI4NDksImV4cCI6MjExMDQ5ODg0OX0.pKb5DkgdCgS7mWM3GDHNElDWp9BcFEnghnc3crOcvIg'; // public by design — data is protected by RLS

// Pinned ESM build of supabase-js (cached by the service worker for offline boots).
export const SUPABASE_JS_URL = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';

// Public URL of the deployed `quick-log` Edge Function (derived from SUPABASE_URL when empty).
export const QUICK_LOG_URL = '';
