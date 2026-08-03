#!/usr/bin/env node
// Generate social share assets (OG image + favicons) for the Intel Terminal
// dashboard, matching the dashboard's dark-terminal aesthetic.
import sharp from 'sharp';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'dashboard', 'public');

// ---- OG image 1200x630 -------------------------------------------------
const ogSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <radialGradient id="bg" cx="50%" cy="42%" r="75%">
      <stop offset="0%" stop-color="#0d1419"/>
      <stop offset="100%" stop-color="#05080c"/>
    </radialGradient>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#64f0c8"/>
      <stop offset="100%" stop-color="#44ccff"/>
    </linearGradient>
    <filter id="glow"><feGaussianBlur stdDeviation="6" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <!-- grid lines -->
  <g stroke="rgba(100,240,200,0.07)" stroke-width="1">
    <line x1="0" y1="126" x2="1200" y2="126"/><line x1="0" y1="252" x2="1200" y2="252"/>
    <line x1="0" y1="378" x2="1200" y2="378"/><line x1="0" y1="504" x2="1200" y2="504"/>
    <line x1="150" y1="0" x2="150" y2="630"/><line x1="300" y1="0" x2="300" y2="630"/>
    <line x1="450" y1="0" x2="450" y2="630"/><line x1="600" y1="0" x2="600" y2="630"/>
    <line x1="750" y1="0" x2="750" y2="630"/><line x1="900" y1="0" x2="900" y2="630"/>
    <line x1="1050" y1="0" x2="1050" y2="630"/>
  </g>
  <!-- globe-ish arcs (left) -->
  <g transform="translate(230,315)" filter="url(#glow)">
    <circle r="150" fill="none" stroke="rgba(100,240,200,0.18)" stroke-width="2"/>
    <circle r="120" fill="none" stroke="rgba(100,240,200,0.10)" stroke-width="1"/>
    <ellipse rx="150" ry="55" fill="none" stroke="rgba(68,204,255,0.35)" stroke-width="1.5" transform="rotate(-15)"/>
    <ellipse rx="55" ry="150" fill="none" stroke="rgba(68,204,255,0.25)" stroke-width="1.5" transform="rotate(-15)"/>
    <circle cx="-95" cy="-30" r="6" fill="#ff8a65"/>
    <circle cx="60" cy="-100" r="4" fill="#64f0c8"/>
    <circle cx="110" cy="50" r="5" fill="#b388ff"/>
    <circle cx="-40" cy="105" r="4" fill="#ffd54f"/>
    <!-- arcs between points -->
    <path d="M -95 -30 Q 0 -140 60 -100" fill="none" stroke="rgba(100,240,200,0.7)" stroke-width="2"/>
    <path d="M 60 -100 Q 130 -40 110 50" fill="none" stroke="rgba(68,204,255,0.6)" stroke-width="2"/>
    <path d="M -95 -30 Q -120 60 -40 105" fill="none" stroke="rgba(255,138,101,0.5)" stroke-width="2"/>
  </g>
  <!-- right-side text -->
  <g font-family="'DejaVu Sans Mono', monospace">
    <rect x="600" y="38" width="16" height="16" fill="none" stroke="#64f0c8" stroke-width="2"/>
    <rect x="606" y="44" width="4" height="4" fill="#64f0c8"/>
    <text x="632" y="52" fill="rgba(100,240,200,0.75)" font-size="18" letter-spacing="4">LIVE OSINT INTELLIGENCE</text>
    <text x="600" y="150" fill="#ffffff" font-size="72" font-weight="700" font-family="'DejaVu Sans', sans-serif">INTEL</text>
    <text x="600" y="240" fill="#64f0c8" font-size="72" font-weight="700" font-family="'DejaVu Sans', sans-serif">TERMINAL</text>
    <text x="600" y="310" fill="rgba(255,255,255,0.6)" font-size="22" letter-spacing="1">29 live sources · every 90 min</text>
    <text x="600" y="350" fill="rgba(255,255,255,0.6)" font-size="22" letter-spacing="1">Air · Nuclear · Markets · AI trade ideas</text>
    <rect x="600" y="400" width="360" height="2" fill="url(#accent)"/>
    <text x="600" y="470" fill="rgba(100,240,200,0.9)" font-size="26" letter-spacing="2">intel.zerotomonero.xyz</text>
    <text x="600" y="520" fill="rgba(255,255,255,0.35)" font-size="16">NFA — informational only, not financial advice</text>
  </g>
</svg>`;

// ---- Favicon 64x64 (rounded terminal square with "IT" glyph motif) ------
const favSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
  <defs>
    <radialGradient id="fbg" cx="50%" cy="35%" r="80%">
      <stop offset="0%" stop-color="#0d1419"/>
      <stop offset="100%" stop-color="#05080c"/>
    </radialGradient>
  </defs>
  <rect width="64" height="64" rx="12" fill="url(#fbg)"/>
  <rect x="12" y="12" width="40" height="40" rx="6" fill="none" stroke="#64f0c8" stroke-width="2.5"/>
  <circle cx="32" cy="32" r="10" fill="none" stroke="rgba(100,240,200,0.55)" stroke-width="1.5"/>
  <circle cx="32" cy="32" r="3.5" fill="#64f0c8"/>
  <circle cx="22" cy="26" r="2.5" fill="#44ccff"/>
  <circle cx="42" cy="39" r="2.5" fill="#ff8a65"/>
  <path d="M 22 26 Q 30 16 32 22" fill="none" stroke="rgba(100,240,200,0.8)" stroke-width="1.5"/>
  <path d="M 32 22 Q 40 30 42 39" fill="none" stroke="rgba(68,204,255,0.7)" stroke-width="1.5"/>
</svg>`;

async function main() {
  mkdirSync(OUT, { recursive: true });
  const ogPath = join(OUT, 'og-image.png');
  const favPath = join(OUT, 'favicon.png');
  const applePath = join(OUT, 'apple-touch-icon.png');
  const favIco = join(OUT, 'favicon.ico');

  await sharp(Buffer.from(ogSvg)).png().toFile(ogPath);
  await sharp(Buffer.from(favSvg)).resize(64, 64).png().toFile(favPath);
  await sharp(Buffer.from(favSvg)).resize(180, 180).png().toFile(applePath);
  await sharp(Buffer.from(favSvg)).resize(32, 32).toFile(favIco);

  console.log('Generated:');
  console.log(' ', ogPath);
  console.log(' ', favPath);
  console.log(' ', applePath);
  console.log(' ', favIco);
}

main().catch(e => { console.error(e); process.exit(1); });
