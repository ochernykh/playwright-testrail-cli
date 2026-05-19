import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { chromium, expect } from '@playwright/test';
import OpenAI from 'openai';
import { convertFile } from './generate.mjs';

const STEP_TIMEOUT_MS = 8_000;
const RECORDINGS_DIR = 'recordings';
const AI_MODEL      = process.env.OPENAI_MODEL      || 'gpt-4o';
const AI_MODEL_FAST = process.env.OPENAI_MODEL_FAST || 'gpt-4o-mini';
const PLANS_DIR      = 'plans';
const MAX_ARIA_CHARS = 12_000;

// ─── Config ──────────────────────────────────────────────────────────────────

function loadConfig() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error('Помилка: OPENAI_API_KEY не встановлений у .env файлі.');
    process.exit(1);
  }
  return {
    apiKey,
    baseURL:    process.env.OPENAI_BASE_URL    || undefined,
    model:      process.env.OPENAI_MODEL       || 'gpt-4o',
    modelFast:  process.env.OPENAI_MODEL_FAST  || 'gpt-4o-mini',
  };
}

function printUsage() {
  console.log(`
Використання:
  npm run ai:run -- story.txt
  npm run ai:run -- --story "Відкрий https://... натисни Login"
  npm run ai:run -- --story "..." --name "my-test"
  npm run ai:run -- --story "..." --headless
  npm run ai:run -- --story "..." --output recordings/feature.spec.ts
  npm run ai:run -- --story "..." --plan specs/app.md
  npm run ai:run -- --story "..." --dry-run
  npm run ai:run -- --from-plan plans/feature.plan.json --headless
`);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = { storyFile: null, story: null, name: null, headless: false, output: null, plan: null, dryRun: false, fromPlan: null };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--story':     opts.story     = args[++i]; break;
      case '--name':      opts.name      = args[++i]; break;
      case '--headless':  opts.headless  = true;      break;
      case '--output':    opts.output    = args[++i]; break;
      case '--plan':      opts.plan      = args[++i]; break;
      case '--dry-run':   opts.dryRun    = true;      break;
      case '--from-plan': opts.fromPlan  = args[++i]; break;
      default:
        if (!args[i].startsWith('--')) opts.storyFile = args[i];
    }
  }
  return opts;
}

// ─── Phase 0: extract URL + take ARIA snapshot ───────────────────────────────

function extractUrl(story) {
  const match = story.match(/https?:\/\/[^\s,"']+/);
  if (!match) return null;
  return match[0].replace(/[.,!?]+$/, '');
}

// ─── Phase 1: story + ARIA tree → steps ──────────────────────────────────────

async function storyToSteps(client, systemPrompt, story, ariaTree, planContext) {
  let userContent = ariaTree
    ? `ARIA-дерево сторінки:\n\`\`\`\n${ariaTree}\n\`\`\`\n\nСторі: ${story}`
    : story;

  if (planContext) {
    userContent = `Контекст дослідження сторінки (specs/):\n\`\`\`\n${planContext}\n\`\`\`\n\n${userContent}`;
  }

  const resp = await client.chat.completions.create({
    model: AI_MODEL,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userContent },
    ],
  });
  const raw = JSON.parse(resp.choices[0].message.content);
  // backward compat: old format { name, steps } → wrap in { tests }
  if (raw.steps) {
    return { url_missing: raw.url_missing, tests: [{ name: raw.name, type: 'positive', priority: 'high', steps: raw.steps }] };
  }
  return raw;
}

// ─── Phase 2: execute steps in Playwright ────────────────────────────────────

function resolveLocator(page, step) {
  let loc;
  switch (step.by) {
    case 'role': {
      if (step.text) { loc = page.getByRole(step.role).filter({ hasText: step.text }); break; }
      const opts = step.name ? { name: step.name } : {};
      loc = page.getByRole(step.role, opts);
      break;
    }
    case 'label':       loc = page.getByLabel(step.label);                    break;
    case 'text':
      if (!step.text) throw new Error(`Локатор by=text без значення text`);
      loc = page.getByText(step.text, { exact: false });
      break;
    case 'placeholder': loc = page.getByPlaceholder(step.placeholder);        break;
    case 'testid':      loc = page.getByTestId(step.testid);                  break;
    case 'css':         loc = page.locator(step.selector);                    break;
    default:            throw new Error(`Невідомий локатор: ${step.by}`);
  }
  return step.first ? loc.first() : loc;
}

