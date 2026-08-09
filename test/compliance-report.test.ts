import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';

// The generator is plain JS tooling (like the other scripts/), but the
// rendering itself is pure and worth pinning: COMPLIANCE.md is a claim about
// the target, and a wrong glyph or a miscounted percentage is a false one.
interface TestCase {
  name: string;
  description?: string;
}
interface Results {
  [normalizedName: string]: { status: string; url?: string };
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { renderComplianceReport } = require('../../scripts/compliance-report.js') as {
  renderComplianceReport: (input: { testCases: TestCase[]; results: Results }) => string;
};

const CASES = [
  { name: 'firstTest', description: 'Does the first thing' },
  { name: 'secondTest' },
  { name: 'thirdTest' },
  { name: 'fourthTest' },
];

describe('compliance report rendering', () => {
  test('marks a passing test green and counts it as covered', () => {
    const md = renderComplianceReport({
      testCases: [CASES[0]],
      results: { FIRSTTEST: { status: 'success' } },
    });
    assert.match(md, /🟢/);
    assert.match(md, /100\.00%/);
  });

  test('distinguishes failing, not-applicable and unimplemented tests', () => {
    const md = renderComplianceReport({
      testCases: CASES,
      results: {
        FIRSTTEST: { status: 'success' },
        SECONDTEST: { status: 'failure' },
        THIRDTEST: { status: 'n/a' },
        // fourthTest deliberately absent: never implemented
      },
    });
    const row = (name: string) => md.split('\n').find((l) => l.includes(name)) ?? '';
    assert.match(row('firstTest'), /🟢/);
    assert.match(row('secondTest'), /🔴/);
    assert.match(row('thirdTest'), /⚪/);
    assert.match(row('fourthTest'), /⭕/);
  });

  test('coverage counts only successes, not n/a or missing', () => {
    const md = renderComplianceReport({
      testCases: CASES,
      results: {
        FIRSTTEST: { status: 'success' },
        SECONDTEST: { status: 'failure' },
        THIRDTEST: { status: 'n/a' },
      },
    });
    // 1 of 4.
    assert.match(md, /25\.00%/);
  });

  test('matches results case-insensitively, as the upstream report does', () => {
    const md = renderComplianceReport({
      testCases: [{ name: 'someMixedCaseName' }],
      results: { SOMEMIXEDCASENAME: { status: 'success' } },
    });
    assert.match(md, /🟢/);
  });

  test('includes a test description when the suite gives one', () => {
    const md = renderComplianceReport({
      testCases: [CASES[0]],
      results: { FIRSTTEST: { status: 'success' } },
    });
    assert.match(md, /Does the first thing/);
  });

  test('numbers rows from one, in suite order', () => {
    const md = renderComplianceReport({ testCases: CASES, results: {} });
    const rows = md.split('\n').filter((l) => /^\| \d+ /.test(l));
    assert.equal(rows.length, 4);
    assert.match(rows[0], /^\| 1 .*firstTest/);
    assert.match(rows[3], /^\| 4 .*fourthTest/);
  });

  test('a table cell cannot break the table', () => {
    // Descriptions are upstream data; a stray pipe would silently corrupt the
    // rendered table on GitHub.
    const md = renderComplianceReport({
      testCases: [{ name: 'piped', description: 'a | b' }],
      results: {},
    });
    const row = md.split('\n').find((l) => l.includes('piped')) ?? '';
    // Only unescaped pipes delimit cells; the description's own pipe must be
    // escaped rather than opening a fourth column.
    const delimiters = (row.match(/(?<!\\)\|/g) ?? []).length;
    assert.equal(delimiters, 4, `row has ${delimiters} delimiters: ${row}`);
  });
});
