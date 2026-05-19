import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { chromium } from '@playwright/test';
import { exec } from 'child_process';
import { promisify } from 'util';
import OpenAI from 'openai';

const execAsync = promisify(exec);
const AI_MODEL = 'gpt-4o-mini';
const MAX_ARIA_CHARS = 12_000;
const MAX_HEAL_ATTEMPTS = 3;

// ─── Config ──────────────────────────────────────────────────────────────────

function loadConfig() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error('Помилка: OPENAI_API_KEY не встановлений у .env файлі.');
    process.exit(1);
  }
  return { apiKey };
}

function printUsage() {
  console.log(`
Використання:
  npm run ai:heal -- --file recordings/auth.spec.ts
  npm run ai:heal -- --dir recordings/
`);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = { file: null, dir: null };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--file': opts.file = args[++i]; break;
      case '--dir':  opts.dir  = args[++i]; break;
    }
  }
  return opts;
}

// ─── Test runner ─────────────────────────────────────────────────────────────

async function runTest(filePath) {
  try {
    const { stdout, stderr } = await execAsync(
      `npx playwright test "${filePath}" --reporter=list`,
      { timeout: 120_000 }
    );
    return { passed: true, output: stdout + stderr };
  } catch (err) {
    return {
      passed: false,
      output: (err.stdout ?? '') + (err.stderr ?? '') + '\n' + err.message,
    };
  }
}

// ─── Snapshot ────────────────────────────────────────────────────────────────

function extractUrl(specContent) {
  const match = specContent.match(/page\.goto\(['"]([^'"]+)['"]\)/);
  return match ? match[1] : null;
}

async function takeSnapshot(url) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(url, { waitUntil: 'load', timeout: 30_000 });
    try { await page.waitForLoadState('networkidle', { timeout: 8_000 }); } catch {}
    const raw = await page.locator('body').ariaSnapshot();
    return raw.length > MAX_ARIA_CHARS
      ? raw.slice(0, MAX_ARIA_CHARS) + '\n...(truncated)'
      : raw;
  } finally {
    await browser.close();
  }
}

// ─── AI heal ─────────────────────────────────────────────────────────────────

async function healSpec(client, specContent, errorOutput, ariaTree) {
  const resp = await client.chat.completions.create({
    model: AI_MODEL,
    messages: [{
      role: 'user',
      content:
        `Playwright тест падає з такими помилками:\n\`\`\`\n${errorOutput.slice(0, 3_000)}\n\`\`\`\n\n` +
        `Поточний ARIA-snapshot сторінки:\n\`\`\`\n${ariaTree}\n\`\`\`\n\n` +
        `Виправ локатори в коді тесту — використовуй точні назви елементів з ARIA-дерева.\n` +
        `НЕ змінюй логіку тесту, структуру test() блоків та import рядки.\n\n` +
        `Поточний код:\n\`\`\`typescript\n${specContent}\n\`\`\`\n\n` +
        `Поверни ТІЛЬКИ виправлений TypeScript код без markdown fences.`,
    }],
  });
  return resp.choices[0].message.content
    .replace(/^```(?:typescript|ts)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();
}

// ─── Process one spec file ───────────────────────────────────────────────────

async function processFile(client, filePath) {
  const abs = path.resolve(filePath);
  console.log(`\n── ${path.basename(abs)}`);

  // Initial test run
  const { passed: initialPassed, output: initialOutput } = await runTest(abs);
  if (initialPassed) {
    console.log('  ✓ Всі тести проходять');
    return { healed: false, skipped: true };
  }

  const original = await fs.readFile(abs, 'utf8');
  const url = extractUrl(original);
  if (!url) {
    console.log('  ⚠ URL не знайдено у spec, пропускаю');
    return { healed: false, skipped: true };
  }

  let lastOutput = initialOutput;

  for (let attempt = 1; attempt <= MAX_HEAL_ATTEMPTS; attempt++) {
    process.stdout.write(`  Спроба ${attempt}/${MAX_HEAL_ATTEMPTS}: ARIA-snapshot... `);
    let ariaTree;
    try {
      ariaTree = await takeSnapshot(url);
      console.log(`✓ (${ariaTree.length} chars)`);
    } catch (err) {
      console.log(`✗ (${err.message.split('\n')[0]})`);
      break;
    }

    process.stdout.write(`  GPT-4o виправляє локатори... `);
    const current = await fs.readFile(abs, 'utf8');
    const fixed = await healSpec(client, current, lastOutput, ariaTree);
    await fs.writeFile(abs, fixed, 'utf8');
    console.log('✓');

    process.stdout.write(`  Перевірка... `);
    const { passed, output } = await runTest(abs);
    lastOutput = output;
    if (passed) {
      console.log(`✓ виправлено (спроба ${attempt})`);
      return { healed: true, skipped: false };
    }
    console.log('✗');
  }

  // Restore original on failure
  await fs.writeFile(abs, original, 'utf8');
  console.log(`  ✗ Не вдалось виправити — відновлено оригінал`);
  return { healed: false, skipped: false };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv);
  if (!opts.file && !opts.dir) { printUsage(); process.exit(0); }

  const config = loadConfig();
  const client = new OpenAI({ apiKey: config.apiKey });

  let files = [];
  if (opts.file) {
    files = [opts.file];
  } else {
    const entries = await fs.readdir(path.resolve(opts.dir));
    files = entries
      .filter(f => f.endsWith('.spec.ts'))
      .map(f => path.join(opts.dir, f));
  }

  if (files.length === 0) {
    console.log('Spec файлів не знайдено.');
    process.exit(0);
  }

  console.log(`Healer: ${files.length} файл(ів)`);

  let healed = 0, failed = 0;
  for (const file of files) {
    const result = await processFile(client, file);
    if (result.healed) healed++;
    else if (!result.skipped) failed++;
  }

  const skipped = files.length - healed - failed;
  console.log(`\nРезультат: виправлено ${healed}, не вдалось ${failed}, без змін ${skipped}\n`);
}

main();
