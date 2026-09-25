/*
 *  Copyright 2024 Collate.
 *  Licensed under the Apache License, Version 2.0 (the "License");
 *  you may not use this file except in compliance with the License.
 *  You may obtain a copy of the License at
 *  http://www.apache.org/licenses/LICENSE-2.0
 *  Unless required by applicable law or agreed to in writing, software
 *  distributed under the License is distributed on an "AS IS" BASIS,
 *  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *  See the License for the specific language governing permissions and
 *  limitations under the License.
 */
import {
  defineConfig,
  devices,
  Project,
  ReporterDescription,
} from '@playwright/test';
// Loads `.env` itself, so every knob is read from one place.
import { ENV, TAGS } from './playwright/config/env';

const OUTPUT_DIR = './playwright/output';

const reporters: ReporterDescription[] = ENV.isCI
  ? [
      ['list'],
      // Per-shard blob, merged into one HTML report by the CI merge job.
      ['blob', { outputDir: `${OUTPUT_DIR}/blob-report/${ENV.runLabel}` }],
      [
        'html',
        { outputFolder: `${OUTPUT_DIR}/playwright-report`, open: 'never' },
      ],
      ['junit', { outputFile: `${OUTPUT_DIR}/junit/results.xml` }],
      [
        '@estruyf/github-actions-reporter',
        { useDetails: true, showError: true },
      ],
      [
        './playwright/reporters/flaky-reporter.ts',
        { outputFile: `${OUTPUT_DIR}/flaky/${ENV.runLabel}.json` },
      ],
    ]
  : [
      ['list'],
      [
        'html',
        { outputFolder: `${OUTPUT_DIR}/playwright-report`, open: 'never' },
      ],
      [
        './playwright/reporters/flaky-reporter.ts',
        { outputFile: `${OUTPUT_DIR}/flaky/${ENV.runLabel}.json` },
      ],
    ];

/**
 * Blocking runs exclude quarantined tests; the nightly burn-in job runs only
 * them (`PLAYWRIGHT_RUN_QUARANTINE=true`) to decide when they can come back.
 */
const quarantine = new RegExp(TAGS.quarantine);
const globalState = new RegExp(TAGS.globalState);
const asArray = (value?: RegExp | RegExp[]) =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

const withQuarantine = (project: Project): Project => {
  if (!ENV.runQuarantine) {
    return {
      ...project,
      grepInvert: [...asArray(project.grepInvert), quarantine],
    };
  }
  // AND the project's own `grep` with the quarantine tag via lookaheads.
  const required = [...asArray(project.grep), quarantine]
    .map((re) => `(?=.*${re.source})`)
    .join('');

  return { ...project, grep: new RegExp(`^${required}`) };
};

export default defineConfig({
  testDir: './playwright/e2e',
  outputDir: `${OUTPUT_DIR}/test-results/${ENV.runLabel}`,

  fullyParallel: true,
  forbidOnly: ENV.isCI,
  retries: ENV.retries,
  workers: ENV.workers,
  // Stop burning CI minutes once the run is clearly broken (e.g. server down).
  maxFailures: ENV.isCI ? 30 : undefined,

  timeout: ENV.timeouts.test,
  expect: { timeout: ENV.timeouts.expect },
  reportSlowTests: { max: 10, threshold: 120_000 },
  reporter: reporters,

  use: {
    baseURL: ENV.baseURL,
    testIdAttribute: 'data-testid',
    actionTimeout: ENV.timeouts.action,
    navigationTimeout: ENV.timeouts.navigation,

    // Deterministic rendering of dates / numbers across dev machines and CI.
    locale: 'en-US',
    timezoneId: 'UTC',

    // Artifacts: always available for a failure, cheap for a green run.
    trace: ENV.isCI ? 'on-first-retry' : 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: ENV.isCI ? 'on-first-retry' : 'off',
  },

  projects: [
    // Health check + admin auth. Doc: https://playwright.dev/docs/auth
    {
      name: 'setup',
      testMatch: '**/*.setup.ts',
      retries: 2,
    },
    withQuarantine({
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['setup'],
      grepInvert: [/data-insight/, globalState],
    }),
    // Tests that mutate instance-wide settings (theme, login config, landing
    // page, ...). CI runs this project in a separate `--workers=1` step so
    // they cannot interfere with each other or with the parallel suite.
    withQuarantine({
      name: 'global-state',
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['setup'],
      grep: globalState,
      fullyParallel: false,
    }),
    {
      name: 'data-insight-application',
      dependencies: ['setup'],
      testMatch: '**/dataInsightApp.ts',
    },
    withQuarantine({
      name: 'Data Insight',
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['data-insight-application'],
      grep: /data-insight/,
    }),
  ],
});
