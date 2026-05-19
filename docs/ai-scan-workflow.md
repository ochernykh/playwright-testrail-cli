# ai:scan — Покроковий workflow

Генерація тестів на основі сторінки без прив'язки до user story.

Приклад: **https://demoqa.com/automation-practice-form**

---

## Крок 1 — Згенерувати план тестів

```bash
npm run ai:scan -- --url https://demoqa.com/automation-practice-form --dry-run
```

AI знімає ARIA snapshot форми, аналізує всі елементи (текстові поля, radio, checkboxes, dropdowns) і застосовує техніки тест-дизайну. План зберігається у:

```
plans/demoqa-com-automation-practice-form.plan.json
```

Приклад виводу в консоль:

```
◆  "Page loads with all form sections visible"  [smoke, high]
     · goto https://demoqa.com/automation-practice-form
     · assert visible [role: heading: Student Registration Form]
     · assert visible [role: textbox: First Name]
     · assert visible [role: button: Submit]

◆  "Fill required text fields with valid data"  [positive, high]
     · goto https://demoqa.com/automation-practice-form
     · fill [role: textbox: First Name]
     · fill [role: textbox: Last Name]
     · fill [role: textbox: Mobile Number]
     · assert visible [role: textbox: Mobile Number]

◆  "Submit form with all required fields"  [positive, high]
     · goto https://demoqa.com/automation-practice-form
     · fill [role: textbox: First Name]
     · fill [role: textbox: Last Name]
     · click [role: radio: Male]
     · fill [role: textbox: Mobile Number]
     · click [role: button: Submit]
     · assert visible [role: dialog: Confirmation]

◆  "Select hobbies checkboxes"  [positive, medium]
     · goto https://demoqa.com/automation-practice-form
     · check [role: checkbox: Sports]
     · uncheck [role: checkbox: Sports]
     · check [role: checkbox: Reading]
```

---

## Крок 2 — Відредагувати план (за потреби)

Відкрийте `plans/demoqa-com-automation-practice-form.plan.json`. Можна:
- Видалити зайві тести
- Змінити тестові дані (`"value"`)
- Скоригувати локатори

Фрагмент плану:

```json
{
  "tests": [
    {
      "name": "Fill required text fields with valid data",
      "type": "positive",
      "priority": "high",
      "steps": [
        { "action": "goto", "url": "https://demoqa.com/automation-practice-form" },
        { "action": "fill", "by": "role", "role": "textbox", "name": "First Name", "value": "John" },
        { "action": "fill", "by": "role", "role": "textbox", "name": "Last Name", "value": "Doe" },
        { "action": "fill", "by": "role", "role": "textbox", "name": "Mobile Number", "value": "1234567890" },
        { "action": "assert", "check": "visible", "by": "role", "role": "textbox", "name": "Mobile Number" }
      ]
    }
  ]
}
```

---

## Крок 3 — Виконати план

```bash
npm run ai:run -- \
  --from-plan plans/demoqa-com-automation-practice-form.plan.json \
  --headless \
  --output recordings/demoqa-form.spec.ts
```

Runner виконує кожен крок у браузері та генерує spec файл. Результат у `recordings/demoqa-form.spec.ts`:

```typescript
import { test, expect } from '@playwright/test';

test("Page loads with all form sections visible", async ({ page }) => {
  await page.goto("https://demoqa.com/automation-practice-form");
  await expect(page.getByRole("heading", { name: "Student Registration Form" })).toBeVisible();
});

test("Fill required text fields with valid data", async ({ page }) => {
  await page.goto("https://demoqa.com/automation-practice-form");
  await page.getByRole("textbox", { name: "First Name" }).fill("John");
  await page.getByRole("textbox", { name: "Last Name" }).fill("Doe");
  await page.getByRole("textbox", { name: "Mobile Number" }).fill("1234567890");
  await expect(page.getByRole("textbox", { name: "Mobile Number" })).toBeVisible();
});

test("Submit form with all required fields", async ({ page }) => {
  await page.goto("https://demoqa.com/automation-practice-form");
  await page.getByRole("textbox", { name: "First Name" }).fill("John");
  await page.getByRole("textbox", { name: "Last Name" }).fill("Doe");
  await page.getByRole("textbox", { name: "Mobile Number" }).fill("1234567890");
  await page.getByRole("radio", { name: "Male" }).first().check();
  await page.getByRole("button", { name: "Submit" }).click();
  await expect(page.getByRole("heading", { name: "Student Registration Form" })).toBeVisible();
});
```

---

## Крок 4 — Запустити тести

```bash
npx playwright test recordings/demoqa-form.spec.ts
```

З HTML звітом:

```bash
npx playwright test recordings/demoqa-form.spec.ts --reporter=html && npx playwright show-report
```

---

## Крок 5 — Отримати TestRail артефакти

```bash
npm run ai:testrail -- recordings/demoqa-form.spec.ts
```

Результат у `ai-output/`:
- `demoqa-form.spec.testrail.json`
- `demoqa-form.spec.testrail.csv`

---

## Крок 6 — Якщо тести падають

```bash
npm run ai:heal -- --file recordings/demoqa-form.spec.ts
```

AI знімає актуальний ARIA snapshot, знаходить правильні локатори і перезапускає тести. До 3 спроб.

---

## Одна команда (без dry-run)

```bash
npm run ai:scan -- \
  --url https://demoqa.com/automation-practice-form \
  --headless \
  --output recordings/demoqa-form.spec.ts
```

---

## З бізнес-контекстом

Якщо є user story або AC — AI враховує пріоритети з контексту, але scope тестів все одно визначається ARIA snapshot.

**Крок 1 — Створити файл сторі** `stories/demoqa-form.md`:

```markdown
# Feature: Student Registration Form

## Scenario 1: Успішна реєстрація студента
Given користувач відкрив форму реєстрації
When заповнює First Name, Last Name, вибирає Gender і вводить Mobile Number
And натискає Submit
Then з'являється діалог з підтвердженням реєстрації

## Scenario 2: Обов'язкові поля
Given користувач не заповнив жодне поле
When натискає Submit
Then форма залишається відкритою і поля підсвічуються червоним

## Scenario 3: Хобі та додаткова інформація
Given користувач заповнив обов'язкові поля
When вибирає одне або кілька хобі (Sports, Reading, Music)
Then вибрані checkboxes відмічені
```

**Крок 2 — Запустити з контекстом:**

```bash
npm run ai:scan -- \
  --url https://demoqa.com/automation-practice-form \
  --context stories/demoqa-form.md \
  --dry-run
```

**Різниця з контекстом і без:**

| Без контексту | З контекстом |
|---|---|
| AI рівномірно покриває всі елементи | AI підвищує пріоритет сценаріїв зі сторі |
| Submit flow може бути одним із багатьох | Submit flow стає пріоритетним (high) |
| Загальні тестові дані (`"John"`, `"Doe"`) | AI розуміє бізнес-намір форми |

Контекст не звужує кількість тестів — AI все одно аналізує всі елементи зі сторінки.
