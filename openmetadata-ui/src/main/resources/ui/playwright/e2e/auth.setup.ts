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
import { expect, request, test as setup } from '@playwright/test';
import { AUTH_STATE, ENV } from '../config/env';
import { JWT_EXPIRY_TIME_MAP } from '../constant/login';
import { AdminClass } from '../support/user/AdminClass';
import { getApiContext } from '../utils/common';
import { updateJWTTokenExpiryTime } from '../utils/login';
import { removeOrganizationPolicyAndRole } from '../utils/team';
const adminFile = AUTH_STATE.admin;

// Health check must pass before authentication is attempted.
setup.describe.configure({ mode: 'serial' });

// Fail fast with one clear message when the server is not ready, instead of
// hundreds of confusing UI timeouts across every shard.
setup('OpenMetadata server is healthy', async () => {
  setup.setTimeout(180_000);
  const api = await request.newContext({ baseURL: ENV.baseURL });
  try {
    await expect(async () => {
      const response = await api.get('/api/v1/system/version');

      expect(response.status(), 'GET /api/v1/system/version').toBe(200);
    }).toPass({ timeout: 120_000, intervals: [2_000, 5_000, 10_000] });
  } finally {
    await api.dispose();
  }
});

setup('authenticate as admin', async ({ page }) => {
  const admin = new AdminClass();

  // login with admin user
  await admin.login(page);
  await page.waitForURL('**/my-data');
  const { apiContext, afterAction } = await getApiContext(page);
  await updateJWTTokenExpiryTime(apiContext, JWT_EXPIRY_TIME_MAP['4 hours']);
  await removeOrganizationPolicyAndRole(apiContext);
  await afterAction();
  await admin.logout(page);
  await page.waitForURL('**/signin');
  await admin.login(page);
  await page.waitForURL('**/my-data');

  // End of authentication steps.
  await page.context().storageState({ path: adminFile });
});
