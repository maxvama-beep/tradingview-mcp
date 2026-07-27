/**
 * Tests for getQuote()'s symbol guard.
 *
 * quote_get reads the ACTIVE CHART's bar series. It has no way to fetch an
 * arbitrary ticker. Before the guard, a caller-supplied `symbol` was echoed
 * straight into the response while the prices came from whatever was on the
 * chart — so asking for five different symbols returned the same bars five
 * times, each labelled with the symbol that was asked for.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getQuote } from '../src/core/data.js';

// Stub evaluate() with a chart sitting on NSE:BHEL.
function chartOn(sym, overrides = {}) {
  return {
    evaluate: async () => ({
      symbol: sym,
      time: 1784520900,
      open: 422,
      high: 423.7,
      low: 416.75,
      close: 419.95,
      last: 419.95,
      volume: 1084961,
      description: 'Bharat Heavy Electricals Limited',
      ...overrides,
    }),
  };
}

describe('getQuote() — symbol guard', () => {
  it('returns the chart quote when no symbol is given', async () => {
    const q = await getQuote({ _deps: chartOn('NSE:BHEL') });
    assert.equal(q.success, true);
    assert.equal(q.symbol, 'NSE:BHEL');
    assert.equal(q.last, 419.95);
  });

  it('reports the chart symbol, never the caller-supplied one', async () => {
    const q = await getQuote({ symbol: 'NSE:BHEL', _deps: chartOn('NSE:BHEL') });
    assert.equal(q.symbol, 'NSE:BHEL');
  });

  it('throws when the requested symbol is not on the chart', async () => {
    await assert.rejects(
      () => getQuote({ symbol: 'NSE:BEL', _deps: chartOn('NSE:BHEL') }),
      /currently NSE:BHEL, not NSE:BEL/,
      'must not silently return BHEL data labelled as BEL'
    );
  });

  it('error names chart_set_symbol as the way forward', async () => {
    await assert.rejects(
      () => getQuote({ symbol: 'HINDALCO', _deps: chartOn('NSE:BHEL') }),
      /chart_set_symbol/
    );
  });

  it('matches regardless of exchange prefix', async () => {
    const q = await getQuote({ symbol: 'BHEL', _deps: chartOn('NSE:BHEL') });
    assert.equal(q.success, true);
  });

  it('matches regardless of case', async () => {
    const q = await getQuote({ symbol: 'nse:bhel', _deps: chartOn('NSE:BHEL') });
    assert.equal(q.success, true);
  });

  it('does not confuse BEL with BHEL', async () => {
    await assert.rejects(() => getQuote({ symbol: 'BEL', _deps: chartOn('NSE:BHEL') }));
    const q = await getQuote({ symbol: 'BEL', _deps: chartOn('NSE:BEL') });
    assert.equal(q.success, true);
  });

  it('throws the loading error before the symbol guard when bars are empty', async () => {
    await assert.rejects(
      () => getQuote({ symbol: 'NSE:BEL', _deps: { evaluate: async () => ({ symbol: 'NSE:BHEL' }) } }),
      /may still be loading/
    );
  });
});
