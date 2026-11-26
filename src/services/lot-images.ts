import { readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const IMAGES_DIR = fileURLToPath(new URL('../../public/images/', import.meta.url));

const EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

export const isImageFile = (file: string) => EXTENSIONS.has(extname(file).toLowerCase());

async function imagePaths(dir: string, urlPrefix: string) {
  const files = await readdir(dir).catch((): string[] => []);
  const paths = new Map<string, string>();
  for (const file of files.filter(isImageFile).sort()) {
    const id = file.slice(0, file.length - extname(file).length);
    if (id && !paths.has(id)) paths.set(id, `${urlPrefix}/${file}`);
  }
  return paths;
}

export const lotImagePaths = (dir = IMAGES_DIR) => imagePaths(dir, '/images');

export const buildingImagePaths = (dir = IMAGES_DIR) => imagePaths(join(dir, 'buildings'), '/images/buildings');
