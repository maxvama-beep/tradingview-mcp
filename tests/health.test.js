/**
 * Tests for all health functions in src/core/health.js.
 * Covers: healthCheck, discover, uiState, launch + DI mocks.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { healthCheck, discover, uiState, launch } from '../src/core/health.js';

// ── Mock helpers ─────────────────────────────────────────────────────────

/**
 * Create a mock evaluate function that returns a fixed value.
 * Calls are tracked in .calls array.
 */
function mockEvaluate(returnValue) {
  const calls = [];
  const fn = async (expr) => {
    calls.push(expr);
    return returnValue;
  };
  fn.calls = calls;
  return fn;
}

function mockTracked(impl) {
  const calls = [];
  const fn = (...args) => {
    calls.push(args);
    return impl(...args);
  };
  fn.calls = calls;
  return fn;
}

const TARGET = { id: 'T1', url: 'https://www.tradingview.com/chart/', title: 'ES1! chart' };

function healthDeps(evalReturn, overrides = {}) {
  const evaluate = mockEvaluate(evalReturn);
  return {
    evaluate,
    _deps: {
      getClient: overrides.getClient || (async () => ({})),
      getTargetInfo: overrides.getTargetInfo || (async () => TARGET),
      evaluate,
    },
  };
}

// ── healthCheck() ────────────────────────────────────────────────────────

describe('healthCheck()', () => {
  it('returns chart state when the chart API is available', async () => {
    const { _deps } = healthDeps({
      url: 'https://www.tradingview.com/chart/', title: 'ES1! chart',
      symbol: 'ES1!', resolution: '5', chartType: 1, apiAvailable: true, studyCount: 4,
    });
    const res = await healthCheck({ _deps });
    assert.equal(res.success, true);
    assert.equal(res.cdp_connected, true);
    assert.equal(res.target_id, 'T1');
    assert.equal(res.target_url, TARGET.url);
    assert.equal(res.target_title, TARGET.title);
    assert.equal(res.chart_symbol, 'ES1!');
    assert.equal(res.chart_resolution, '5');
    assert.equal(res.chart_type, 1);
    assert.equal(res.api_available, true);
    assert.equal(res.study_count, 4);
    assert.equal('api_error' in res, false);
    assert.equal('hint' in res, false);
  });

  it('reports api_error and a hint when the chart API is not ready', async () => {
    const { _deps } = healthDeps({
      url: 'https://www.tradingview.com/chart/', title: 'Loading',
      symbol: 'unknown', resolution: 'unknown', chartType: null,
      apiAvailable: false, apiError: 'Cannot read properties of undefined',
    });
    const res = await healthCheck({ _deps });
    assert.equal(res.success, true);
    assert.equal(res.cdp_connected, true);
    assert.equal(res.api_available, false);
    assert.equal(res.chart_symbol, 'unknown');
    assert.equal(res.chart_type, null);
    assert.equal(res.api_error, 'Cannot read properties of undefined');
    assert.match(res.hint, /still be loading/);
  });

  it('preserves chart_type 0 (Bars) instead of coercing it to null', async () => {
    const { _deps } = healthDeps({ symbol: 'AAPL', resolution: 'D', chartType: 0, apiAvailable: true });
    const res = await healthCheck({ _deps });
    assert.equal(res.chart_type, 0);
  });

  it('falls back to defaults when evaluate returns nothing', async () => {
    const { _deps } = healthDeps(undefined);
    const res = await healthCheck({ _deps });
    assert.equal(res.success, true);
    assert.equal(res.chart_symbol, 'unknown');
    assert.equal(res.chart_resolution, 'unknown');
    assert.equal(res.chart_type, null);
    assert.equal(res.api_available, false);
    assert.equal('study_count' in res, false);
  });

  it('propagates connection errors from getClient', async () => {
    const { _deps } = healthDeps({}, {
      getClient: async () => { throw new Error('ECONNREFUSED 127.0.0.1:9222'); },
    });
    await assert.rejects(() => healthCheck({ _deps }), /ECONNREFUSED/);
  });

  it('evaluates the chart state probe in the page context', async () => {
    const { _deps, evaluate } = healthDeps({ apiAvailable: true });
    await healthCheck({ _deps });
    assert.equal(evaluate.calls.length, 1);
    assert.match(evaluate.calls[0], /TradingViewApi\._activeChartWidgetWV/);
    assert.match(evaluate.calls[0], /getAllStudies/);
  });
});

