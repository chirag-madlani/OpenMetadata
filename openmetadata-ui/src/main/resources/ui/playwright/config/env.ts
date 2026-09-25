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
import dotenv from 'dotenv';

dotenv.config();

/**
 * Single source of truth for every environment knob the Playwright suite reads.
 * Specs, fixtures and the config must read from here instead of `process.env`
 * so that defaults are consistent and documented in one place.
 */

const toNumber = (value: string | undefined, fallback?: number) => {
  if (value === undefined || value === '') {
    return fallback;
  }
  const parsed = Number(value);

  return Number.isNaN(parsed) ? fallback : parsed;
};

const toBoolean = (value: string | undefined, fallback = false) =>
  value === undefined ? fallback : ['1', 'true', 'yes'].includes(value);

const isCI = !!process.env.CI;

export const ENV = {
  isCI,
  baseURL: process.env.PLAYWRIGHT_TEST_BASE_URL || 'http://localhost:8585',
  isOSS: toBoolean(process.env.PLAYWRIGHT_IS_OSS),

  /** Parallel workers. CI runners have 4 vCPU; OM server + ES share the box. */
  workers: toNumber(process.env.PLAYWRIGHT_WORKERS, isCI ? 3 : undefined),

  /**
   * Retries are a safety net, never a fix. Every test that needs a retry is
   * reported as flaky by `reporters/flaky-reporter.ts` and must be triaged.
   */
  retries: toNumber(process.env.PLAYWRIGHT_RETRIES, isCI ? 2 : 0) as number,

  /** When true only `@quarantine` tests run (nightly burn-in job). */
  runQuarantine: toBoolean(process.env.PLAYWRIGHT_RUN_QUARANTINE),

  /**
   * Distinguishes several `playwright test` invocations in one CI job
   * (main suite, serial global-state suite, burn-in) so their outputs and
   * blob reports do not overwrite each other.
   */
  runLabel: process.env.PLAYWRIGHT_RUN_LABEL || 'main',

  /** Fail a test when the app throws an uncaught exception in the browser. */
  failOnPageError: toBoolean(process.env.PLAYWRIGHT_FAIL_ON_PAGE_ERROR),

  timeouts: {
    test: toNumber(process.env.PLAYWRIGHT_TEST_TIMEOUT, 60_000) as number,
    expect: 10_000,
    action: 15_000,
    navigation: 30_000,
  },
} as const;

/** Storage-state files produced by `e2e/auth.setup.ts`. */
export const AUTH_STATE = {
  admin: 'playwright/.auth/admin.json',
} as const;

/** Tags understood by the config and CI. Use them via `{ tag: [...] }`. */
export const TAGS = {
  /** Minimal critical-path suite, runs first and gates the rest. */
  smoke: '@smoke',
  /** Known flaky, excluded from blocking runs until fixed (max 14 days). */
  quarantine: '@quarantine',
  /** Mutates instance-wide settings; must not run concurrently with others. */
  globalState: '@global-state',
} as const;
