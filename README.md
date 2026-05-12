# playwright-testrail-cli

CLI-інструмент для автоматичного перетворення Playwright Codegen записів на manual test cases для TestRail за допомогою OpenAI.

## Як це працює

![Схема роботи](docs/how-it-works.svg)

1. Ви записуєте сценарій через **Playwright Codegen** — він генерує `.spec.ts` файл.
2. Запускаєте CLI — він надсилає запис до OpenAI.
3. AI перетворює технічні дії на зрозумілі бізнес-кроки українською мовою.
4. Отримуєте готові `.json` і `.csv` файли для імпорту в TestRail.

---

## Встановлення

### 1. Клонувати репозиторій

```bash
git clone <url-репозиторію>
cd playwright-testrail-cli
```

### 2. Встановити залежності

```bash
npm install
```

### 3. Налаштувати змінні середовища

```bash
cp .env.example .env
```

Відкрийте `.env` та вставте ваш ключ OpenAI:

```env
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-mini
```

> `OPENAI_MODEL` — необов'язково. За замовчуванням використовується `gpt-4o-mini`.

---

## Запис сценарію через Playwright Codegen

```bash
npx playwright codegen https://your-app-url.com
```

Виконайте дії в браузері. Скопіюйте або збережіть згенерований код як `.spec.ts` файл у папку `recordings/`.

---

## Запуск конвертації

### Конвертувати один файл

```bash
npm run ai:testrail -- recordings/my-test.spec.ts
```

### Конвертувати всі файли у `recordings/`

```bash
npm run ai:testrail -- --all
```

### Конвертувати всі файли у вказаній папці

```bash
npm run ai:testrail -- --dir path/to/folder
```

### Примусово перезаписати існуючі результати

За замовчуванням файли, оновлені менше години тому, пропускаються. Щоб ігнорувати це:

```bash
npm run ai:testrail -- --all --force
npm run ai:testrail -- recordings/my-test.spec.ts --force
```

---

## Режим спостереження (watch)

Автоматично конвертує будь-який `.spec.ts` файл, щойно він з'являється або змінюється у `recordings/`:

```bash
npm run ai:watch
```

Зупинити: `Ctrl+C`.

---

## Результати

Файли зберігаються у папці `ai-output/`:

| Файл | Опис |
|------|------|
| `*.testrail.json` | Структурований JSON з тест-кейсами |
| `*.testrail.csv` | CSV для прямого імпорту в TestRail |

### Структура JSON

```json
{
  "cases": [
    {
      "section": "Назва секції",
      "title": "Назва тест-кейсу",
      "preconditions": "Передумови",
      "priority": "High",
      "type": "Smoke",
      "steps": ["Крок 1", "Крок 2"],
      "expectedResults": ["Очікуваний результат 1", "Очікуваний результат 2"]
    }
  ]
}
```

### Поля

| Поле | Можливі значення |
|------|-----------------|
| `priority` | `Low`, `Medium`, `High`, `Critical` |
| `type` | `Functional`, `Regression`, `Smoke` |

---

## Структура проекту

```
playwright-testrail-cli/
├── recordings/          # Playwright Codegen .spec.ts файли
├── ai-output/           # Згенеровані JSON та CSV (в .gitignore)
├── prompts/
│   └── codegen-to-testrail.md   # System prompt для OpenAI
├── scripts/
│   ├── cli.mjs          # Точка входу CLI
│   ├── generate.mjs     # Логіка конвертації та виклику API
│   └── watch.mjs        # Watch-режим
├── .env                 # Ваші секрети (в .gitignore)
├── .env.example         # Шаблон змінних середовища
└── package.json
```

---

## Вимоги

- Node.js 18+
- npm
- OpenAI API ключ ([platform.openai.com](https://platform.openai.com))

---

## Типові помилки

### `OPENAI_API_KEY не встановлений`
Переконайтесь, що файл `.env` існує і містить ваш ключ.

### `відсутні взаємодії (click/fill/check)`
Файл не містить жодної дії користувача. Запишіть сценарій з реальними взаємодіями (кліки, введення тексту тощо).

### `Таймаут запиту (30с)`
OpenAI не відповів вчасно. CLI автоматично повторить спробу 3 рази.