function resolveValue(v) {
  if (typeof v === 'string' && v.startsWith('process.env.')) {
    return process.env[v.slice('process.env.'.length)] ?? '';
  }
  return v ?? '';
}

async function applyAction(loc, step) {
  switch (step.action) {
    case 'click':  await loc.click({ timeout: STEP_TIMEOUT_MS }); break;
    case 'fill':   await loc.fill(resolveValue(step.value), { timeout: STEP_TIMEOUT_MS }); break;
    case 'check':  await loc.check({ timeout: STEP_TIMEOUT_MS }); break;
    case 'select': await loc.selectOption(resolveValue(step.value), { timeout: STEP_TIMEOUT_MS }); break;
    default:       throw new Error(`Невідома дія: ${step.action}`);
  }
}

async function executeAction(page, step) {
  if (step.action === 'goto') {
    await page.goto(step.url, { waitUntil: 'load', timeout: 30_000 });
    try {
      await page.waitForLoadState('networkidle', { timeout: 8_000 });
    } catch {
      // networkidle timeout is acceptable for SPAs with background polling
    }
    return;
  }
  if (step.action === 'assert') {
    switch (step.check) {
      case 'url':
        await expect(page).toHaveURL(new RegExp(step.pattern), { timeout: STEP_TIMEOUT_MS });
        break;
      case 'title':
        await expect(page).toHaveTitle(new RegExp(step.pattern), { timeout: STEP_TIMEOUT_MS });
        break;
      case 'visible': {
        const loc = resolveLocator(page, step);
        await expect(loc.first()).toBeVisible({ timeout: STEP_TIMEOUT_MS });
        break;
      }
      case 'text': {
        const loc = resolveLocator(page, step);
        await expect(loc.first()).toContainText(step.value, { timeout: STEP_TIMEOUT_MS });
        break;
      }
      default:
        throw new Error(`Невідомий тип assert: ${step.check}`);
    }
    return;
  }
  const loc = resolveLocator(page, step);
  try {
    await applyAction(loc, step);
  } catch (err) {
    if (err.message.includes('strict mode violation') && !step.first) {
      step.first = true;
      await applyAction(loc.first(), step);
    } else {
      throw err;
    }
  }
}

// ─── ARIA fallback: aria snapshot → corrected step ───────────────────────────

async function ariaFallback(client, page, failedStep, ariaFallbackPrompt) {
  let ariaTree;
  try {
    const raw = await page.locator('body').ariaSnapshot();
    ariaTree = raw.length > MAX_ARIA_CHARS ? raw.slice(0, MAX_ARIA_CHARS) + '\n...(truncated)' : raw;
  } catch {
    throw new Error('ariaSnapshot недоступний');
  }

  const resp = await client.chat.completions.create({
    model: AI_MODEL_FAST,
    response_format: { type: 'json_object' },
    messages: [{
      role: 'user',
      content: `ARIA-дерево поточної сторінки:\n\`\`\`\n${ariaTree}\n\`\`\`\n\n` +
        `Потрібно виконати: ${JSON.stringify(failedStep)}\n\n` +
        ariaFallbackPrompt,
    }],
  });

  return JSON.parse(resp.choices[0].message.content);
}

// ─── Re-plan remaining steps after tab navigation ────────────────────────────

async function replanRemainingSteps(client, story, executed, ariaTree, replanStepsPrompt) {
  const done = executed
    .filter(s => s.action !== 'goto')
    .map(s => stepLabel(s))
    .join(', ');

  const resp = await client.chat.completions.create({
    model: AI_MODEL,
    response_format: { type: 'json_object' },
    messages: [{
      role: 'user',
      content:
        `Задача: ${story}\n\n` +
        `Вже виконано: ${done || 'нічого'}\n\n` +
        `ARIA-дерево поточного стану сторінки:\n\`\`\`\n${ariaTree}\n\`\`\`\n\n` +
        replanStepsPrompt,
    }],
  });
  const result = JSON.parse(resp.choices[0].message.content);
  return Array.isArray(result.steps) ? result.steps : [];
}

// ─── Phase 3: generate .spec.ts ──────────────────────────────────────────────

