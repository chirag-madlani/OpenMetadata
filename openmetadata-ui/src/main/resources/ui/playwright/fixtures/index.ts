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
 * The one `test` every new spec imports:
 *
 *   import { expect, test } from '../../fixtures';
 *
 * It replaces hand-rolled `base.extend`, `createNewPage`, `performAdminLogin`
 * and `beforeAll`/`afterAll` data setup. See playwright/README.md.
 */
import {
  Browser,
  BrowserContextOptions,
  Page,
  test as base,
} from '@playwright/test';
import { AUTH_STATE, ENV } from '../config/env';
import { UserClass } from '../support/user/UserClass';
import { ApiClient, readTokenFromStorageState } from './api';
import { TestDataRegistry } from './testData';

type StorageState = Exclude<BrowserContextOptions['storageState'], undefined>;

type RoleSession = { user: UserClass; storageState: StorageState };

type WorkerFixtures = {
  /** Admin REST client, created once per worker. */
  adminApi: ApiClient;
  /** A DataConsumer user created & logged in once per worker. */
  dataConsumer: RoleSession;
  /** A DataSteward user created & logged in once per worker. */
  dataSteward: RoleSession;
};

type TestFixtures = {
  /** Test-scoped data factory with guaranteed reverse-order cleanup. */
  testData: TestDataRegistry;
  dataConsumerPage: Page;
  dataStewardPage: Page;
};

const loginOnce = async (browser: Browser, user: UserClass) => {
  const context = await browser.newContext({ baseURL: ENV.baseURL });
  const page = await context.newPage();
  try {
    await user.login(page);
    await page.waitForURL('**/my-data');

    return await context.storageState();
  } finally {
    await context.close();
  }
};

const pageFor = async (browser: Browser, session: RoleSession) => {
  const context = await browser.newContext({
    baseURL: ENV.baseURL,
    storageState: session.storageState,
  });

  return context.newPage();
};

export const test = base.extend<TestFixtures, WorkerFixtures>({
  // Admin is the default identity. Opt out per file/describe with
  // `test.use({ storageState: { cookies: [], origins: [] } })`.
  // eslint-disable-next-line no-empty-pattern
  storageState: async ({}, use) => {
    await use(AUTH_STATE.admin);
  },

  // Capture uncaught browser exceptions on every page; optionally fail on them.
  page: async ({ page }, use, testInfo) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) =>
      pageErrors.push(error.stack ?? error.message)
    );

    await use(page);

    if (pageErrors.length) {
      await testInfo.attach('browser-page-errors', {
        body: pageErrors.join('\n\n'),
        contentType: 'text/plain',
      });
      if (ENV.failOnPageError && testInfo.status === testInfo.expectedStatus) {
        throw new Error(
          `Uncaught browser error(s) during test:\n${pageErrors[0]}`
        );
      }
    }
  },

  adminApi: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const api = await ApiClient.create(
        readTokenFromStorageState(AUTH_STATE.admin)
      );
      await use(api);
      await api.dispose();
    },
    { scope: 'worker' },
  ],

  testData: async ({ adminApi }, use, testInfo) => {
    const registry = new TestDataRegistry(adminApi.context);
    await use(registry);
    await registry.cleanup(testInfo);
  },

  dataConsumer: [
    async ({ adminApi, browser }, use) => {
      const user = new UserClass();
      await user.create(adminApi.context);
      const storageState = await loginOnce(browser, user);
      await use({ user, storageState });
      await user.delete(adminApi.context);
    },
    { scope: 'worker' },
  ],

  dataSteward: [
    async ({ adminApi, browser }, use) => {
      const user = new UserClass();
      await user.create(adminApi.context);
      await user.setDataStewardRole(adminApi.context);
      const storageState = await loginOnce(browser, user);
      await use({ user, storageState });
      await user.delete(adminApi.context);
    },
    { scope: 'worker' },
  ],

  dataConsumerPage: async ({ browser, dataConsumer }, use) => {
    const page = await pageFor(browser, dataConsumer);
    await use(page);
    await page.context().close();
  },

  dataStewardPage: async ({ browser, dataSteward }, use) => {
    const page = await pageFor(browser, dataSteward);
    await use(page);
    await page.context().close();
  },
});

export { expect } from '@playwright/test';
export { ApiClient, expectOk } from './api';
export { TestDataRegistry } from './testData';
