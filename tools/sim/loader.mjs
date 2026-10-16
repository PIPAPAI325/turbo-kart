// Node ESM resolve hook：把裸说明符 "three" / "three/addons/..." 映射到 vendor/。
// 用法：node --experimental-loader ./tools/sim/loader.mjs <entry.mjs>
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

const MAP = {
  three: path.join(root, 'vendor', 'three.module.js'),
  'three/addons/objects/Sky.js': path.join(root, 'vendor', 'addons', 'objects', 'Sky.js'),
};

export async function resolve(specifier, context, next) {
  if (MAP[specifier]) {
    return { url: pathToFileURL(MAP[specifier]).href, shortCircuit: true };
  }
  return next(specifier, context);
}
