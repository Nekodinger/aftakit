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
