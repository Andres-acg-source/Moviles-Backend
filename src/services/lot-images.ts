import { readdir } from 'node:fs/promises';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const IMAGES_DIR = fileURLToPath(new URL('../../public/images/', import.meta.url));

const EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

export const isLotImage = (file: string) => EXTENSIONS.has(extname(file).toLowerCase());

export async function lotImagePaths(dir = IMAGES_DIR) {
  const files = await readdir(dir).catch((): string[] => []);
  const paths = new Map<string, string>();
  for (const file of files.filter(isLotImage).sort()) {
    const id = file.slice(0, file.length - extname(file).length);
    if (id && !paths.has(id)) paths.set(id, `/images/${file}`);
  }
  return paths;
}
