import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { execFileSync } from 'child_process';
import { chromium } from '@playwright/test';
import OpenAI from 'openai';

const MAX_ARIA_CHARS = 12_000;
const PLANS_DIR    = 'plans';

// ─── Config ───────────────────────────────────────────────────────────────────

function loadConfig() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error('Помилка: OPENAI_API_KEY не встановлений у .env файлі.');
    process.exit(1);
  }
  return {
    apiKey,
    baseURL: process.env.OPENAI_BASE_URL || undefined,
    model:   process.env.OPENAI_MODEL    || 'gpt-4o',
  };
}

function printUsage() {
  console.log(`
Використання:
  npm run ai:scan -- --url https://app.example.com
  npm run ai:scan -- --url https://app.example.com --dry-run
  npm run ai:scan -- --url https://app.example.com --context stories/form.md
  npm run ai:scan -- --url https://app.example.com --headless --output recordings/form.spec.ts
`);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = { url: null, context: null, name: null, headless: false, output: null, dryRun: false };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--url':      opts.url     = args[++i]; break;
      case '--context':  opts.context = args[++i]; break;
      case '--name':     opts.name    = args[++i]; break;
      case '--headless': opts.headless = true;     break;
      case '--output':   opts.output  = args[++i]; break;
      case '--dry-run':  opts.dryRun  = true;      break;
      default:
        if (!args[i].startsWith('--')) opts.url = args[i];
    }
  }
  return opts;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function slugify(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

function slugFromUrl(url) {
  try {
    const u = new URL(url);
    return slugify(u.hostname + u.pathname);
  } catch {
    return slugify(url);
  }
}

function stepLabel(step) {
  if (step.action === 'goto')   return `goto ${step.url}`;
  if (step.action === 'assert') {
    if (step.check === 'url')   return `assert url ~= ${step.pattern}`;
    if (step.check === 'title') return `assert title ~= ${step.pattern}`;
    const target = step.name ?? step.text ?? step.label ?? step.value ?? '';
    return `assert ${step.check} [${step.by ?? ''}${target ? ': ' + target : ''}]`;
  }
  const target = step.name ?? step.text ?? step.label ?? step.placeholder ?? step.selector ?? '';
  return `${step.action} [${step.by}${target ? ': ' + target : ''}]`;
}

function displayPlan(plan, planPath) {
  console.log(`\nПлан: ${plan.tests.length} тестів\n`);
  for (const t of plan.tests) {
    const meta = [t.type, t.priority].filter(Boolean).join(', ');
    console.log(`  ◆  "${t.name}"${meta ? `  [${meta}]` : ''}`);
    for (const step of t.steps) {
      console.log(`       · ${stepLabel(step)}`);
    }
    console.log('');
  }
  console.log(`  Файл плану: ${planPath}`);
  console.log(`  Виконати:   npm run ai:run -- --from-plan ${planPath} --headless\n`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv);

  if (!opts.url) {
    printUsage();
    process.exit(0);
  }

  const config = loadConfig();
  const client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL });

  const systemPrompt = await fs.readFile(path.resolve('prompts/page-to-tests.md'), 'utf8');

  // Optional context (story / AC)
  let contextContent = null;
  if (opts.context) {
    try {
      contextContent = await fs.readFile(path.resolve(opts.context), 'utf8');
      console.log(`Контекст: ${opts.context} (${contextContent.length} chars)`);
    } catch {
      console.warn(`⚠ Не можу прочитати --context файл: ${opts.context}`);
    }
  }

  // Phase 0: ARIA snapshot
  process.stdout.write('Знімаю ARIA-snapshot сторінки... ');
  let ariaTree = null;
  try {
    const browser = await chromium.launch({ headless: true });
    const page    = await (await browser.newContext()).newPage();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(opts.url, { waitUntil: 'load', timeout: 30_000 });
    try { await page.waitForLoadState('networkidle', { timeout: 8_000 }); } catch {}
    const raw = await page.locator('body').ariaSnapshot();
    ariaTree = raw.length > MAX_ARIA_CHARS ? raw.slice(0, MAX_ARIA_CHARS) + '\n...(truncated)' : raw;
    await browser.close();
    console.log(`✓ (${ariaTree.length} chars)`);
  } catch (err) {
    console.error(`✗ Не вдалось зняти ARIA snapshot: ${err.message.split('\n')[0]}`);
    process.exit(1);
  }

  // Phase 1: ARIA snapshot → test plan
  console.log('Генерую план тестів...');
  let userContent = `URL сторінки: ${opts.url}\n\nARIA-дерево сторінки:\n\`\`\`\n${ariaTree}\n\`\`\``;
  if (contextContent) {
    userContent += `\n\nБізнес-контекст:\n\`\`\`\n${contextContent}\n\`\`\``;
  }

  let plan;
  try {
    const resp = await client.chat.completions.create({
      model: config.model,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userContent },
      ],
    });
    plan = JSON.parse(resp.choices[0].message.content);
  } catch (err) {
    console.error(`Помилка AI: ${err.message}`);
    process.exit(1);
  }

  if (!Array.isArray(plan.tests) || plan.tests.length === 0) {
    console.error('AI не повернув жодних тест-кейсів.');
    process.exit(1);
  }

  // Save plan
  const planSlug = opts.name ? slugify(opts.name) : slugFromUrl(opts.url);
  await fs.mkdir(PLANS_DIR, { recursive: true });
  const planPath = path.resolve(`${PLANS_DIR}/${planSlug}.plan.json`);
  await fs.writeFile(planPath, JSON.stringify({ ...plan, _url: opts.url }, null, 2), 'utf8');

  if (opts.dryRun) {
    displayPlan(plan, planPath);
    return;
  }

  console.log(`Тест-кейсів: ${plan.tests.length}\n`);

  // Phase 2: execute via runner.mjs --from-plan
  const runnerArgs = [
    'scripts/runner.mjs',
    '--from-plan', planPath,
    ...(opts.headless ? ['--headless'] : []),
    ...(opts.output   ? ['--output', opts.output] : []),
    ...(opts.name     ? ['--name', opts.name] : []),
  ];

  try {
    execFileSync(process.execPath, runnerArgs, { stdio: 'inherit' });
  } catch {
    process.exit(1);
  }
}

main();
