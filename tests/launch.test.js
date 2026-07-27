/**
 * Tests for TradingView path resolution in src/core/health.js.
 * Covers: standard install paths, Microsoft Store (MSIX) detection via
 * Get-AppxPackage and WindowsApps directory glob, and the not-found case.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { findTradingViewPath } from '../src/core/health.js';

const WIN_ENV = {
  LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local',
  PROGRAMFILES: 'C:\\Program Files',
  'PROGRAMFILES(X86)': 'C:\\Program Files (x86)',
};

const MSIX_PKG = 'TradingView.Desktop_3.2.0.7916_x64__n534cwy3pjxzj';
const MSIX_EXE = `C:\\Program Files\\WindowsApps\\${MSIX_PKG}\\TradingView.exe`;

/** Build _deps where existsSync is true only for the given paths. */
function mockDeps({ existing = [], execResults = {}, dirEntries = null } = {}) {
  const execCalls = [];
  const deps = {
    existsSync: (p) => existing.includes(p),
    execSync: (cmd) => {
      execCalls.push(cmd);
      for (const [key, val] of Object.entries(execResults)) {
        if (cmd.includes(key)) {
          if (val instanceof Error) throw val;
          return val;
        }
      }
      throw new Error(`command failed: ${cmd}`);
    },
    readdirSync: () => {
      if (dirEntries === null) throw new Error('EPERM: operation not permitted');
      return dirEntries;
    },
  };
  return { _deps: deps, execCalls };
}

describe('findTradingViewPath — win32 standard installs', () => {
  it('finds the %LOCALAPPDATA% install without invoking PowerShell', () => {
    const exe = `${WIN_ENV.LOCALAPPDATA}\\TradingView\\TradingView.exe`;
    const { _deps, execCalls } = mockDeps({ existing: [exe] });
    const { tvPath } = findTradingViewPath({ platform: 'win32', env: WIN_ENV, _deps });
    assert.equal(tvPath, exe);
    assert.equal(execCalls.length, 0, 'no shell commands when a static path matches');
  });

  it('finds the Program Files install', () => {
    const exe = `${WIN_ENV.PROGRAMFILES}\\TradingView\\TradingView.exe`;
    const { _deps } = mockDeps({ existing: [exe] });
    const { tvPath } = findTradingViewPath({ platform: 'win32', env: WIN_ENV, _deps });
    assert.equal(tvPath, exe);
  });
});

describe('findTradingViewPath — win32 MSIX (Microsoft Store)', () => {
  it('resolves via Get-AppxPackage InstallLocation', () => {
    const { _deps, execCalls } = mockDeps({
      existing: [MSIX_EXE],
      execResults: { 'Get-AppxPackage': `C:\\Program Files\\WindowsApps\\${MSIX_PKG}\r\n` },
    });
    const { tvPath } = findTradingViewPath({ platform: 'win32', env: WIN_ENV, _deps });
    assert.equal(tvPath, MSIX_EXE);
    assert.ok(execCalls.some(c => c.includes('Get-AppxPackage -Name TradingView.Desktop')));
  });

  it('falls back to a WindowsApps directory glob when PowerShell fails', () => {
    const { _deps } = mockDeps({
      existing: [MSIX_EXE],
      execResults: { 'Get-AppxPackage': new Error('powershell not found') },
      dirEntries: ['Microsoft.WindowsCalculator_11.0_x64__8wekyb3d8bbwe', MSIX_PKG],
    });
    const { tvPath } = findTradingViewPath({ platform: 'win32', env: WIN_ENV, _deps });
    assert.equal(tvPath, MSIX_EXE);
  });

  it('picks the highest version when multiple MSIX packages exist', () => {
    const oldPkg = 'TradingView.Desktop_3.1.9.8000_x64__n534cwy3pjxzj';
    const newExe = MSIX_EXE;
    const oldExe = `C:\\Program Files\\WindowsApps\\${oldPkg}\\TradingView.exe`;
    const { _deps } = mockDeps({
      existing: [oldExe, newExe],
      execResults: { 'Get-AppxPackage': new Error('no powershell') },
      dirEntries: [oldPkg, MSIX_PKG],
    });
    const { tvPath } = findTradingViewPath({ platform: 'win32', env: WIN_ENV, _deps });
    assert.equal(tvPath, newExe, '3.2.0.7916 beats 3.1.9.8000 despite lexical order');
  });

  it('ignores non-x64 and unrelated package directories', () => {
    const { _deps } = mockDeps({
      existing: [],
      execResults: { 'Get-AppxPackage': '' },
      dirEntries: ['TradingView.Desktop_3.2.0.7916_arm64__n534cwy3pjxzj', 'NotTradingView_1.0_x64__abc'],
    });
    const { tvPath } = findTradingViewPath({ platform: 'win32', env: WIN_ENV, _deps });
    assert.equal(tvPath, null);
  });

  it('survives an ACL-restricted WindowsApps directory', () => {
    const { _deps } = mockDeps({
      existing: [],
      execResults: { 'Get-AppxPackage': '' },
      dirEntries: null, // readdirSync throws EPERM
    });
    const { tvPath, candidates } = findTradingViewPath({ platform: 'win32', env: WIN_ENV, _deps });
    assert.equal(tvPath, null);
    assert.ok(candidates.some(c => c.includes('WindowsApps')), 'error message mentions the MSIX path');
  });
});

describe('findTradingViewPath — other platforms', () => {
  it('finds the macOS app bundle', () => {
    const exe = '/Applications/TradingView.app/Contents/MacOS/TradingView';
    const { _deps } = mockDeps({ existing: [exe] });
    const { tvPath } = findTradingViewPath({ platform: 'darwin', env: { HOME: '/Users/test' }, _deps });
    assert.equal(tvPath, exe);
  });

  it('does not attempt MSIX detection on linux', () => {
    const { _deps, execCalls } = mockDeps({
      existing: ['/opt/TradingView/tradingview'],
    });
    const { tvPath } = findTradingViewPath({ platform: 'linux', env: { HOME: '/home/test' }, _deps });
    assert.equal(tvPath, '/opt/TradingView/tradingview');
    assert.ok(!execCalls.some(c => c.includes('Get-AppxPackage')));
  });
});