// ── discover() ───────────────────────────────────────────────────────────

describe('discover()', () => {
  it('counts available vs total API paths', async () => {
    const { _deps } = healthDeps({
      chartApi: { available: true },
      chartWidgetCollection: { available: true },
      chartApiInstance: { available: false, error: 'not defined' },
      bottomWidgetBar: { available: false, error: 'not defined' },
      replayApi: { available: true },
      alertService: { available: false, error: 'not defined' },
    });
    const res = await discover({ _deps });
    assert.equal(res.success, true);
    assert.equal(res.apis_available, 3);
    assert.equal(res.apis_total, 6);
    assert.equal(res.apis.chartApi.available, true);
    assert.equal(res.apis.alertService.error, 'not defined');
  });
});

// ── uiState() ────────────────────────────────────────────────────────────

describe('uiState()', () => {
  it('spreads the evaluated UI state with success: true', async () => {
    const { _deps } = healthDeps({
      bottom_panel: { open: true, height: 300 },
      pine_editor: { open: false, width: 0, height: 0 },
      chart: { symbol: 'NQ1!', resolution: '15', chartType: 1, study_count: 2 },
    });
    const res = await uiState({ _deps });
    assert.equal(res.success, true);
    assert.equal(res.bottom_panel.open, true);
    assert.equal(res.pine_editor.open, false);
    assert.equal(res.chart.symbol, 'NQ1!');
  });
});

// ── launch() ─────────────────────────────────────────────────────────────

function launchDeps(overrides = {}) {
  const spawn = mockTracked(() => ({ pid: 4321, unref() {} }));
  const deps = {
    existsSync: overrides.existsSync || (() => false),
    execSync: overrides.execSync || (() => { throw new Error('not found'); }),
    spawn,
    checkCdp: overrides.checkCdp || (async () => null),
    sleep: mockTracked(async () => {}),
    platform: overrides.platform || 'linux',
    env: overrides.env || { HOME: '/home/u' },
  };
  if (overrides.execSyncTracked) deps.execSync = overrides.execSyncTracked;
  return deps;
}

describe('launch() — binary discovery', () => {
  it('throws with searched paths when TradingView is not installed', async () => {
    const _deps = launchDeps();
    await assert.rejects(() => launch({ _deps }), (err) => {
      assert.match(err.message, /TradingView not found on linux/);
      assert.match(err.message, /\/opt\/TradingView\/tradingview/);
      assert.match(err.message, /--remote-debugging-port=9222/);
      return true;
    });
  });

  it('uses the first existing candidate from the platform path map', async () => {
    const _deps = launchDeps({
      existsSync: (p) => p === '/opt/TradingView/TradingView',
      checkCdp: async () => JSON.stringify({ Browser: 'Chrome/120', 'User-Agent': 'TV' }),
    });
    const res = await launch({ _deps });
    assert.equal(res.binary, '/opt/TradingView/TradingView');
    assert.equal(_deps.spawn.calls[0][0], '/opt/TradingView/TradingView');
  });

  it('falls back to which/where lookup when no candidate path exists', async () => {
    const _deps = launchDeps({
      existsSync: (p) => p === '/usr/local/bin/tradingview',
      execSync: (cmd) => {
        if (cmd.startsWith('which')) return Buffer.from('/usr/local/bin/tradingview\n');
        throw new Error('unexpected');
      },
      checkCdp: async () => JSON.stringify({ Browser: 'Chrome/120' }),
    });
    const res = await launch({ _deps, kill_existing: false });
    assert.equal(res.binary, '/usr/local/bin/tradingview');
  });

  it('falls back to mdfind on macOS when which finds nothing', async () => {
    const mdPath = '/Users/u/Apps/TradingView.app';
    const binary = `${mdPath}/Contents/MacOS/TradingView`;
    const _deps = launchDeps({
      platform: 'darwin',
      existsSync: (p) => p === binary,
      execSync: (cmd) => {
        if (cmd.startsWith('mdfind')) return Buffer.from(`${mdPath}\n`);
        throw new Error('which: not found');
      },
      checkCdp: async () => JSON.stringify({ Browser: 'Chrome/120' }),
    });
    const res = await launch({ _deps, kill_existing: false });
    assert.equal(res.binary, binary);
    assert.equal(res.platform, 'darwin');
  });
});

