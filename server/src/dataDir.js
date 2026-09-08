import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Где живут база и загруженные файлы.
 *
 * Локально — рядом с кодом, в server/data. На хостинге код перезаписывается
 * при каждом деплое, а постоянный диск монтируется отдельной точкой, поэтому
 * DATA_DIR должен указывать на неё: иначе аккаунты, переписка и загрузки
 * исчезнут при первом же обновлении.
 */
export const dataDir = process.env.DATA_DIR
  ? (isAbsolute(process.env.DATA_DIR) ? process.env.DATA_DIR : resolve(process.cwd(), process.env.DATA_DIR))
  : join(here, '..', 'data');

mkdirSync(dataDir, { recursive: true });
