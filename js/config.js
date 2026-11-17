// Supabase connection. Leave empty to run in local demo mode (seeded data, multi-tab sync).
// You can also paste the URL + anon key at runtime in Settings → "חיבור לענן" (stored only on this device).
export const SUPABASE_URL = '';
export const SUPABASE_ANON_KEY = '';

// Pinned ESM build of supabase-js (cached by the service worker for offline boots).
export const SUPABASE_JS_URL = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';

// Public URL of the deployed `quick-log` Edge Function (derived from SUPABASE_URL when empty).
export const QUICK_LOG_URL = '';
