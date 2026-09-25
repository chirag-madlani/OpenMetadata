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

/**
 * Deterministic waiting primitives. Use these instead of `waitForTimeout`,
 * `waitForSelector` or a `waitForResponse` that is registered after the click.
 */
import { expect, Page, Response } from '@playwright/test';

type ResponseMatcher = string | RegExp | ((response: Response) => boolean);

/** Waits until every `data-testid="loader"` spinner is gone. */
export const waitForAllLoadersToDisappear = async (
  page: Page,
  timeout = 30_000
) => {
  await expect(page.getByTestId('loader')).toHaveCount(0, { timeout });
};

/**
 * Performs `action` and resolves with the matching response, asserting that
 * it succeeded. The listener is registered *before* the action runs, so the
 * response can never be missed (the classic race in
 * `await click(); await page.waitForResponse(...)`).
 *
 *   const res = await waitForResponseAfter(page, '/api/v1/domains', () =>
 *     page.getByTestId('save-domain').click()
 *   );
 */
export const waitForResponseAfter = async (
  page: Page,
  matcher: ResponseMatcher,
  action: () => Promise<unknown>,
  { expectOk = true, method }: { expectOk?: boolean; method?: string } = {}
) => {
  const predicate = (response: Response) => {
    if (method && response.request().method() !== method.toUpperCase()) {
      return false;
    }
    if (typeof matcher === 'function') {
      return matcher(response);
    }
    const url = response.url();

    return typeof matcher === 'string'
      ? url.includes(matcher)
      : matcher.test(url);
  };

  const [response] = await Promise.all([
    page.waitForResponse(predicate),
    action(),
  ]);

  if (expectOk) {
    expect(
      response.ok(),
      `${response.request().method()} ${response.url()} -> ${response.status()}`
    ).toBeTruthy();
  }

  return response;
};

/**
 * Eventually-consistent assertions (search index, async jobs, feed events).
 * Retries the whole block instead of sleeping for a guessed amount of time.
 *
 *   await eventually(async () => {
 *     await page.reload();
 *     await expect(page.getByTestId(fqn)).toBeVisible();
 *   });
 */
export const eventually = async (
  assertion: () => Promise<unknown>,
  { timeout = 60_000, intervals = [1_000, 2_000, 5_000] } = {}
) => {
  await expect(async () => {
    await assertion();
  }).toPass({ timeout, intervals });
};
