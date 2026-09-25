# OpenMetadata UI – Playwright E2E Guide

How the Playwright suite is built, how to write tests for it, and how CI keeps
it green without depending on retries.

- [1. Audit of the current suite](#1-audit-of-the-current-suite)
- [2. Target architecture](#2-target-architecture)
- [3. Writing tests: the rules](#3-writing-tests-the-rules)
- [4. Banned patterns](#4-banned-patterns)
- [5. Flaky test policy](#5-flaky-test-policy)
- [6. CI pipeline](#6-ci-pipeline)
- [7. Migration plan](#7-migration-plan)
- [8. Local cheat sheet](#8-local-cheat-sheet)

---

## 1. Audit of the current suite

Snapshot of `playwright/` when this guide was written: 66 spec files (~14.7k
lines), 8.4k lines of `utils/`, and `@playwright/test` 1.44.1.

### 1.1 Root causes of flakiness

| # | Finding | Count | Why it flakes |
|---|---|---|---|
| F1 | `await locator.isVisible();` with the result thrown away | 23 | It asserts nothing. The test passes even when the UI is broken, and the next step then fails somewhere unrelated. |
| F2 | `page.waitForTimeout(n)` | 20 | Too short on a busy runner, wasted time on a fast one. |
| F3 | `page.waitForSelector(...)` | 172 | Doesn't retry like a web-first assertion does, and often waits for "attached" when the test needs "visible and stable". |
| F4 | `page.click/fill/type(selector)` string-selector APIs | 988 | Discouraged API. Mixes CSS/XPath with test IDs, and the selectors break easily. |
| F5 | `force: true` | 13 | Skips actionability checks, which hides overlays, disabled buttons and animations. |
| F6 | API setup calls without a status check | 144 calls, 21 checks | A 4xx/5xx during setup goes unnoticed, and the test fails later in the UI with a misleading error. |
| F7 | UI login per test/describe (`performAdminLogin`, `user.login(page)` in fixtures) | 65 | Adds roughly 3–5 s of flaky UI each time, and triggers the login rate limiter (`maxLoginFailAttempts`). |
| F8 | `describe.serial` / `mode: 'serial'` | 9 files | One failure cascades, and a retry reruns the whole chain. The tests depend on each other's state. |
| F9 | Module-level mutable state | e.g. `support/user/UserClass.ts` (`dataStewardPolicy`, `dataStewardRoles`, `dataStewardTeam` singletons), `EntityDataClass` statics | Two data stewards in one worker overwrite each other's policy/role, so cleanup deletes the wrong one. |
| F10 | Tests that change instance-wide settings run in parallel with everything else | `CustomThemeConfig`, `LoginConfiguration`, `CustomizeLandingPage`, `ProfilerConfigurationPage`, `SearchIndexApplication`, `auth.setup` (JWT expiry, org roles) | Other tests randomly see a changed theme, login config, landing page or profiler config. |
| F11 | Depends on ingested sample data (`sample_data`, `ecommerce_db`, `dim_address`) | 6 files | Order-dependent and breaks when the sample data changes. Parallel tests can edit the same shared entity. |
| F12 | `beforeAll`/`afterAll` data lifecycle | 42 / 41 | `afterAll` doesn't run when `beforeAll` throws, and data leaks when a worker crashes. |
| F13 | `test.slow()` used as a blanket fix | 62 | Triples the timeout. The failure takes 3× longer to show up and the real wait is never fixed. |
| F14 | Search-index / async assertions without polling | many `waitForResponse('/api/v1/search/query*')` | Elasticsearch is only eventually consistent. The response comes back but doesn't contain the new entity yet. |
| F15 | `UserClass.patch()` returns `response.body` (a function, not the body) | 1 | A latent bug: callers never get the entity back. |

### 1.2 Infra / CI gaps

| # | Gap | Impact |
|---|---|---|
| C1 | `retries: 1` and nothing reports the flakes | A flaky test looks green, so flakiness piles up unnoticed. |
| C2 | MySQL and PostgreSQL workflows were ~160-line copies | Every change has to be made twice, and the two copies had already started to drift (artifact names differed). |
| C3 | Only 2 shards, each shard builds Maven, starts Docker and ingests sample data | Long wall-clock time. Rebuilding the stack in every shard is also the most expensive source of infra flakes. |
| C4 | Browsers installed with `npx playwright@1.44.1` separately from `yarn.lock` | A version bump in `package.json` quietly mismatches the browsers. No browser cache. |
| C5 | One HTML report per shard, no JUnit, no merged report | Hard to triage, and no history. |
| C6 | No server health gate | When the server isn't up, every shard throws hundreds of UI timeouts instead of one clear error. |
| C7 | No quarantine, no burn-in of new tests, no nightly stability run | A new flaky test can merge on its first lucky green run. |
| C8 | Trace only `on-first-retry` locally | Local failures have no trace to look at. |
| C9 | Dead config (`PLAYWRIGHT_PROJECT_ID` pointing at a non-existent `cypress-project-id` step) | Noise. |

---

## 2. Target architecture

```
playwright.config.ts          projects, reporters, timeouts (reads config/env.ts only)
playwright/
├── config/env.ts             ★ every env knob + AUTH_STATE + TAGS, typed, one place
├── fixtures/                 ★ the `test` every new spec imports
│   ├── index.ts                adminApi, testData, dataConsumer(Page), dataSteward(Page),
│   │                           admin storageState by default, browser-error capture
│   ├── api.ts                  ApiClient: 2xx-asserting REST client, GET retry on 502/503/504
│   └── testData.ts             TestDataRegistry: create via API, auto-cleanup in reverse order
├── reporters/flaky-reporter.ts ★ flaky-tests JSON + GitHub job summary table
├── utils/wait.ts             ★ waitForResponseAfter, waitForAllLoadersToDisappear, eventually
├── support/                  entity "API objects" (create/delete/patch through REST)
├── utils/                    UI flows (legacy, being migrated into page objects)
├── constant/                 static test data
└── e2e/
    ├── auth.setup.ts         health gate → admin login → storage state
    ├── Pages/ Features/ Flow/ VersionPages/
    └── ...
★ = added by this change
```

### Layers and responsibilities

| Layer | May use | Must not |
|---|---|---|
| **Spec** (`e2e/**`) | fixtures, page objects / flows, `expect` | call `process.env`, create data via UI when it isn't what's under test, share state across tests |
| **Flow / page object** (`utils/**`, future `pages/**`) | locators, `utils/wait.ts`, `expect` | hard waits, `force: true`, return without waiting for the action's effect |
| **API object** (`support/**`) | `ApiClient` / `APIRequestContext` | touch the UI, keep module-level mutable state |
| **Fixture** (`fixtures/**`) | anything | contain assertions about product behaviour |

### Projects

| Project | What runs | Notes |
|---|---|---|
| `setup` | `*.setup.ts` | Serial. Server health gate (≤120 s), then admin login and storage state. |
| `chromium` | every spec except `data-insight`, `@global-state` and `@quarantine` | Fully parallel, sharded. |
| `global-state` | tests tagged `@global-state` | CI runs it after the main suite with `--workers=1`. |
| `data-insight-application` → `Data Insight` | DI app run, then `data-insight` tests | Unchanged. |

Setting `PLAYWRIGHT_RUN_QUARANTINE=true` switches every project to run **only** its
`@quarantine` tests.

---

## 3. Writing tests: the rules

### 3.1 The reference shape

```ts
import { expect, test } from '../../fixtures';
import { TableClass } from '../../support/entity/TableClass';
import { UserClass } from '../../support/user/UserClass';
import { waitForResponseAfter } from '../../utils/wait';

test.describe('Table – ownership', { tag: '@smoke' }, () => {
  test('admin can add a user owner to a table', async ({ page, testData }) => {
    // 1. Arrange through the API: fast, deterministic, auto-cleaned (reverse order).
    const owner = await testData.create(new UserClass());
    const table = await testData.create(new TableClass());
    const ownerName = owner.getUserName();

    // 2. Act through the UI, only on the behaviour under test.
    await table.visitEntityPage(page);
    await page.getByTestId('edit-owner').click();
    await page.getByRole('tab', { name: 'Users' }).click();
    await waitForResponseAfter(page, '/api/v1/search/query', () =>
      page.getByTestId('owner-select-users-search-bar').fill(ownerName)
    );
    await page.getByRole('listitem', { name: ownerName, exact: true }).click();
    await waitForResponseAfter(
      page,
      '/api/v1/tables/',
      () => page.getByTestId('selectable-list-update-btn').click(),
      { method: 'PATCH' }
    );

    // 3. Assert with web-first assertions (they auto-retry).
    await expect(page.getByTestId('owner-link')).toContainText(ownerName);
  });

  test('data consumer cannot edit owners', async ({ dataConsumerPage, testData }) => {
    const table = await testData.create(new TableClass());
    await table.visitEntityPage(dataConsumerPage);

    await expect(dataConsumerPage.getByTestId('edit-owner')).toBeHidden();
  });
});
```

The test IDs above match the current UI; treat the permission check in the second test as illustrative.
Things to notice: there is no `beforeAll`, `afterAll`, login, sleep, `force` or shared state.
Both tests can run on different shards, in either order, any number of times.

### 3.2 Golden rules

1. **One behaviour per test, independent of every other test.** A test must pass
   when run alone, in any order, on any shard, with `--repeat-each=5`.
2. **Arrange with the API, act and assert with the UI.** Only drive the UI through the
   screen under test. Creating a table, glossary or user through forms in a test
   about ownership is how a 30-second test becomes a flaky 3-minute one.
3. **Unique data.** Every entity gets a `uuid()` name (the `support/**` classes do this
   already). Never modify shared sample data (`sample_data.ecommerce_db...`). If
   you need a table, create one.
4. **Clean up through fixtures, not `afterAll`.** `testData.create(entity)` registers
   the delete. Use `testData.onCleanup(label, fn)` for anything else, such as
   restoring a setting.
5. **Log in with storage state, never the UI.** Admin is the default. Use the
   `dataConsumerPage` / `dataStewardPage` fixtures for roles (one login per
   worker). The only test that should type a password is `Login.spec.ts`.
6. **Pick locators in this order:** `getByRole(name)` → `getByLabel` →
   `getByTestId` → `getByText` (exact) → CSS scoped under a test ID. Never XPath,
   never `.nth()` or `.first()` on a list you don't control, never Ant Design
   internals (`.ant-select-item-option-content`) without a test-ID scope. If the
   element has no good handle, **add a `data-testid` in the React component**,
   in the same PR.
7. **Wait for state, not time.**
   - element state → `await expect(locator).toBeVisible() / toHaveText() / toBeEnabled()`
   - network → `waitForResponseAfter(page, url, action)`, which registers the listener
     *before* the action (fixes the classic "response already came back" race)
   - spinners → `waitForAllLoadersToDisappear(page)`
   - eventual consistency (search index, feed, async jobs) → `eventually(async () => {...})`
     with a reload inside, never a sleep followed by a check
8. **Every action is followed by an assertion about its effect** before the next
   action. "Clicked Save" isn't done until "saved toast visible" or "PATCH 200".
9. **Assert API results as well as UI.** `ApiClient` throws with the status, URL and
   body. `waitForResponseAfter` asserts `2xx` by default.
10. **Use `test.step` for readable reports**, not for control flow. Steps can't
    be retried independently. If step 3 needs step 2's data, both belong in one
    test, or in fixtures.
11. **Keep it quick.** Target under 60 s per test. Don't use `test.slow()` for new tests. Tests
    over 2 minutes appear in "slow tests" in the report and should be split.
12. **Tag with intent:** `@smoke` (critical path, under 5 minutes total), `@global-state`
    (changes instance settings, so it runs serially), `@quarantine` (see §5).

### 3.3 Global-state tests

Anything that changes instance-wide configuration (theme, login config, landing
page, profiler config, search settings, org default roles, app schedules):

```ts
test.describe('Custom theme', { tag: '@global-state' }, () => {
  test('applies a primary colour', async ({ page, adminApi, testData }) => {
    const original = await adminApi.get('/api/v1/system/settings/customUiThemePreference');
    testData.onCleanup('restore theme', () =>
      adminApi.put('/api/v1/system/settings', original)
    );
    // ... change & assert
  });
});
```

### 3.4 Eventual consistency (search, feeds, async apps)

```ts
await eventually(async () => {
  await page.reload();
  await expect(page.getByTestId(`table-data-card_${table.fqn}`)).toBeVisible();
}, { timeout: 60_000 });
```

Waiting for a background app (Search Indexing, Data Insight): poll the app's run
status with `adminApi` inside `eventually`, **not** in the UI.

---

## 4. Banned patterns

`.eslintrc.yaml` enforces these through `no-restricted-syntax`. They are **warnings** on
legacy code and **errors** in `fixtures/`, `config/`, `reporters/` and `utils/wait.ts`.
The warning count must never go up; see [§7](#7-migration-plan).

| Pattern | Use instead |
|---|---|
| `page.waitForTimeout(n)` | web-first `expect`, `waitForResponseAfter`, `eventually` |
| `await locator.isVisible();` (result unused) | `await expect(locator).toBeVisible()` |
| `{ force: true }` | wait for the overlay/animation to finish, assert `toBeEnabled()` |
| `page.click/fill/type/hover(selector)` | `page.getByTestId(id).click()` |
| `waitForSelector` | `await expect(locator).toBeVisible()` |
| `waitForLoadState('networkidle')` | wait for the specific response or element |
| `describe.serial` / `mode: 'serial'` | independent tests + fixtures |
| `test.only` | (`forbidOnly` fails CI too) |

Also discouraged, but not lint-enforced yet: `await click(); await page.waitForResponse(...)`
(race condition, use `waitForResponseAfter`), `expect(await locator.textContent()).toBe(x)`
(no retry, use `toHaveText`), and `if (await locator.isVisible())` branches (the test
should know the state it expects).

---

## 5. Flaky test policy

**Definition:** a test is flaky if it produces both pass and fail on the same
commit. Retries are a **safety net that reports**, not a fix.

### 5.1 Detection (automatic)

| Signal | Where |
|---|---|
| Passed only on retry | `flaky-reporter` writes `playwright/output/flaky/<run>.json`, and the table appears in the **GitHub job summary** of every run |
| New or changed spec is unstable | **Burn-in**: every spec changed in a PR runs `--repeat-each=3 --retries=0` on shard 1. Any failure blocks the PR. |
| Slow drift on main | **Nightly** (`playwright-nightly.yml`): full suite `--repeat-each=2` on 6 shards |
| Uncaught app exceptions | `browser-page-errors` attachment on every test. Set `PLAYWRIGHT_FAIL_ON_PAGE_ERROR=true` to make them fail tests. |

### 5.2 Response (humans)

1. A flaky test on main gets an issue within **1 working day**, labelled
   `flaky-test` and owned by the author or code owner of the area.
2. If it can't be fixed within **2 days**, add `@quarantine` with the issue link:
   ```ts
   test('…', { tag: '@quarantine', annotation: { type: 'issue', description: 'https://github.com/open-metadata/OpenMetadata/issues/NNN' } }, …)
   ```
   Quarantined tests don't run in blocking CI. They run nightly with
   `--repeat-each=5 --retries=0`.
3. **Leaving quarantine:** 3 consecutive green nightly runs, then remove the tag in a PR.
   That PR's burn-in re-verifies the test.
4. **Budget:** at most 10 quarantined tests and at most 14 days per test. After that the
   code owner decides between fixing it and deleting it. A quarantined test protects nothing.
5. Never "fix" flakiness by raising timeouts, adding `test.slow()`, adding retries or
   adding sleeps. Find the category below.

### 5.3 Triage by root cause

| Symptom in trace | Likely cause | Fix |
|---|---|---|
| Element found but click did nothing | action before hydration/animation, or overlay | assert the precondition (`toBeEnabled`, dropdown visible) before acting |
| `waitForResponse` timed out, but the response is in the trace earlier | listener registered after the action | `waitForResponseAfter` |
| Entity missing from search/explore | ES refresh lag | `eventually` + reload |
| Passes alone, fails in suite | shared data / global setting | unique data via `testData`, `@global-state` |
| Different result per DB (MySQL vs PG) | ordering assumptions | sort explicitly, or assert as a set |
| 5xx during setup | server under load | `ApiClient` surfaces it. Fix the server or reduce `PLAYWRIGHT_WORKERS`. |
| Fails right after login | login rate limit / token expiry | storage state, not UI login |

### 5.4 Debugging a CI failure

1. Download `test-results-<db>-<shard>` (traces for failures and retries) or the merged
   `playwright-report-<db>` artifact.
2. `npx playwright show-trace trace.zip`. The timeline, network, console and DOM snapshot
   before and after each action are enough for most root causes.
3. Reproduce locally with the same retry pressure:
   `yarn playwright:burn-in playwright/e2e/Pages/Foo.spec.ts`.

---

## 6. CI pipeline

```
PR (safe to test)                        nightly (main)
      │                                        │
      ▼                                        ▼
 playwright-{mysql,postgresql}-e2e.yml   playwright-nightly.yml
      └──────────────┬─────────────────────────┘
                     ▼
        playwright-e2e-reusable.yml
   gate ──► e2e [shard 1..N] ──► report
            │  main suite (sharded, retries=2, flakes reported)
            │  global-state (shard 1, --workers=1)
            │  burn-in of changed specs (shard 1, x3, retries=0)
            └► blob + flaky JSON + traces-on-failure artifacts
                                     └► merged HTML + flaky summary table
```

- **Required status check:** mark `playwright-ci-mysql-result` and
  `playwright-ci-postgresql-result` as required in branch protection. They don't
  depend on the shard count, and the `-skip` workflows emit the same names. The
  old `playwright-ci-mysql (1, 2)` names no longer exist, so **update branch
  protection when merging this change**.
- The Playwright version and browsers come from `yarn.lock`, and browsers are cached by version.
- Reporters on CI: `list`, `blob` (merged later), `html`, `junit`
  (`playwright/output/junit/results.xml`), GitHub annotations and flaky.

### 6.1 Next infra steps (not in this change)

1. **Build the server once and reuse it in every shard.** Today every shard runs Maven,
   Docker and ingestion (~25–35 min before the first test). Build the Docker image in one
   job, push it to GHCR or upload it as an artifact, then in each shard just
   `docker compose up` a pre-seeded DB snapshot. This is the biggest win for both
   speed and infra flakiness.
2. **Upgrade `@playwright/test`** (1.44 → current) to get per-project `workers`
   (a real serial `global-state` project in one invocation), `failOnFlakyTests`,
   `--only-changed` (native burn-in), and `testInfo.tags` based reporting.
3. **Add `eslint-plugin-playwright`** (`recommended` + `no-wait-for-timeout`,
   `no-force-option`, `prefer-web-first-assertions`, `missing-playwright-await`).
   The last one catches un-awaited `expect` calls, which `no-restricted-syntax` can't.
4. **Add a `playwright/tsconfig.json`** and a `tsc --noEmit` CI step. Legacy files have
   strict-mode errors today (e.g. uninitialised `responseData`, untyped index
   access), so fix those first or begin with `strict: false`.
5. **Flaky history:** upload `flaky/*.json` to a dashboard (or a GitHub issue that the
   nightly job updates) to track a flake rate KPI per area.

---

## 7. Migration plan

Migrate in PRs of 1–3 spec files, each of which must pass burn-in.

| Phase | Scope | Exit criteria |
|---|---|---|
| **0 – Foundation** (this change) | env, fixtures, ApiClient, wait utils, flaky reporter, lint guardrails, reusable CI with burn-in, merge and nightly | CI green, and required checks switched to `*-result` |
| **1 – Stop the bleeding** | fix the 23 no-op `isVisible()` calls (F1) and the 20 `waitForTimeout` calls (F2). Add status checks to `support/**` create/delete (F6) by routing them through `expectOk`. Fix `UserClass.patch` (F15). | No false-green assertions. Zero hard waits. |
| **2 – Isolation** | tag the global-state specs (F10) `@global-state` and make them restore state. Replace UI logins (F7) with role fixtures. Remove module-level state in `UserClass` (F9). | Suite passes with `--repeat-each=2` and `--workers=6` locally. |
| **3 – Independence** | turn the 9 serial files (F8) and `beforeAll` data (F12) into `testData` fixtures. Remove the sample-data dependency (F11). | No `serial`, and every file passes run alone with `--shard` in any combination |
| **4 – API hygiene** | migrate `page.click(selector)`/`waitForSelector` (F3/F4) into page objects, remove `test.slow()` (F13) | lint warnings for playwright/** = 0, rules switched to `error` everywhere |
| **5 – Speed** | build-once stack (§6.1-1), 6–8 shards, `@smoke` gate job | PR E2E wall clock under 25 min |

**Ratchet:** until phase 4, a PR may not raise the number of `no-restricted-syntax`
warnings under `playwright/**`. Reviewers check this, or CI can enforce it with
`eslint playwright --max-warnings=<current>`.

**KPIs to track weekly:** flaky rate (flaky ÷ total test runs, target under 0.5%),
quarantine size (target ≤ 10), p95 PR E2E duration, and main-branch E2E pass rate
without retries (target ≥ 98%).

---

## 8. Local cheat sheet

```bash
cd openmetadata-ui/src/main/resources/ui

yarn playwright:run                                   # everything (server at :8585)
yarn playwright:run playwright/e2e/Pages/Tags.spec.ts # one file
yarn playwright:open                                  # UI mode – best for writing tests
yarn playwright:smoke                                 # @smoke only
yarn playwright:burn-in playwright/e2e/Pages/Tags.spec.ts   # x5, no retries: run before pushing
yarn playwright:quarantine                            # only @quarantine, no retries
yarn playwright:report                                # open last HTML report
yarn playwright:codegen http://localhost:8585         # record locators
```

Environment variables (all read in `playwright/config/env.ts`, `.env` supported):

| Variable | Default | Purpose |
|---|---|---|
| `PLAYWRIGHT_TEST_BASE_URL` | `http://localhost:8585` | server under test |
| `PLAYWRIGHT_WORKERS` | CI `3`, local = CPU/2 | parallelism |
| `PLAYWRIGHT_RETRIES` | CI `2`, local `0` | retries (flakes are still reported) |
| `PLAYWRIGHT_TEST_TIMEOUT` | `60000` | per-test timeout |
| `PLAYWRIGHT_RUN_QUARANTINE` | `false` | run only `@quarantine` |
| `PLAYWRIGHT_FAIL_ON_PAGE_ERROR` | `false` | fail on uncaught browser exceptions |
| `PLAYWRIGHT_RUN_LABEL` | `main` | separates outputs of several runs in one job |
| `PLAYWRIGHT_IS_OSS` | `false` | OSS vs Collate behaviour |
