// Copies the component into site/ so that folder is everything you deploy (e.g. to Cloudflare Pages:
// build command `npm run build:site`, output directory `site`). server/, tests/ and the demo stay out.
import { copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
copyFileSync(join(root, 'ofrenda.js'), join(root, 'site', 'ofrenda.js'));
console.log('site/ofrenda.js updated');
