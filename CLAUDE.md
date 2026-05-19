# playwright-testrail-cli

AI-інструмент повного циклу: ARIA snapshot сторінки → тест-план → Playwright `.spec.ts` → TestRail артефакти.

## Стек

- **CLI scripts** (`scripts/*.mjs`) — використовують OpenAI API (`OPENAI_API_KEY` у `.env`)
- **Sub-agents** (`.claude/agents/`) — використовують Claude Code + Playwright MCP (`playwright-test` сервер)
- **MCP сервер** (`.mcp.json`) — `npx playwright run-test-mcp-server`

## Команди

| Команда | Що робить |
|---------|-----------|
| `npm run ai:scan -- --url <url> --dry-run` | Аналіз сторінки → план тестів (без виконання) |
| `npm run ai:scan -- --url <url> --headless --output recordings/<file>.spec.ts` | Аналіз → план → виконання |
| `npm run ai:run -- --from-plan plans/<file>.plan.json --headless` | Виконати збережений план |
| `npm run ai:run -- stories/<file>.md --headless --output recordings/<file>.spec.ts` | Сторі → тести |
| `npm run ai:heal -- --dir recordings/` | Виправити падаючі тести |
| `npm run ai:testrail -- recordings/<file>.spec.ts` | Конвертувати spec → TestRail JSON/CSV |
| `npm run ai:explore -- --url <url>` | Дослідити сайт → markdown план |

## Директорії

- `stories/` — User stories / Gherkin сценарії
- `plans/` — JSON плани тестів (редаговані перед виконанням)
- `recordings/` — Згенеровані `.spec.ts` файли
- `ai-output/` — TestRail JSON + CSV (`.gitignore`)
- `prompts/` — AI промти: `page-to-tests.md`, `story-to-steps.md`, `codegen-to-testrail.md`
- `scripts/` — CLI: `scanner.mjs`, `runner.mjs`, `healer.mjs`, `cli.mjs`, `explorer.mjs`

## Типові workflow

### Page-driven (рекомендований для форм і складних UI)
```
ai:scan --dry-run → редагувати plans/*.plan.json → ai:run --from-plan → ai:testrail
```

### Story-driven (для конкретних user flow)
```
написати stories/*.md → ai:run → ai:testrail
```

### Manual
```
playwright codegen → зберегти в recordings/ → ai:testrail
```

## Sub-agents

Використовуй у Claude Code IDE для інтерактивної роботи:

- **`playwright-test-planner`** — досліджує сторінку через MCP браузер, створює структурований план
- **`playwright-test-generator`** — генерує тести з плану через реальний браузер, записує `.spec.ts`
- **`playwright-test-healer`** — дебажить падаючі тести (`test_debug`), виправляє локатори

CLI scripts підходять для CI/CD. Sub-agents підходять для IDE-роботи та дебагу.

## Формат плану (`plans/*.plan.json`)

```json
{
  "tests": [
    {
      "name": "Test name",
      "type": "positive | negative | boundary | edge | smoke",
      "priority": "high | medium | low",
      "steps": [
        { "action": "goto", "url": "https://..." },
        { "action": "fill", "by": "role", "role": "textbox", "name": "First Name", "value": "John" },
        { "action": "assert", "check": "visible", "by": "role", "role": "heading", "name": "..." }
      ]
    }
  ],
  "_url": "https://..."
}
```

## Змінні середовища (`.env`)

```
OPENAI_API_KEY=sk-...          # обов'язково для CLI scripts
OPENAI_MODEL=gpt-4o-mini       # за замовчуванням gpt-4o-mini
TEST_LOGIN=your_login           # для тестів з авторизацією
TEST_PASSWORD=your_password
```
