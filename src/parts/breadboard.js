// Solderless breadboards. Holes are pins; holes that are electrically joined share a base name
// (e.g. "T5.a" ... "T5.e"), so the net solver merges them exactly like a real breadboard strip.
const P = 9.6;

function build({ cols, rails }) {
  const x0 = 14, pins = [];
  const rowsTop = ['a', 'b', 'c', 'd', 'e'], rowsBot = ['f', 'g', 'h', 'i', 'j'];
  const yRail = rails ? [10, 19.6] : [];
  const yTop0 = rails ? 40 : 14, yBot0 = yTop0 + 4 * P + 19.2;
  const yRailB = rails ? [yBot0 + 4 * P + 19.2, yBot0 + 4 * P + 28.8] : [];
  const w = Math.round(x0 * 2 + (cols - 1) * P), h = Math.round((rails ? yRailB[1] : yBot0 + 4 * P) + (rails ? 11 : 14));
  for (let c = 1; c <= cols; c++) {
    const x = +(x0 + (c - 1) * P).toFixed(2);
    rowsTop.forEach((r, i) => pins.push({ name: `T${c}.${r}`, x, y: +(yTop0 + i * P).toFixed(2), signals: [], description: `${r}${c}` }));
    rowsBot.forEach((r, i) => pins.push({ name: `B${c}.${r}`, x, y: +(yBot0 + i * P).toFixed(2), signals: [], description: `${r}${c}` }));
  }
  if (rails) {
    let k = 0;
    for (let c = 1; c <= cols; c++) {
      if ((c - 1) % 6 === 5) continue; k++;
      const x = +(x0 + (c - 1) * P).toFixed(2);
      pins.push({ name: `TN.${k}`, x, y: yRail[0], signals: [], description: 'rel − atas' });
      pins.push({ name: `TP.${k}`, x, y: yRail[1], signals: [], description: 'rel + atas' });
      pins.push({ name: `BP.${k}`, x, y: yRailB[0], signals: [], description: 'rel + bawah' });
      pins.push({ name: `BN.${k}`, x, y: yRailB[1], signals: [], description: 'rel − bawah' });
    }
  }
  let svg = `<rect x=".5" y=".5" width="${w - 1}" height="${h - 1}" rx="5" fill="#f1f1ef" stroke="#c8c8c4"/>`;
  svg += `<rect x="4" y="${yTop0 + 4 * P + 5}" width="${w - 8}" height="9" rx="2" fill="#e2e2df"/>`;
  if (rails) {
    svg += `<line x1="8" x2="${w - 8}" y1="5" y2="5" stroke="#3a6fd8" stroke-width="1"/><line x1="8" x2="${w - 8}" y1="24.6" y2="24.6" stroke="#d93a3a" stroke-width="1"/>`;
    svg += `<line x1="8" x2="${w - 8}" y1="${yRailB[0] - 5}" y2="${yRailB[0] - 5}" stroke="#d93a3a" stroke-width="1"/><line x1="8" x2="${w - 8}" y1="${yRailB[1] + 5}" y2="${yRailB[1] + 5}" stroke="#3a6fd8" stroke-width="1"/>`;
  }
  for (const p of pins) svg += `<rect x="${p.x - 1.8}" y="${p.y - 1.8}" width="3.6" height="3.6" rx=".6" fill="#3b3b3b"/>`;
  for (let c = 1; c <= cols; c += (cols > 20 ? 5 : 2)) {
    const x = x0 + (c - 1) * P;
    svg += `<text x="${x}" y="${yTop0 - 4.5}" font-size="4.6" fill="#888" text-anchor="middle" font-family="Arial">${c}</text>`;
  }
  ['a', 'b', 'c', 'd', 'e'].forEach((r, i) => { svg += `<text x="6" y="${yTop0 + i * P + 1.7}" font-size="4.6" fill="#888" text-anchor="middle" font-family="Arial">${r}</text>`; });
  ['f', 'g', 'h', 'i', 'j'].forEach((r, i) => { svg += `<text x="6" y="${yBot0 + i * P + 1.7}" font-size="4.6" fill="#888" text-anchor="middle" font-family="Arial">${r}</text>`; });
  return { w, h, pins, svg };
}

function define(tag, opts) {
  if (customElements.get(tag)) return;
  const g = build(opts);
  customElements.define(tag, class extends HTMLElement {
    constructor() {
      super(); this.attachShadow({ mode: 'open' }).innerHTML =
        `<style>:host{display:inline-block;width:${g.w}px;height:${g.h}px;line-height:0}</style><svg width="${g.w}" height="${g.h}" xmlns="http://www.w3.org/2000/svg">${g.svg}</svg>`;
    }
    get pinInfo() { return g.pins; }
    get updateComplete() { return Promise.resolve(true); }
  });
}

export function registerBreadboards() {
  define('x-breadboard-half', { cols: 30, rails: true });
  define('x-breadboard-mini', { cols: 17, rails: false });
}
