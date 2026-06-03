// Generator ikon aplikacji (piłka na gradiencie) — czysty Node, bez bibliotek.
// Tworzy PNG (PWA / telefon) oraz icon.svg (zakładka przeglądarki).
// Uruchom: node scripts/generate-icons.mjs
import { writeFileSync, mkdirSync } from "node:fs";
import zlib from "node:zlib";

const GREEN = [22, 150, 80];
const NAVY = [10, 18, 40];

function lerp(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t)
  ];
}

// Punkty pięciokąta (wierzchołek do góry) w środku piłki.
function pentagon(cx, cy, r) {
  const pts = [];
  for (let i = 0; i < 5; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / 5;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}

function inPoly(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy || 1;
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

function drawIcon(N) {
  const buf = Buffer.alloc(N * N * 4);
  const c = N / 2;
  const R = N * 0.34; // promień piłki
  const pr = N * 0.13; // promień pięciokąta
  const pent = pentagon(c, c, pr);
  const seam = N * 0.016; // grubość szwów
  // szwy: od wierzchołków pięciokąta radialnie do krawędzi piłki
  const seams = pent.map(([vx, vy]) => {
    const ang = Math.atan2(vy - c, vx - c);
    return [vx, vy, c + R * Math.cos(ang), c + R * Math.sin(ang)];
  });

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = (y * N + x) * 4;
      // tło: gradient diagonalny zielony -> granat
      const t = (x + y) / (2 * (N - 1));
      let [r, g, b] = lerp(GREEN, NAVY, t);

      const d = Math.hypot(x - c, y - c);
      if (d <= R) {
        // piłka biała
        r = 245; g = 248; b = 255;
        // pięciokąt środkowy
        let black = inPoly(x, y, pent);
        // szwy
        if (!black) {
          for (const s of seams) {
            if (distToSeg(x, y, s[0], s[1], s[2], s[3]) <= seam) {
              black = true;
              break;
            }
          }
        }
        // ciemniejsza krawędź piłki
        if (R - d <= N * 0.012) black = true;
        if (black) { r = 18; g = 22; b = 34; }
      }

      buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = 255;
    }
  }
  return buf;
}

// --- Enkoder PNG (RGBA, 8-bit) -----------------------------------------------
const crcTable = (() => {
  const t = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function encodePng(N, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(N, 0);
  ihdr.writeUInt32BE(N, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(N * (1 + N * 4));
  for (let y = 0; y < N; y++) {
    raw[y * (1 + N * 4)] = 0; // filtr 0
    rgba.copy(raw, y * (1 + N * 4) + 1, y * N * 4, (y + 1) * N * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

function svgIcon(N = 512) {
  const c = N / 2;
  const R = N * 0.34;
  const pr = N * 0.13;
  const pent = pentagon(c, c, pr);
  const seams = pent
    .map(([vx, vy]) => {
      const ang = Math.atan2(vy - c, vx - c);
      return `<line x1="${vx.toFixed(1)}" y1="${vy.toFixed(1)}" x2="${(c + R * Math.cos(ang)).toFixed(1)}" y2="${(c + R * Math.sin(ang)).toFixed(1)}" stroke="#12161f" stroke-width="${(N * 0.03).toFixed(1)}" stroke-linecap="round"/>`;
    })
    .join("");
  const poly = pent.map((p) => p.map((n) => n.toFixed(1)).join(",")).join(" ");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N} ${N}">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="rgb(22,150,80)"/><stop offset="1" stop-color="rgb(10,18,40)"/>
  </linearGradient></defs>
  <rect width="${N}" height="${N}" rx="${N * 0.22}" fill="url(#g)"/>
  <circle cx="${c}" cy="${c}" r="${R}" fill="#f5f8ff" stroke="#12161f" stroke-width="${N * 0.018}"/>
  <polygon points="${poly}" fill="#12161f"/>
  ${seams}
</svg>`;
}

mkdirSync("icons", { recursive: true });
for (const N of [512, 192, 180, 32]) {
  writeFileSync(`icons/icon-${N}.png`, encodePng(N, drawIcon(N)));
}
writeFileSync("icon.svg", svgIcon());
console.log("Ikony wygenerowane: icons/icon-{512,192,180,32}.png oraz icon.svg");
