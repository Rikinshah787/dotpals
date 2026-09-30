// Build the landing page into _site/, for any static host (Vercel, GitHub Pages…).
// It's plain files: site/ itself, the <dot-pal> component from src/ (the page's
// pals are the real thing) and the screenshots it shows from docs/.
//
//   node site/build.mjs              → _site/
//   SITE_URL=https://example.com/ node site/build.mjs   (links for share cards)
//
// On Vercel the production URL is picked up by itself.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = join(root, '_site');
const DEFAULT_URL = 'https://rikinshah787.github.io/dotpals/';
const IMAGES = ['notch', 'dashboard', 'sessions', 'summary', 'tools', 'files'];

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'docs'), { recursive: true });
cpSync(join(root, 'site'), out, { recursive: true, filter: (src) => !src.endsWith('build.mjs') });
cpSync(join(root, 'src'), join(out, 'src'), { recursive: true });
for (const name of IMAGES) cpSync(join(root, 'docs', `${name}.png`), join(out, 'docs', `${name}.png`));
writeFileSync(join(out, '.nojekyll'), '');

// Share cards (X, Open Graph) need absolute links to the page and its image.
const vercel = process.env.VERCEL_ENV === 'production' && process.env.VERCEL_PROJECT_PRODUCTION_URL;
const url = process.env.SITE_URL || (vercel ? `https://${vercel}/` : DEFAULT_URL);
if (url !== DEFAULT_URL) {
  const page = join(out, 'index.html');
  writeFileSync(page, readFileSync(page, 'utf8').split(DEFAULT_URL).join(url.endsWith('/') ? url : `${url}/`));
}
console.log(`Built _site/ for ${url}`);
