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
import { APIRequestContext, TestInfo } from '@playwright/test';

/**
 * Anything from `playwright/support/**` that knows how to create and delete
 * itself through the REST API (EntityClass, Domain, Glossary, UserClass, ...).
 */
export interface ApiManagedEntity {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  create(apiContext: APIRequestContext, ...args: any[]): Promise<unknown>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete(apiContext: APIRequestContext, ...args: any[]): Promise<unknown>;
}

type CleanupTask = { label: string; run: () => Promise<unknown> };

/**
 * Creates test data through the API and guarantees cleanup, in reverse
 * creation order, even when the test fails or times out.
 *
 * Why: `afterAll` cleanups are skipped when `beforeAll` throws, leak data when
 * a worker crashes, and couple tests in a file together. Test-scoped data with
 * a registry keeps every test independent and retry-safe.
 */
export class TestDataRegistry {
  private readonly tasks: CleanupTask[] = [];

  constructor(private readonly apiContext: APIRequestContext) {}

  /** `const table = await testData.create(new TableClass());` */
  async create<T extends ApiManagedEntity>(
    entity: T,
    ...createArgs: unknown[]
  ): Promise<T> {
    await entity.create(this.apiContext, ...createArgs);
    this.onCleanup(entity.constructor.name, () =>
      entity.delete(this.apiContext)
    );

    return entity;
  }

  /** Register any custom teardown, e.g. restoring a setting you changed. */
  onCleanup(label: string, run: () => Promise<unknown>) {
    this.tasks.push({ label, run });
  }

  /**
   * Runs every cleanup even if some fail. Failures are attached to the report
   * as warnings instead of failing a test whose assertions all passed.
   */
  async cleanup(testInfo?: TestInfo) {
    const failures: string[] = [];
    while (this.tasks.length) {
      const task = this.tasks.pop() as CleanupTask;
      try {
        await task.run();
      } catch (error) {
        failures.push(`${task.label}: ${(error as Error).message}`);
      }
    }
    if (failures.length && testInfo) {
      testInfo.annotations.push({
        type: 'cleanup-warning',
        description: failures.join('\n'),
      });
    }
  }
}