describe('launch() — process management', () => {
  const FOUND = { existsSync: () => true };

  it('kills existing instances by default (pkill on linux)', async () => {
    const execSync = mockTracked(() => Buffer.from(''));
    const _deps = launchDeps({ ...FOUND, execSyncTracked: execSync, checkCdp: async () => JSON.stringify({}) });
    await launch({ _deps });
    assert.ok(execSync.calls.some(([cmd]) => cmd.includes('pkill -f TradingView')));
  });

  it('uses taskkill on Windows', async () => {
    const execSync = mockTracked(() => Buffer.from(''));
    const _deps = launchDeps({
      ...FOUND, platform: 'win32', execSyncTracked: execSync,
      env: { LOCALAPPDATA: 'C:\\U', PROGRAMFILES: 'C:\\PF', 'PROGRAMFILES(X86)': 'C:\\PF86' },
      checkCdp: async () => JSON.stringify({}),
    });
    await launch({ _deps });
    assert.ok(execSync.calls.some(([cmd]) => cmd.includes('taskkill /F /IM TradingView.exe')));
  });

  it('skips the kill step when kill_existing is false', async () => {
    const execSync = mockTracked(() => Buffer.from(''));
    const _deps = launchDeps({ ...FOUND, execSyncTracked: execSync, checkCdp: async () => JSON.stringify({}) });
    await launch({ _deps, kill_existing: false });
    assert.equal(execSync.calls.some(([cmd]) => cmd.includes('pkill')), false);
  });

  it('spawns detached with the CDP flag and custom port', async () => {
    const checkCdp = mockTracked(async () => JSON.stringify({ Browser: 'Chrome/120' }));
    const _deps = launchDeps({ ...FOUND, checkCdp });
    const res = await launch({ _deps, port: 9333, kill_existing: false });
    const [binary, args, opts] = _deps.spawn.calls[0];
    assert.equal(binary, '/opt/TradingView/tradingview');
    assert.deepEqual(args, ['--remote-debugging-port=9333']);
    assert.equal(opts.detached, true);
    assert.equal(checkCdp.calls[0][0], 9333);
    assert.equal(res.cdp_port, 9333);
    assert.equal(res.cdp_url, 'http://localhost:9333');
  });
});

describe('launch() — CDP readiness polling', () => {
  const FOUND = { existsSync: () => true };

  it('returns browser info once CDP responds', async () => {
    let calls = 0;
    const _deps = launchDeps({
      ...FOUND,
      checkCdp: async () => (++calls < 3 ? null : JSON.stringify({ Browser: 'Chrome/120', 'User-Agent': 'TradingView/2.9' })),
    });
    const res = await launch({ _deps, kill_existing: false });
    assert.equal(res.success, true);
    assert.equal(res.browser, 'Chrome/120');
    assert.equal(res.user_agent, 'TradingView/2.9');
    assert.equal(res.pid, 4321);
    assert.equal(calls, 3);
  });

  it('gives up after 15 polls with a cdp_ready warning', async () => {
    const checkCdp = mockTracked(async () => null);
    const _deps = launchDeps({ ...FOUND, checkCdp });
    const res = await launch({ _deps, kill_existing: false });
    assert.equal(res.success, true);
    assert.equal(res.cdp_ready, false);
    assert.match(res.warning, /tv_health_check/);
    assert.equal(checkCdp.calls.length, 15);
  });

  it('keeps polling past malformed CDP responses', async () => {
    let calls = 0;
    const _deps = launchDeps({
      ...FOUND,
      checkCdp: async () => (++calls === 1 ? 'not json' : JSON.stringify({ Browser: 'Chrome/120' })),
    });
    const res = await launch({ _deps, kill_existing: false });
    assert.equal(res.browser, 'Chrome/120');
    assert.equal(calls, 2);
  });
});
