# playwright-testrail-cli

AI-інструмент повного циклу: від дослідження сайту до готових Playwright-тестів і TestRail test cases.

## Як це працює

![Схема роботи](docs/how-it-works.svg)

| Команда | Що робить |
|---------|-----------|
| `ai:explore` | Досліджує сайт (ARIA snapshot + таби + підсторінки) → markdown план тестування |
| `ai:scan` | URL → ARIA snapshot → comprehensive тест-план по елементах (без сторі) → `.spec.ts` + TestRail |
| `ai:run` | Сторі + ARIA snapshot → набір тестів (positive/negative/boundary) → `.spec.ts` + TestRail |
| `ai:heal` | Запускає падаючі тести, знімає ARIA snapshot, AI виправляє локатори |
| `ai:testrail` | Конвертує будь-який `.spec.ts` → TestRail JSON + CSV |
| `ai:watch` | Автоматично конвертує нові/змінені файли в `recordings/` |

---

## Встановлення

```bash
git clone <url-репозиторію>
cd playwright-testrail-cli
npm install
npx playwright install chromium
cp .env.example .env
```

Відкрийте `.env` та вставте ключ:

```env
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-mini   # необов'язково, за замовчуванням gpt-4o-mini
TEST_LOGIN=your_login       # для тестів з авторизацією
TEST_PASSWORD=your_password
```

---

## ai:scan — Page-driven тест-генерація

Альтернатива до `ai:run` коли немає сторі або потрібне повне покриття сторінки.

`ai:scan` аналізує всі інтерактивні елементи на сторінці і застосовує техніки тест-дизайну до кожного:

```bash
# Тільки URL — AI сам визначає що тестувати
npm run ai:scan -- --url https://app.example.com/form --dry-run

# З бізнес-контекстом (сторі як hint, не як обмеження scope)
npm run ai:scan -- --url https://app.example.com/form \
  --context stories/form.md --dry-run

# Повний запуск (генерує план + виконує)
npm run ai:scan -- --url https://app.example.com/form --headless \
  --output recordings/form.spec.ts
```

#### Флаги `ai:scan`

