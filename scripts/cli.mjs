import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { convertFile } from './generate.mjs';

function printUsage() {
  console.log(`
Використання:
  npm run ai:testrail -- <файл>           Конвертувати один файл
  npm run ai:testrail -- --all            Конвертувати всі .spec.ts у recordings/
  npm run ai:testrail -- --dir <папка>    Конвертувати всі .spec.ts у вказаній папці
  npm run ai:testrail -- --all --force    Перезаписати навіть свіжі результати
`);
}

async function collectSpecFiles(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    console.error(`Помилка: папка не знайдена: ${dir}`);
    process.exit(1);
  }
  return entries
    .filter(e => e.isFile() && e.name.endsWith('.spec.ts'))
    .map(e => path.join(dir, e.name));
}

async function processFiles(files, force) {
  let done = 0;
  let skipped = 0;
  let totalTokens = 0;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const label = `[${i + 1}/${files.length}] ${file}`;

    try {
      const result = await convertFile(file, { force });
      if (result.skipped) {
        skipped++;
        continue;
      }
      done++;
      totalTokens += result.tokens;
      console.log(`  ${label} → готово`);
    } catch (err) {
      skipped++;
      console.error(`  ✗ ${label} → помилка: ${err.message}`);
    }
  }

  const costUsd = (totalTokens / 1_000_000) * 0.60; // gpt-4o-mini pricing
  console.log(`
✓ Оброблено: ${done} ${pluralize(done, 'файл', 'файли', 'файлів')}
✗ Пропущено: ${skipped}${skipped ? ' (помилка або невалідний файл)' : ''}
Токени використано: ~${totalTokens.toLocaleString('uk')}
Приблизна вартість: ~$${costUsd.toFixed(4)}
Результати: ai-output/
`);
}

function pluralize(n, one, few, many) {
  if (n % 10 === 1 && n % 100 !== 11) return one;
  if ([2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100)) return few;
  return many;
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printUsage();
    process.exit(0);
  }

  const force = args.includes('--force');
  const filteredArgs = args.filter(a => a !== '--force');

  if (filteredArgs.includes('--all')) {
    const files = await collectSpecFiles('recordings');
    if (files.length === 0) {
      console.log('Файли .spec.ts у папці recordings/ не знайдені.');
      process.exit(0);
    }
    console.log(`Знайдено ${files.length} файлів у recordings/\n`);
    await processFiles(files, force);
    return;
  }

  const dirIdx = filteredArgs.indexOf('--dir');
  if (dirIdx !== -1) {
    const dir = filteredArgs[dirIdx + 1];
    if (!dir) {
      console.error('Помилка: вкажіть папку після --dir');
      process.exit(1);
    }
    const files = await collectSpecFiles(dir);
    if (files.length === 0) {
      console.log(`Файли .spec.ts у папці ${dir} не знайдені.`);
      process.exit(0);
    }
    console.log(`Знайдено ${files.length} файлів у ${dir}\n`);
    await processFiles(files, force);
    return;
  }

  // Single file
  const filePath = filteredArgs[0];
  if (!filePath) {
    printUsage();
    process.exit(1);
  }

  try {
    await fs.access(filePath);
  } catch {
    console.error(`Помилка: файл не знайдено: ${filePath}`);
    process.exit(1);
  }

  console.log(`Конвертую: ${filePath}\n`);
  try {
    const result = await convertFile(filePath, { force });
    if (!result.skipped) {
      console.log(`✓ Готово → ${result.jsonOut}`);
      console.log(`✓ Готово → ${result.csvOut}`);
    }
  } catch (err) {
    console.error(`✗ Помилка: ${err.message}`);
    process.exit(1);
  }
}

main();
