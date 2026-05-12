import 'dotenv/config';
import chokidar from 'chokidar';
import fs from 'fs/promises';
import path from 'path';
import { convertFile } from './generate.mjs';

const WATCH_DIR = 'recordings';
const MIN_FILE_SIZE = 50;

async function handleChange(filePath) {
  if (!filePath.endsWith('.spec.ts')) return;

  try {
    const stat = await fs.stat(filePath);
    if (stat.size < MIN_FILE_SIZE) return;
  } catch {
    return;
  }

  const label = path.relative(process.cwd(), filePath);
  console.log(`\n[watch] Виявлено зміни: ${label} → конвертую...`);

  try {
    const result = await convertFile(filePath, { force: true });
    if (result.skipped) {
      console.log(`[watch] Пропущено: ${label}`);
    } else {
      console.log(`[watch] ✓ Готово: ${result.jsonOut}`);
      console.log(`[watch] ✓ Готово: ${result.csvOut}`);
    }
  } catch (err) {
    console.error(`[watch] ✗ Помилка (${label}): ${err.message}`);
  }
}

function main() {
  console.log(`[watch] Слідкую за папкою ${WATCH_DIR}/...`);
  console.log('[watch] Натисніть Ctrl+C для зупинки.\n');

  const watcher = chokidar.watch(`${WATCH_DIR}/**/*.spec.ts`, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
  });

  watcher.on('add', handleChange);
  watcher.on('change', handleChange);

  watcher.on('error', err => {
    console.error('[watch] Помилка watcher:', err.message);
  });
}

main();