| Флаг | Опис |
|------|------|
| `--url https://...` | URL сторінки для аналізу (обов'язковий) |
| `--context stories/file.md` | Опціональний бізнес-контекст |
| `--dry-run` | Показати план без виконання, зберегти у `plans/` |
| `--headless` | Запустити браузер у headless режимі |
| `--output path/to/file.spec.ts` | Записати/аппендити в конкретний файл |
| `--name "my test"` | Задати ім'я для план-файлу |

#### Коли використовувати `ai:scan` vs `ai:run`

| | `ai:scan` | `ai:run` |
|---|---|---|
| Основа для тестів | Сторінка (ARIA snapshot) | Сторі / Gherkin |
| Scope | Всі елементи на сторінці | Тільки описані сценарії |
| Типова кількість тестів | 12–20 | 3–8 |
| Підходить для | Форми, складні UI, новий ресурс | Конкретний user flow |

---

## Повний workflow

### Крок 1 — Дослідити ресурс

```bash
npm run ai:explore -- --url https://app.example.com
# або з фокусом на конкретну секцію:
npm run ai:explore -- --url https://app.example.com --section "Payments"
```

Результат: `specs/app-example-com.md` — структурований markdown план з Feature Area, Priority, Type, Steps, Expected Results.

---

### Крок 2 — Написати сторі

Створіть файл у `stories/` у довільному форматі (Gherkin, plain text, User Story):

```markdown
# Feature: Login

## Scenario 1: Успішна авторизація
Given користувач відкрив https://app.example.com
When вводить валідний логін і пароль та натискає Увійти
Then потрапляє в особистий кабінет
```

---

### Крок 3 — Згенерувати тести

```bash
npm run ai:run -- \
  stories/login.md \
  --plan specs/app-example-com.md \
  --headless \
  --output recordings/login.spec.ts
```

AI генерує набір тест-кейсів з техніками тест-дизайну:
- **positive** — happy path з валідними даними та assert на успіх
- **negative** — невалідні дані + assert на error message
- **boundary** — порожні поля, граничні значення
- **edge / smoke** — за потреби

Кілька сценаріїв → один файл через append mode (`--output` з існуючим файлом).

#### Флаги `ai:run`

| Флаг | Опис |
|------|------|
| `--story "текст"` | Сторі як рядок |
| `stories/file.md` | Сторі з файлу |
| `--plan specs/file.md` | Контекст від `ai:explore` (покращує точність локаторів) |
| `--output path/to/file.spec.ts` | Записати/аппендити в конкретний файл |
| `--name "my test"` | Задати ім'я тесту вручну |
| `--headless` | Запустити браузер у headless режимі |
| `--dry-run` | Згенерувати план тестів без виконання — переглянути і відредагувати |
| `--from-plan plans/file.plan.json` | Виконати раніше збережений план |

#### Попередній перегляд плану

```bash
# Крок 1 — згенерувати і переглянути план
npm run ai:run -- stories/login.md --plan specs/app.md --dry-run

# Вивід у консоль + зберігає plans/login.plan.json:
#   ◆  "Login with valid credentials"  [positive, high]
#        · goto https://...
#        · fill [label: Email]
#        · fill [label: Password]
#        · click [role: button: Sign In]
#        · assert visible [role: heading: Dashboard]

# Крок 2 — за потреби відредагувати plans/login.plan.json
# Крок 3 — виконати план
npm run ai:run -- --from-plan plans/login.plan.json --headless
```

---

## Альтернатива: ручний запис через Playwright Codegen

Якщо не потрібна AI-генерація тестів — можна записати сценарій вручну і одразу конвертувати в TestRail:

```bash
# 1. Записати сценарій у браузері
npx playwright codegen https://app.example.com

# 2. Зберегти згенерований код у recordings/my-test.spec.ts
# 3. Конвертувати в TestRail
npm run ai:testrail -- recordings/my-test.spec.ts
```

Або увімкнути watch-режим — конвертація запускатиметься автоматично щойно файл збережено:

```bash
npm run ai:watch
```

`ai:testrail` і `ai:watch` працюють з будь-яким `.spec.ts` незалежно від способу створення.

---

### Крок 4 — Отримати TestRail артефакти

```bash
npm run ai:testrail -- recordings/login.spec.ts
# або всі файли:
npm run ai:testrail -- --all
npm run ai:testrail -- --dir recordings/
# примусово перезаписати (ігнорує кеш 1 год):
npm run ai:testrail -- recordings/login.spec.ts --force
```

Результат у `ai-output/`:

```json
{
  "cases": [
    {
      "section": "Login",
      "title": "Login with valid credentials",
      "preconditions": "User is registered",
      "priority": "High",
      "type": "Smoke",
      "steps": ["Open URL", "Fill login", "Click Submit"],
      "expectedResults": ["User is redirected to dashboard"]
    }
  ]
}
```

---

### Крок 5 — Авто-лікування падаючих тестів

```bash
# один файл:
npm run ai:heal -- --file recordings/login.spec.ts
# ціла директорія:
npm run ai:heal -- --dir recordings/
```

Для кожного файлу що падає: знімає ARIA snapshot → AI виправляє локатори → перезапускає (до 3 спроб). Якщо не вдалось — відновлює оригінал.

---

### Watch-режим

```bash
npm run ai:watch
```

Автоматично запускає `ai:testrail` для кожного `.spec.ts` що з'явився або змінився в `recordings/`.

---

## Credentials у тестах

AI автоматично використовує `process.env.TEST_LOGIN` / `process.env.TEST_PASSWORD` замість хардкоду. Додайте реальні значення у `.env` — тести підхоплять їх при запуску.

---

## Структура проекту

```
playwright-testrail-cli/
├── stories/             # Сторі / AC у Gherkin або plain text
├── specs/               # Markdown плани від ai:explore
├── recordings/          # Згенеровані .spec.ts файли
├── ai-output/           # TestRail JSON + CSV (в .gitignore)
├── prompts/
│   ├── story-to-steps.md       # Промт: сторі → тест-кейси (multi-test)
│   ├── codegen-to-testrail.md  # Промт: .spec.ts → TestRail
│   └── explorer-seed.md        # Промт: ARIA snapshots → план тестування
├── scripts/
│   ├── explorer.mjs     # ai:explore
│   ├── runner.mjs       # ai:run
│   ├── healer.mjs       # ai:heal
│   ├── cli.mjs          # ai:testrail
│   └── watch.mjs        # ai:watch
├── docs/
│   └── how-it-works.svg
├── playwright.config.ts
├── .env                 # Секрети (в .gitignore)
├── .env.example
└── package.json
```

---

## Вимоги

- Node.js 18+
- OpenAI API ключ ([platform.openai.com](https://platform.openai.com)) з доступом до `gpt-4o` і `gpt-4o-mini`
- Chromium (встановлюється через `npx playwright install chromium`)

---

## Типові помилки

### `OPENAI_API_KEY не встановлений`
Файл `.env` відсутній або не містить ключа.

### `RateLimitError: Request too large (TPM)`
`ai:explore` зібрав забагато секцій. Використайте `--section` для фокусу на конкретній частині сторінки — це зменшить обсяг ARIA контенту.

### `відсутні взаємодії (click/fill/check)`
Файл `.spec.ts` не містить жодної дії. AI:testrail пропускає такі файли.

### `Таймаут запиту (30с)`
OpenAI не відповів. CLI автоматично повторить 3 рази з exponential backoff.

### `assert не пройшов під час запису`
Нормальна ситуація коли тест використовує `process.env.*` credentials або перевіряє стан після авторизації. Assert все одно записується у spec — він буде виконуватись з реальними даними.
