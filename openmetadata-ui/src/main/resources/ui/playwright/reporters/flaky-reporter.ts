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
 * Makes flakiness visible instead of letting retries hide it.
 *
 * Writes `playwright/output/flaky/<run-label>.json` (machine readable, uploaded by
 * CI and aggregated by the nightly job) and appends a markdown table to the
 * GitHub job summary when `GITHUB_STEP_SUMMARY` is set.
 */
import type {
  FullResult,
  Reporter,
  TestCase,
  TestResult,
} from '@playwright/test/reporter';
import { appendFileSync, mkdirSync, writeFileSync } from 'fs';
import { dirname } from 'path';

type FlakyEntry = {
  title: string;
  file: string;
  line: number;
  project: string;
  retries: number;
  firstError: string;
};

type Options = { outputFile?: string };

export default class FlakyReporter implements Reporter {
  private readonly outputFile: string;
  private readonly flaky = new Map<string, FlakyEntry>();

  constructor(options: Options = {}) {
    this.outputFile = options.outputFile ?? 'playwright/output/flaky/main.json';
  }

  onTestEnd(test: TestCase, result: TestResult) {
    // 'flaky' = at least one failed attempt followed by a passing retry.
    if (test.outcome() !== 'flaky') {
      return;
    }
    const firstFailure = test.results.find((r) => r.status !== 'passed');
    this.flaky.set(test.id, {
      title: test.titlePath().filter(Boolean).slice(1).join(' › '),
      file: test.location.file,
      line: test.location.line,
      project: test.parent.project()?.name ?? '',
      retries: result.retry,
      firstError: (firstFailure?.error?.message ?? '')
        .replace(/\u001b\[[0-9;]*m/g, '') // strip ANSI colours
        .split('\n')[0]
        .slice(0, 200),
    });
  }

  onEnd(result: FullResult) {
    const entries = [...this.flaky.values()];
    mkdirSync(dirname(this.outputFile), { recursive: true });
    writeFileSync(
      this.outputFile,
      JSON.stringify({ status: result.status, flaky: entries }, null, 2)
    );

    const summaryFile = process.env.GITHUB_STEP_SUMMARY;
    if (summaryFile && entries.length) {
      const rows = entries
        .map(
          (e) =>
            `| ${e.title.replace(/\|/g, '\\|')} | \`${e.file
              .split('/playwright/')
              .pop()}:${e.line}\` | ${e.retries} | ${e.firstError.replace(
              /\|/g,
              '\\|'
            )} |`
        )
        .join('\n');
      appendFileSync(
        summaryFile,
        `\n### ⚠️ ${entries.length} flaky Playwright test(s)\n` +
          'These passed only after a retry. Fix or quarantine them ' +
          '(see playwright/README.md → "Flaky test policy").\n\n' +
          '| Test | Location | Retries | First failure |\n|---|---|---|---|\n' +
          `${rows}\n`
      );
    }
  }

  printsToStdio() {
    return false;
  }
}
