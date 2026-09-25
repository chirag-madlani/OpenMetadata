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
import { APIRequestContext, APIResponse, request } from '@playwright/test';
import { readFileSync } from 'fs';
import { ENV } from '../config/env';

type RequestOptions = Parameters<APIRequestContext['get']>[1];

const RETRYABLE_STATUS = new Set([502, 503, 504]);
const MAX_GET_ATTEMPTS = 3;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Throws a descriptive error when the response is not 2xx.
 * The default `apiContext.post(...)` silently returns 4xx/5xx, which is the
 * #1 source of "the UI step failed but the real cause was test data" flakes.
 */
export const expectOk = async (response: APIResponse, action: string) => {
  if (response.ok()) {
    return response;
  }
  const body = await response.text().catch(() => '<unreadable body>');

  throw new Error(
    `[api] ${action} failed: ${response.status()} ${response.url()}\n${body}`
  );
};

/** Reads the OM JWT that the app stores in localStorage of a storage state. */
export const readTokenFromStorageState = (storageStatePath: string) => {
  const state = JSON.parse(readFileSync(storageStatePath, 'utf-8'));
  for (const origin of state.origins ?? []) {
    const session = (origin.localStorage ?? []).find(
      (item: { name: string }) => item.name === 'om-session'
    );
    const token = session && JSON.parse(session.value)?.state?.oidcIdToken;
    if (token) {
      return token as string;
    }
  }

  throw new Error(
    `[api] No OM token found in ${storageStatePath}. Did the "setup" project run?`
  );
};

/**
 * Thin, strict wrapper over APIRequestContext used for test data setup.
 * - every call asserts a 2xx status and returns parsed JSON
 * - GETs are retried on gateway errors (idempotent); writes never are
 */
export class ApiClient {
  constructor(readonly context: APIRequestContext) {}

  static async create(token: string) {
    const context = await request.newContext({
      baseURL: ENV.baseURL,
      extraHTTPHeaders: { Authorization: `Bearer ${token}` },
    });

    return new ApiClient(context);
  }

  async get<T = unknown>(url: string, options?: RequestOptions): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const isLastAttempt = attempt >= MAX_GET_ATTEMPTS;
      let response: APIResponse;
      try {
        response = await this.context.get(url, options);
      } catch (networkError) {
        if (isLastAttempt) {
          throw networkError;
        }
        await sleep(500 * attempt);

        continue;
      }
      if (RETRYABLE_STATUS.has(response.status()) && !isLastAttempt) {
        await sleep(500 * attempt);

        continue;
      }
      await expectOk(response, `GET ${url}`);

      return (await response.json()) as T;
    }
  }

  async post<T = unknown>(url: string, data?: unknown): Promise<T> {
    const response = await this.context.post(url, { data });

    return (await expectOk(response, `POST ${url}`)).json() as Promise<T>;
  }

  async put<T = unknown>(url: string, data?: unknown): Promise<T> {
    const response = await this.context.put(url, { data });

    return (await expectOk(response, `PUT ${url}`)).json() as Promise<T>;
  }

  async patch<T = unknown>(url: string, operations: unknown[]): Promise<T> {
    const response = await this.context.patch(url, {
      data: operations,
      headers: { 'Content-Type': 'application/json-patch+json' },
    });

    return (await expectOk(response, `PATCH ${url}`)).json() as Promise<T>;
  }

  /** Deletes are idempotent for cleanup purposes: 404 is treated as success. */
  async delete(url: string) {
    const response = await this.context.delete(url);
    if (response.status() === 404) {
      return;
    }
    await expectOk(response, `DELETE ${url}`);
  }

  async dispose() {
    await this.context.dispose();
  }
}
