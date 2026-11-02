import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeBalances, simplifyDebts } from '../src/shared/debts.ts';
import { formatMoney, parseAmountInput, toMinor } from '../src/shared/money.ts';
import { allocate, computeShares } from '../src/shared/split.ts';

test('allocate verteilt Rest nach grösstem Rest und Summe stimmt', () => {
  assert.deepEqual(allocate(100, [1, 1, 1]), [34, 33, 33]);
  assert.deepEqual(allocate(1000, [2, 1]), [667, 333]);
  for (const total of [1, 7, 99, 12345]) {
    const parts = allocate(total, [3, 1, 1, 7]);
    assert.equal(parts.reduce((a, b) => a + b, 0), total);
  }
});

test('equal / exact / percent / shares', () => {
  assert.deepEqual(
    computeShares(1000, 'equal', [{ memberId: 1 }, { memberId: 2 }, { memberId: 3 }]).map((s) => s.amount),
    [334, 333, 333],
  );
  assert.deepEqual(
    computeShares(1000, 'exact', [{ memberId: 1, value: 700 }, { memberId: 2, value: 300 }]).map((s) => s.amount),
    [700, 300],
  );
  assert.throws(() => computeShares(1000, 'exact', [{ memberId: 1, value: 700 }]));
  assert.deepEqual(
    computeShares(200000, 'percent', [{ memberId: 1, value: 60 }, { memberId: 2, value: 40 }]).map((s) => s.amount),
    [120000, 80000],
  );
  assert.throws(() => computeShares(1000, 'percent', [{ memberId: 1, value: 60 }]));
  assert.deepEqual(
    computeShares(900, 'shares', [{ memberId: 1, value: 2 }, { memberId: 2, value: 1 }]).map((s) => s.amount),
    [600, 300],
  );
  assert.throws(() => computeShares(900, 'equal', [{ memberId: 1 }, { memberId: 1 }]));
});

test('Salden und vereinfachte Schulden', () => {
  // A zahlt 90 für A,B,C. B zahlt 30 für B,C.
  const balances = computeBalances([
    { currency: 'CHF', payers: [{ memberId: 1, amount: 9000 }], shares: [1, 2, 3].map((m) => ({ memberId: m, amount: 3000 })) },
    { currency: 'CHF', payers: [{ memberId: 2, amount: 3000 }], shares: [2, 3].map((m) => ({ memberId: m, amount: 1500 })) },
  ]);
  const chf = balances.get('CHF')!;
  assert.equal(chf.get(1), 6000);
  assert.equal(chf.get(2), -1500);
  assert.equal(chf.get(3), -4500);
  const debts = simplifyDebts(chf, 'CHF');
  assert.deepEqual(debts, [
    { from: 3, to: 1, amount: 4500, currency: 'CHF' },
    { from: 2, to: 1, amount: 1500, currency: 'CHF' },
  ]);
});

test('Geldformatierung und Eingaben', () => {
  assert.equal(toMinor(12.5, 'CHF'), 1250);
  assert.equal(toMinor(0.1 + 0.2, 'EUR'), 30);
  assert.equal(toMinor(1500, 'JPY'), 1500);
  assert.equal(parseAmountInput("1'250,50"), 1250.5);
  assert.equal(parseAmountInput('abc'), null);
  assert.match(formatMoney(125050, 'CHF'), /1.250\.50/);
  assert.equal(formatMoney(-9334, 'CHF'), `-${formatMoney(9334, 'CHF')}`);
});