function buildLocatorCode(step) {
  const first = step.first ? '.first()' : '';
  switch (step.by) {
    case 'role': {
      if (step.text) return `page.getByRole(${JSON.stringify(step.role)}).filter({ hasText: ${JSON.stringify(step.text)} })${first}`;
      const opts = step.name ? `, { name: ${JSON.stringify(step.name)} }` : '';
      return `page.getByRole(${JSON.stringify(step.role)}${opts})${first}`;
    }
    case 'label':       return `page.getByLabel(${JSON.stringify(step.label)})${first}`;
    case 'text':        return step.text ? `page.getByText(${JSON.stringify(step.text)})${first}` : `page.locator('body')`;
    case 'placeholder': return `page.getByPlaceholder(${JSON.stringify(step.placeholder)})${first}`;
    case 'testid':      return `page.getByTestId(${JSON.stringify(step.testid)})${first}`;
    case 'css':         return `page.locator(${JSON.stringify(step.selector)})${first}`;
    default:            return `page.locator('body')`;
  }
}

function stepToCode(step) {
  if (step.action === 'goto') return `  await page.goto(${JSON.stringify(step.url)});`;
  if (step.action === 'assert') {
    switch (step.check) {
      case 'url':     return `  await expect(page).toHaveURL(/${step.pattern}/);`;
      case 'title':   return `  await expect(page).toHaveTitle(/${step.pattern}/);`;
      case 'visible': {
        const loc = buildLocatorCode(step);
        return `  await expect(${loc}).toBeVisible();`;
      }
      case 'text': {
        const loc = buildLocatorCode(step);
        return `  await expect(${loc}).toContainText(${JSON.stringify(step.value)});`;
      }
      default: return `  // assert: ${JSON.stringify(step)}`;
    }
  }

  const first = step.first ? '.first()' : '';
  const encodeValue = v => (typeof v === 'string' && v.startsWith('process.env.')) ? v : JSON.stringify(v ?? '');
  const actionSuffix = {
    click:  '.click()',
    fill:   `.fill(${encodeValue(step.value)})`,
    check:  '.check()',
    select: `.selectOption(${encodeValue(step.value)})`,
  }[step.action] ?? `.${step.action}()`;

  switch (step.by) {
    case 'role': {
      if (step.text) {
        return `  await page.getByRole(${JSON.stringify(step.role)}).filter({ hasText: ${JSON.stringify(step.text)} })${first}${actionSuffix};`;
      }
      const opts = step.name ? `, { name: ${JSON.stringify(step.name)} }` : '';
      return `  await page.getByRole(${JSON.stringify(step.role)}${opts})${first}${actionSuffix};`;
    }
    case 'label':       return `  await page.getByLabel(${JSON.stringify(step.label)})${first}${actionSuffix};`;
    case 'text':        return `  await page.getByText(${JSON.stringify(step.text)})${first}${actionSuffix};`;
    case 'placeholder': return `  await page.getByPlaceholder(${JSON.stringify(step.placeholder)})${first}${actionSuffix};`;
    case 'testid':      return `  await page.getByTestId(${JSON.stringify(step.testid)})${first}${actionSuffix};`;
    case 'css':         return `  await page.locator(${JSON.stringify(step.selector)})${first}${actionSuffix};`;
    default:            return `  // TODO: ${JSON.stringify(step)}`;
  }
}

function generateTestBlock(name, steps) {
  return [
    ``,
    `test(${JSON.stringify(name)}, async ({ page }) => {`,
    ...steps.map(stepToCode),
    `});`,
    ``,
  ].join('\n');
}

function generateSpec(name, steps) {
  return `import { test, expect } from '@playwright/test';\n` + generateTestBlock(name, steps);
}

