// Precompiled example firmware: one deflate-compressed blob (shared Arduino core compresses ~3.5x).
import PACK from './hex.json';
import { b64ToHex } from '../sim/hex.js';
let flash;
export const hasExampleHex = (id) => !!PACK.items[id];
export async function exampleHexText(id) {
  const it = PACK.items[id]; if (!it) return null;
  if (!flash) {
    const bin = Uint8Array.from(atob(PACK.z), (c) => c.charCodeAt(0));
    flash = new Uint8Array(await new Response(new Blob([bin]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
  }
  let s = ''; for (const x of flash.subarray(it.off, it.off + it.len)) s += String.fromCharCode(x);
  return { hex: b64ToHex(btoa(s)), info: it.info };
}

// ESP32 / ESP8266 examples: precompiled WebAssembly modules in public/wasm, fetched only when used
import WASM from './wasm.json';
export const hasExampleWasm = (id) => !!WASM[id];
export function exampleWasm(id) {
  const it = WASM[id]; if (!it) return null;
  return { board: it.board, wasm: async () => {
    const r = await fetch(import.meta.env.BASE_URL + it.file);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return new Uint8Array(await r.arrayBuffer());
  } };
}
