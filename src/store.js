// Sharing: Supabase RPCs (SECURITY DEFINER, RLS on) with graceful local fallback.
import { CONFIG } from './config.js';
let client = null;
async function sb() {
  if (!CONFIG.supabaseUrl || !CONFIG.supabaseKey) return null;
  if (!client) { const { createClient } = await import('@supabase/supabase-js'); client = createClient(CONFIG.supabaseUrl, CONFIG.supabaseKey, { auth: { persistSession: false } }); }
  return client;
}
export const sharingAvailable = () => !!(CONFIG.supabaseUrl && CONFIG.supabaseKey);
const KEY = 'sim.editkeys.v1';
const keys = () => { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; } };
const setKey = (id, k) => { try { const o = keys(); o[id] = k; localStorage.setItem(KEY, JSON.stringify(o)); } catch { /* ignore */ } };
const randKey = () => [...crypto.getRandomValues(new Uint8Array(18))].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function saveProject({ id, title, data }) {
  const c = await sb(); if (!c) throw new Error('Database belum dikonfigurasi pada build ini.');
  const ek = id ? keys()[id] : null;
  if (id && ek) {
    const { data: ok, error } = await c.rpc('update_project', { p_id: id, p_edit_key: ek, p_title: title, p_data: data });
    if (error) throw new Error(error.message); if (ok) return { id, updated: true };
  }
  const key = randKey();
  const { data: newId, error } = await c.rpc('create_project', { p_title: title, p_data: data, p_edit_key: key });
  if (error) throw new Error(error.message);
  setKey(newId, key); return { id: newId, updated: false };
}
export async function loadProject(id) {
  const c = await sb(); if (!c) throw new Error('Database belum dikonfigurasi pada build ini.');
  const { data, error } = await c.rpc('get_project', { p_id: id });
  if (error) throw new Error(error.message);
  const row = Array.isArray(data) ? data[0] : data; if (!row) throw new Error('Proyek tidak ditemukan.');
  return row;
}