function slugify(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

function stepLabel(step) {
  if (step.action === 'goto')   return `goto ${step.url}`;
  if (step.action === 'assert') {
    if (step.check === 'url')   return `assert url ~= /${step.pattern}/`;
    if (step.check === 'title') return `assert title ~= /${step.pattern}/`;
    const target = step.name ?? step.text ?? step.label ?? step.value ?? '';
    return `assert ${step.check} [${step.by ?? ''}${target ? ': ' + target : ''}]`;
  }
  const target = step.name ?? step.text ?? step.label ?? step.placeholder ?? step.selector ?? '';
  return `${step.action} [${step.by}${target ? ': ' + target : ''}]`;
}

// ─── Plan display ─────────────────────────────────────────────────────────────

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

  if (!opts.story && !opts.storyFile && !opts.fromPlan) {
    printUsage();
    process.exit(0);
  }

  const config = loadConfig();
  const client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL });

  const [ariaFallbackPrompt, replanStepsPrompt] = await Promise.all([
    fs.readFile(path.resolve('prompts/aria-fallback.md'), 'utf8'),
    fs.readFile(path.resolve('prompts/replan-steps.md'), 'utf8'),
  ]);

  // ── Branch: load existing plan or generate new one ─────────────────────────
  let plan;
  let story = '';

  if (opts.fromPlan) {
    try {
      const raw = JSON.parse(await fs.readFile(path.resolve(opts.fromPlan), 'utf8'));
      plan  = raw;
      story = raw._story ?? '';
    } catch {
      console.error(`Помилка: не можу прочитати план: ${opts.fromPlan}`);
      process.exit(1);
    }
    console.log(`Завантажено план: ${opts.fromPlan} (${plan.tests.length} тестів)\n`);
  } else {
    story = opts.story;
    if (!story) {
      try {
        story = (await fs.readFile(opts.storyFile, 'utf8')).trim();
      } catch {
        console.error(`Помилка: не можу прочитати файл: ${opts.storyFile}`);
        process.exit(1);
      }
    }

    const [systemPrompt] = await Promise.all([
      fs.readFile(path.resolve('prompts/story-to-steps.md'), 'utf8'),
    ]);

    let planContext = null;
    if (opts.plan) {
      try {
        planContext = await fs.readFile(path.resolve(opts.plan), 'utf8');
        console.log(`Контекст: ${opts.plan} (${planContext.length} chars)`);
      } catch {
        console.warn(`⚠ Не можу прочитати --plan файл: ${opts.plan}`);
      }
    }

    // Phase 0: ARIA snapshot (always headless — окремий браузер тільки для snapshot)
    const firstUrl = extractUrl(story);
    let ariaTree = null;
    if (firstUrl) {
      process.stdout.write('Знімаю ARIA-snapshot сторінки... ');
      try {
        const snapBrowser = await chromium.launch({ headless: true });
        const snapPage    = await (await snapBrowser.newContext()).newPage();
        await snapPage.setViewportSize({ width: 1440, height: 900 });
        await snapPage.goto(firstUrl, { waitUntil: 'load', timeout: 30_000 });
        try { await snapPage.waitForLoadState('networkidle', { timeout: 8_000 }); } catch {}
        const raw = await snapPage.locator('body').ariaSnapshot();
        ariaTree = raw.length > MAX_ARIA_CHARS ? raw.slice(0, MAX_ARIA_CHARS) + '\n...(truncated)' : raw;
        await snapBrowser.close();
        console.log(`✓ (${ariaTree.length} chars)`);
      } catch (err) {
        console.log(`⚠ (${err.message.split('\n')[0]}) — продовжую без snapshot`);
      }
    }

    // Phase 1: story + ARIA tree → plan
    console.log('Аналізую сторі...');
    try {
      plan = await storyToSteps(client, systemPrompt, story, ariaTree, planContext);
    } catch (err) {
      console.error(`Помилка AI: ${err.message}`);
      process.exit(1);
    }

    if (!Array.isArray(plan.tests) || plan.tests.length === 0) {
      console.error('AI не повернув жодних тест-кейсів.');
      process.exit(1);
    }

    if (plan.url_missing) {
      console.error('Помилка: URL не знайдено у сторі. Додайте повний URL у текст сторі.');
      process.exit(1);
    }

    // Save plan to plans/
    const planSlug = opts.name
      ? slugify(opts.name)
      : opts.storyFile
        ? slugify(path.basename(opts.storyFile, path.extname(opts.storyFile)))
        : `plan-${Date.now()}`;
    await fs.mkdir(PLANS_DIR, { recursive: true });
    const planPath = path.resolve(`${PLANS_DIR}/${planSlug}.plan.json`);
    await fs.writeFile(planPath, JSON.stringify({ ...plan, _story: story }, null, 2), 'utf8');

    if (opts.dryRun) {
      displayPlan(plan, planPath);
      return;
    }

    console.log(`Тест-кейсів: ${plan.tests.length}\n`);
  }

  // ── Phase 2: execute ───────────────────────────────────────────────────────
  const browser = await chromium.launch({ headless: opts.headless });
  const context = await browser.newContext();
  const page    = await context.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });

  const testCases = plan.tests;

  async function executeTestCase(testCase) {
    const steps = [...testCase.steps];
    const executed = [];

    async function tabReplan(step, i) {
      if (step.action !== 'click' || step.role !== 'tab') return;
      if (i >= steps.length - 1) return;
      process.stdout.write(`             ↻ re-plan після таб... `);
      try {
        const raw = await page.locator('body').ariaSnapshot();
        const newTree = raw.length > MAX_ARIA_CHARS ? raw.slice(0, MAX_ARIA_CHARS) + '\n...(truncated)' : raw;
        const remaining = await replanRemainingSteps(client, story, executed, newTree, replanStepsPrompt);
        if (remaining.length > 0) {
          steps.splice(i + 1, steps.length - i - 1, ...remaining);
          console.log(`✓ (+${remaining.length} кроків)`);
        } else {
          console.log('✓ (нових кроків немає)');
        }
      } catch (err) {
        console.log(`⚠ (${err.message.split('\n')[0]})`);
      }
    }

    for (let i = 0; i < steps.length; i++) {
      let step = steps[i];
      process.stdout.write(`  [${i + 1}/${steps.length}] ${stepLabel(step)}... `);

      try {
        await executeAction(page, step);
        executed.push(step);
        console.log('✓');
        await tabReplan(step, i);
      } catch (err) {
        const shortErr = err.message.split('\n')[0].slice(0, 80);
        console.log(`✗  (${shortErr})`);

        if (step.action === 'assert') {
          executed.push(step);
          console.log(`             ⚠ assert збережено (дані запису відрізняються від тестових)`);
          continue;
        }

        process.stdout.write(`             aria fallback... `);
        try {
          const corrected = await ariaFallback(client, page, step, ariaFallbackPrompt);
          await executeAction(page, corrected);
          executed.push(corrected);
          console.log('✓ виправлено');
          await tabReplan(corrected, i);
        } catch {
          console.log('✗ пропущено');
        }
      }
    }

    return executed;
  }

  const results = [];
  try {
    for (const testCase of testCases) {
      const typeLabel = testCase.type ? ` [${testCase.type}]` : '';
      console.log(`  ── "${testCase.name}"${typeLabel}`);
      const executed = await executeTestCase(testCase);
      if (executed.length > 0) {
        results.push({ name: testCase.name, type: testCase.type, steps: executed });
      } else {
        console.log(`  ⚠ Жоден крок не виконано — тест пропущено\n`);
      }
      console.log('');
    }
  } finally {
    await browser.close();
  }

  if (results.length === 0) {
    console.error('Жоден тест не виконано. Перевірте URL і текст сторі.');
    process.exit(1);
  }

  // Phase 3: save .spec.ts
  const slug = opts.name ? slugify(opts.name) : slugify(results[0].name) || `test-${Date.now()}`;

  let specPath;
  if (opts.output) {
    specPath = path.resolve(opts.output);
    await fs.mkdir(path.dirname(specPath), { recursive: true });
  } else {
    specPath = path.resolve(`${RECORDINGS_DIR}/${slug}.spec.ts`);
    await fs.mkdir(RECORDINGS_DIR, { recursive: true });
  }

  let fileExists = false;
  try { await fs.access(specPath); fileExists = true; } catch {}

  for (let i = 0; i < results.length; i++) {
    const { name, steps } = results[i];
    if (i === 0 && !fileExists) {
      await fs.writeFile(specPath, generateSpec(name, steps), 'utf8');
    } else {
      await fs.appendFile(specPath, generateTestBlock(name, steps), 'utf8');
    }
  }

  const totalSteps = results.reduce((s, r) => s + r.steps.length, 0);
  console.log(`  Тестів записано: ${results.length}/${testCases.length}`);
  console.log(`  Кроків всього:   ${totalSteps}`);
  console.log(`  Spec:            ${specPath}${fileExists ? '  (append)' : ''}`);

  // Phase 4: generate TestRail
  console.log('\nГенерую тест-кейс для TestRail...');
  try {
    const result = await convertFile(specPath, { force: true });
    if (!result.skipped) {
      console.log(`  JSON: ${result.jsonOut}`);
      console.log(`  CSV:  ${result.csvOut}`);
    }
  } catch (err) {
    console.error(`  Помилка: ${err.message}`);
  }

  console.log('');
}

main();
