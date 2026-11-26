import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateOpenApiDocument } from '../services/openapi.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outPath = path.resolve(__dirname, '../../openapi.json');

const doc = generateOpenApiDocument();
const serialized = `${JSON.stringify(doc, null, 2)}\n`;

if (process.argv.includes('--check')) {
  const existing = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8') : '';
  if (existing !== serialized) {
    console.error('[openapi] server/openapi.json is stale. Run `npm run openapi:generate`.');
    process.exit(1);
  }
  console.log('[openapi] server/openapi.json is up to date.');
} else {
  fs.writeFileSync(outPath, serialized, 'utf8');
  console.log(`[openapi] Generated ${outPath}`);
}
