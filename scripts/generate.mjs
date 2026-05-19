import fs from 'fs/promises';
import path from 'path';
import OpenAI from 'openai';

const RETRY_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 30_000;
const OUTPUT_TTL_MS = 60 * 60 * 1000; // 1 hour
const MIN_FILE_SIZE = 50;

let _client = null;
let _model = null;
let _systemPrompt = null;

function loadConfig() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error('Помилка: OPENAI_API_KEY не встановлений у .env файлі.');
    console.error('Скопіюйте .env.example → .env та додайте ваш ключ API.');
    process.exit(1);
  }
  return {
    apiKey,
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  };
}

function getClient() {
  if (!_client) {
    const config = loadConfig();
    _client = new OpenAI({ apiKey: config.apiKey });
    _model = config.model;
  }
  return { client: _client, model: _model };
}

async function getSystemPrompt() {
  if (!_systemPrompt) {
    _systemPrompt = await fs.readFile(path.resolve('prompts/codegen-to-testrail.md'), 'utf8');
  }
  return _systemPrompt;
}

function validateSpec(content, filePath) {
  const warnings = [];

  if (content.trim().length < MIN_FILE_SIZE) {
    warnings.push('файл занадто малий або порожній');
  }
  if (!content.includes('page.goto')) {
    warnings.push('відсутній page.goto');
  }
  const hasInteraction = [/\.click\(/, /\.fill\(/, /\.check\(/, /\.select\(/, /\.type\(/].some(r =>
    r.test(content)
  );
  if (!hasInteraction) {
    warnings.push('відсутні взаємодії (click/fill/check)');
  }

  if (warnings.length > 0) {
    console.warn(`  ⚠ Пропускаю ${path.basename(filePath)}: ${warnings.join(', ')}`);
    return false;
  }
  return true;
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function callOpenAI(client, model, systemPrompt, specContent) {
  let lastError;

  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      const response = await Promise.race([
        client.chat.completions.create({
          model,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user',   content: specContent },
          ],
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Таймаут запиту (30с)')), REQUEST_TIMEOUT_MS)
        ),
      ]);

      return response.choices[0].message.content;
    } catch (err) {
      lastError = err;
      const status = err?.status ?? err?.response?.status;
      const isRetryable = status === 429 || status === 500 || err.message === 'Таймаут запиту (30с)';

      if (isRetryable && attempt < RETRY_ATTEMPTS) {
        const delay = 1000 * Math.pow(2, attempt - 1);
        console.warn(`  ↻ Спроба ${attempt}/${RETRY_ATTEMPTS} не вдалась (${err.message}), повтор через ${delay / 1000}с...`);
        await sleep(delay);
        continue;
      }
      break;
    }
  }

  throw lastError;
}

function cleanJsonResponse(raw) {
  // Strip markdown code fences if model added them
  return raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();
}

function casesToCsv(cases) {
  const header = 'Section,Title,Preconditions,Priority,Type,Steps,Expected Results';

  const escapeCell = value => {
    const str = String(value ?? '').replace(/"/g, '""');
    return `"${str}"`;
  };

  const rows = cases.map(c => {
    const steps = Array.isArray(c.steps) ? c.steps.join('\n') : String(c.steps ?? '');
    const expectedRaw = c.expectedResults ?? c.expected_results;
    const expected = Array.isArray(expectedRaw)
      ? expectedRaw.join('\n')
      : String(expectedRaw ?? '');

    return [
      c.section,
      c.title,
      c.preconditions,
      c.priority,
      c.type,
      steps,
      expected,
    ]
      .map(escapeCell)
      .join(',');
  });

  return [header, ...rows].join('\n');
}

export async function convertFile(filePath, { force = false } = {}) {
  const { client, model } = getClient();
  const basename = path.basename(filePath, path.extname(filePath));
  const outputDir = path.resolve('ai-output');
  const debugDir = path.join(outputDir, 'debug');
  const jsonOut = path.join(outputDir, `${basename}.testrail.json`);
  const csvOut = path.join(outputDir, `${basename}.testrail.csv`);

  // Skip if fresh outputs exist and --force not set
  if (!force) {
    try {
      const stat = await fs.stat(jsonOut);
      if (Date.now() - stat.mtimeMs < OUTPUT_TTL_MS) {
        console.log(`  ⏭ Пропускаю (існує свіжий результат, використовуйте --force): ${basename}`);
        return { skipped: true, tokens: 0 };
      }
    } catch {
      // file doesn't exist, continue
    }
  }

  // Read spec
  let content;
  try {
    content = await fs.readFile(filePath, 'utf8');
  } catch {
    console.warn(`  ⚠ Не можу прочитати файл: ${filePath}`);
    return { skipped: true, tokens: 0 };
  }

  if (!validateSpec(content, filePath)) {
    return { skipped: true, tokens: 0 };
  }

  // Call AI
  const systemPrompt = await getSystemPrompt();
  const rawResponse = await callOpenAI(client, model, systemPrompt, content);

  // Parse response
  const cleaned = cleanJsonResponse(rawResponse);
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    await fs.mkdir(debugDir, { recursive: true });
    const debugFile = path.join(debugDir, `${basename}-raw.txt`);
    await fs.writeFile(debugFile, rawResponse, 'utf8');
    throw new Error(
      `Не вдалось розпарсити JSON відповідь від AI. Raw відповідь збережено: ${debugFile}`
    );
  }

  if (!parsed.cases || !Array.isArray(parsed.cases)) {
    throw new Error('Відповідь AI не містить масиву "cases"');
  }

  // Estimate tokens (rough: 4 chars ≈ 1 token)
  const estimatedTokens = Math.round((content.length + rawResponse.length) / 4);

  // Write outputs
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(jsonOut, JSON.stringify(parsed, null, 2), 'utf8');
  await fs.writeFile(csvOut, casesToCsv(parsed.cases), 'utf8');

  return { skipped: false, tokens: estimatedTokens, jsonOut, csvOut };
}
