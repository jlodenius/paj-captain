import { mkdirSync, readFileSync, readdirSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(root, 'dist');

for (const directory of ['src', 'extensions']) {
  rmSync(join(output, directory), { recursive: true, force: true });
  mkdirSync(join(output, directory), { recursive: true });
  for (const name of readdirSync(join(root, directory))) {
    if (name.endsWith('.ts')) {
      const fileName = join(root, directory, name);
      const javascript = stripTypeScriptTypes(readFileSync(fileName, 'utf8'), { mode: 'strip' })
        .replace(/(\bfrom\s*['"])(\.\.?\/[^'"]+)\.ts(['"])/g, '$1$2.js$3');
      writeFileSync(join(output, directory, name.replace(/\.ts$/, '.js')), javascript);
    } else if (name.endsWith('.md')) {
      copyFileSync(join(root, directory, name), join(output, directory, name));
    }
  }
}
