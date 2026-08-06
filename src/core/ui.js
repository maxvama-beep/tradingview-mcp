/**
 * Core UI automation logic.
 */
import { evaluate, evaluateAsync, getClient } from '../connection.js';

export async function click({ by, value }) {
  const escaped = JSON.stringify(value);
  const result = await evaluate(`
    (function() {
      var by = ${JSON.stringify(by)};
      var value = ${escaped};
      var el = null;
      if (by === 'aria-label') el = document.querySelector('[aria-label="' + value.replace(/"/g, '\\\\"') + '"]');
      else if (by === 'data-name') el = document.querySelector('[data-name="' + value.replace(/"/g, '\\\\"') + '"]');
      else if (by === 'text') {
        var candidates = document.querySelectorAll('button, a, [role="button"], [role="menuitem"], [role="tab"]');
        for (var i = 0; i < candidates.length; i++) {
          var text = candidates[i].textContent.trim();
          if (text === value || text.toLowerCase() === value.toLowerCase()) { el = candidates[i]; break; }
        }
      } else if (by === 'class-contains') el = document.querySelector('[class*="' + value.replace(/"/g, '\\\\"') + '"]');
      if (!el) return { found: false };
      el.click();
      return { found: true, tag: el.tagName.toLowerCase(), text: (el.textContent || '').trim().substring(0, 80), aria_label: el.getAttribute('aria-label') || null, data_name: el.getAttribute('data-name') || null };
    })()
  `);
  if (!result || !result.found) throw new Error('No matching element found for ' + by + '="' + value + '"');
  return { success: true, clicked: result };
}

/**
 * Report whether a bottom panel is open, and which mechanism this build uses.
 *
 * TradingView Desktop 3.3 moved the Pine editor out of the bottom widget bar
 * and into a side dialog. `bottomWidgetBar` still exists on 3.3, and after
 * waitForWidgetsInitialized() it registers exactly one widget (backtesting) —
 * the editor is not among them. showWidget()/activateScriptEditorTab() are
 * therefore silent no-ops for the editor on that build, so detect the dialog
 * and drive it directly.
 *
 * Verified against TradingView.Desktop 3.3.0.7992.
 */
async function readPanelState(panel) {
  return evaluate(`
    (function() {
      var panel = ${JSON.stringify(panel)};
      if (panel === 'pine-editor' && document.querySelector('[data-name="pine-dialog-button"]')) {
        // The dialog is removed from the DOM when closed, so presence is the
        // test. Do not use offsetParent: the dialog is position:fixed, which
        // makes offsetParent null even while it is plainly visible.
        return { mode: 'dialog', is_open: !!document.querySelector('[data-name="pine-dialog"]') };
      }
      var bottomArea = document.querySelector('[class*="layout__area--bottom"]');
      var isOpen = !!(bottomArea && bottomArea.offsetHeight > 50);
      if (panel === 'pine-editor') { isOpen = isOpen && !!document.querySelector('.monaco-editor.pine-editor-monaco'); }
      if (panel === 'strategy-tester') { var s = document.querySelector('[data-name="backtesting"]') || document.querySelector('[class*="strategyReport"]'); isOpen = isOpen && !!(s && s.offsetParent); }
      return { mode: 'widget-bar', is_open: isOpen };
    })()
  `);
}

async function performPanelAction(panel, mode, open) {
  if (mode === 'dialog') {
    return evaluate(`
      (function() {
        var wantOpen = ${JSON.stringify(!!open)};
        var dialog = document.querySelector('[data-name="pine-dialog"]');
        if (wantOpen) {
          if (dialog) return { acted: false, reason: 'already open' };
          var btn = document.querySelector('[data-name="pine-dialog-button"]');
          if (!btn) return { acted: false, reason: 'pine dialog button not found' };
          btn.click();
          return { acted: true };
        }
        if (!dialog) return { acted: false, reason: 'already closed' };
        // The toolbar button opens but does not toggle shut; the dialog has its
        // own Close control.
        var btns = dialog.querySelectorAll('button');
        for (var i = 0; i < btns.length; i++) {
          if (btns[i].getAttribute('aria-label') === 'Close') { btns[i].click(); return { acted: true }; }
        }
        return { acted: false, reason: 'no Close control inside pine dialog' };
      })()
    `);
  }
  return evaluate(`
    (function() {
      var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
      if (!bwb) return { acted: false, reason: 'bottomWidgetBar not available' };
      var wantOpen = ${JSON.stringify(!!open)};
      var widgetName = ${JSON.stringify(panel === 'pine-editor' ? 'pine-editor' : 'backtesting')};
      var isPine = ${JSON.stringify(panel === 'pine-editor')};
      if (wantOpen) {
        if (isPine && typeof bwb.activateScriptEditorTab === 'function') bwb.activateScriptEditorTab();
        else if (typeof bwb.showWidget === 'function') bwb.showWidget(widgetName);
        else return { acted: false, reason: 'bottomWidgetBar exposes no show method' };
        return { acted: true };
      }
      // hideWidget(name) was removed in newer TradingView builds; fall back to
      // close() (minimizes the bottom panel) and then hide() (hides the bar).
      if (typeof bwb.hideWidget === 'function') { bwb.hideWidget(widgetName); return { acted: true }; }
      if (typeof bwb.close === 'function') { bwb.close(); return { acted: true }; }
      if (typeof bwb.hide === 'function') { bwb.hide(); return { acted: true }; }
      return { acted: false, reason: 'bottomWidgetBar exposes no hide method' };
    })()
  `);
}

export async function openPanel({ panel, action }) {
  const isBottomPanel = panel === 'pine-editor' || panel === 'strategy-tester';
  if (isBottomPanel) {
    const before = await readPanelState(panel);
    const wasOpen = !!(before && before.is_open);
    const mode = (before && before.mode) || 'widget-bar';
    const wantOpen = action === 'open' || (action === 'toggle' && !wasOpen);
    const wantClose = action === 'close' || (action === 'toggle' && wasOpen);

    if (!wantOpen && !wantClose) {
      return { success: true, panel, action, mode, was_open: wasOpen, performed: 'none' };
    }

    const outcome = await performPanelAction(panel, mode, wantOpen);

    // Confirm the panel actually moved. Reporting 'opened'/'closed' merely
    // because some code ran meant a silent no-op still looked like success.
    let isOpen = wasOpen;
    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, 200));
      const state = await readPanelState(panel);
      isOpen = !!(state && state.is_open);
      if (isOpen === wantOpen) break;
    }

    if (isOpen !== wantOpen) {
      const why = outcome && outcome.reason ? ` (${outcome.reason})` : '';
      throw new Error(
        `Could not ${wantOpen ? 'open' : 'close'} ${panel} on this TradingView build${why}. ` +
        `Detected mechanism: ${mode}. The panel state did not change.`
      );
    }

    return { success: true, panel, action, mode, was_open: wasOpen, performed: wantOpen ? 'opened' : 'closed', verified: true };
  } else {
    // Newer TV builds renamed the right-rail buttons (watchlist is now
    // data-name="base", aria "Watchlist, details, and news"; alerts is
    // data-name="alerts") — keep legacy selectors as fallbacks.
    const selectorMap = {
      'watchlist': { dataNames: ['base-watchlist-widget-button', 'base'], ariaLabels: ['Watchlist', 'Watchlist, details, and news'] },
      'alerts': { dataNames: ['alerts-button', 'alerts'], ariaLabels: ['Alerts'] },
      'trading': { dataNames: ['trading-button'], ariaLabels: ['Trading Panel'] },
    };
    const sel = selectorMap[panel];
    const result = await evaluate(`
      (function() {
        var dataNames = ${JSON.stringify(sel.dataNames)};
        var ariaLabels = ${JSON.stringify(sel.ariaLabels)};
        var action = ${JSON.stringify(action)};
        var btn = null;
        for (var d = 0; d < dataNames.length && !btn; d++) btn = document.querySelector('[data-name="' + dataNames[d] + '"]');
        for (var a = 0; a < ariaLabels.length && !btn; a++) btn = document.querySelector('[aria-label="' + ariaLabels[a] + '"]');
        if (!btn) return { error: 'Button not found for panel: ' + ${JSON.stringify(panel)} };
        var isActive = btn.getAttribute('aria-pressed') === 'true' || btn.classList.contains('isActive') || btn.classList.toString().indexOf('active') !== -1 || btn.classList.toString().indexOf('Active') !== -1;
        var rightArea = document.querySelector('[class*="layout__area--right"]');
        var sidebarOpen = !!(rightArea && rightArea.offsetWidth > 50);
        var isOpen = isActive && sidebarOpen;
        var performed = 'none';
        if (action === 'open' && !isOpen) { btn.click(); performed = 'opened'; }
        else if (action === 'close' && isOpen) { btn.click(); performed = 'closed'; }
        else if (action === 'toggle') { btn.click(); performed = isOpen ? 'closed' : 'opened'; }
        else { performed = isOpen ? 'already_open' : 'already_closed'; }
        return { was_open: isOpen, performed: performed };
      })()
    `);
    if (result && result.error) throw new Error(result.error);
    return { success: true, panel, action, was_open: result?.was_open ?? false, performed: result?.performed ?? 'unknown' };
  }
}

export async function fullscreen() {
  const result = await evaluate(`
    (function() {
      var btn = document.querySelector('[data-name="header-toolbar-fullscreen"]');
      if (!btn) return { found: false };
      btn.click();
      return { found: true };
    })()
  `);
  if (!result || !result.found) throw new Error('Fullscreen button not found');
  return { success: true, action: 'fullscreen_toggled' };
}

export async function layoutList() {
  const layouts = await evaluateAsync(`
    new Promise(function(resolve) {
      try {
        window.TradingViewApi.getSavedCharts(function(charts) {
          if (!charts || !Array.isArray(charts)) { resolve({layouts: [], source: 'internal_api', error: 'getSavedCharts returned no data'}); return; }
          var result = charts.map(function(c) { return { id: c.id || c.chartId || null, name: c.name || c.title || 'Untitled', symbol: c.symbol || null, resolution: c.resolution || null, modified: c.timestamp || c.modified || null }; });
          resolve({layouts: result, source: 'internal_api'});
        });
        setTimeout(function() { resolve({layouts: [], source: 'internal_api', error: 'getSavedCharts timed out'}); }, 5000);
      } catch(e) { resolve({layouts: [], source: 'internal_api', error: e.message}); }
    })
  `);
  return { success: true, layout_count: layouts?.layouts?.length || 0, source: layouts?.source, layouts: layouts?.layouts || [], error: layouts?.error };
}

export async function layoutSwitch({ name }) {
  const escaped = JSON.stringify(name);
  const result = await evaluateAsync(`
    new Promise(function(resolve) {
      try {
        var target = ${escaped};
        if (/^\\d+$/.test(target)) { window.TradingViewApi.loadChartFromServer(target); resolve({success: true, method: 'loadChartFromServer', id: target, source: 'internal_api'}); return; }
        window.TradingViewApi.getSavedCharts(function(charts) {
          if (!charts || !Array.isArray(charts)) { resolve({success: false, error: 'getSavedCharts returned no data', source: 'internal_api'}); return; }
          var match = null;
          for (var i = 0; i < charts.length; i++) { var cname = charts[i].name || charts[i].title || ''; if (cname === target || cname.toLowerCase() === target.toLowerCase()) { match = charts[i]; break; } }
          if (!match) { for (var j = 0; j < charts.length; j++) { var cn = (charts[j].name || charts[j].title || '').toLowerCase(); if (cn.indexOf(target.toLowerCase()) !== -1) { match = charts[j]; break; } } }
          if (!match) { resolve({success: false, error: 'Layout "' + target + '" not found.', source: 'internal_api'}); return; }
          var chartId = match.id || match.chartId;
          window.TradingViewApi.loadChartFromServer(chartId);
          resolve({success: true, method: 'loadChartFromServer', id: chartId, name: match.name || match.title, source: 'internal_api'});
        });
        setTimeout(function() { resolve({success: false, error: 'getSavedCharts timed out', source: 'internal_api'}); }, 5000);
      } catch(e) { resolve({success: false, error: e.message, source: 'internal_api'}); }
    })
  `);
  if (!result?.success) throw new Error(result?.error || 'Unknown error switching layout');

  // Handle "unsaved changes" confirmation dialog
  await new Promise(r => setTimeout(r, 500));
  const dismissed = await evaluate(`
    (function() {
      var btns = document.querySelectorAll('button');
      for (var i = 0; i < btns.length; i++) {
        var text = btns[i].textContent.trim();
        if (/open anyway|don't save|discard/i.test(text)) {
          btns[i].click();
          return true;
        }
      }
      return false;
    })()
  `);

  if (dismissed) await new Promise(r => setTimeout(r, 1000));
  return { success: true, layout: result.name || name, layout_id: result.id, source: result.source, action: 'switched', unsaved_dialog_dismissed: dismissed };
}

export async function keyboard({ key, modifiers }) {
  const c = await getClient();
  let mod = 0;
  if (modifiers) {
    if (modifiers.includes('alt')) mod |= 1;
    if (modifiers.includes('ctrl')) mod |= 2;
    if (modifiers.includes('meta')) mod |= 4;
    if (modifiers.includes('shift')) mod |= 8;
  }
  const keyMap = {
    'Enter': { code: 'Enter', vk: 13 }, 'Escape': { code: 'Escape', vk: 27 }, 'Tab': { code: 'Tab', vk: 9 },
    'Backspace': { code: 'Backspace', vk: 8 }, 'Delete': { code: 'Delete', vk: 46 },
    'ArrowUp': { code: 'ArrowUp', vk: 38 }, 'ArrowDown': { code: 'ArrowDown', vk: 40 },
    'ArrowLeft': { code: 'ArrowLeft', vk: 37 }, 'ArrowRight': { code: 'ArrowRight', vk: 39 },
    'Space': { code: 'Space', vk: 32 }, 'Home': { code: 'Home', vk: 36 }, 'End': { code: 'End', vk: 35 },
    'PageUp': { code: 'PageUp', vk: 33 }, 'PageDown': { code: 'PageDown', vk: 34 },
    'F1': { code: 'F1', vk: 112 }, 'F2': { code: 'F2', vk: 113 }, 'F5': { code: 'F5', vk: 116 },
  };
  const mapped = keyMap[key] || { code: 'Key' + key.toUpperCase(), vk: key.toUpperCase().charCodeAt(0) };
  await c.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: mod, key, code: mapped.code, windowsVirtualKeyCode: mapped.vk });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key, code: mapped.code });
  return { success: true, key, modifiers: modifiers || [] };
}

export async function typeText({ text }) {
  const c = await getClient();
  await c.Input.insertText({ text });
  return { success: true, typed: text.substring(0, 100), length: text.length };
}

export async function hover({ by, value }) {
  const coords = await evaluate(`
    (function() {
      var by = ${JSON.stringify(by)};
      var value = ${JSON.stringify(value)};
      var el = null;
      if (by === 'aria-label') {
        el = document.querySelector('[aria-label="' + value.replace(/"/g, '\\\\"') + '"]');
        if (!el) el = document.querySelector('[aria-label*="' + value.replace(/"/g, '\\\\"') + '"]');
      }
      else if (by === 'data-name') el = document.querySelector('[data-name="' + value.replace(/"/g, '\\\\"') + '"]');
      else if (by === 'text') {
        var candidates = document.querySelectorAll('button, a, [role="button"], [role="menuitem"], [role="tab"], span, div');
        for (var i = 0; i < candidates.length; i++) { var text = candidates[i].textContent.trim(); if (text === value || text.toLowerCase() === value.toLowerCase()) { el = candidates[i]; break; } }
      } else if (by === 'class-contains') el = document.querySelector('[class*="' + value.replace(/"/g, '\\\\"') + '"]');
      if (!el) return null;
      var rect = el.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, tag: el.tagName.toLowerCase() };
    })()
  `);
  if (!coords) throw new Error('Element not found for ' + by + '="' + value + '"');
  const c = await getClient();
  await c.Input.dispatchMouseEvent({ type: 'mouseMoved', x: coords.x, y: coords.y });
  return { success: true, hovered: { by, value, tag: coords.tag, x: coords.x, y: coords.y } };
}

export async function scroll({ direction, amount }) {
  const c = await getClient();
  const px = amount || 300;
  const center = await evaluate(`
    (function() {
      var el = document.querySelector('[data-name="pane-canvas"]') || document.querySelector('[class*="chart-container"]') || document.querySelector('canvas');
      if (!el) return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
      var rect = el.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()
  `);
  let deltaX = 0, deltaY = 0;
  if (direction === 'up') deltaY = -px; else if (direction === 'down') deltaY = px;
  else if (direction === 'left') deltaX = -px; else if (direction === 'right') deltaX = px;
  await c.Input.dispatchMouseEvent({ type: 'mouseWheel', x: center.x, y: center.y, deltaX, deltaY });
  return { success: true, direction, amount: px };
}

export async function mouseClick({ x, y, button, double_click }) {
  const c = await getClient();
  const btn = button === 'right' ? 'right' : button === 'middle' ? 'middle' : 'left';
  const btnNum = btn === 'right' ? 2 : btn === 'middle' ? 1 : 0;
  await c.Input.dispatchMouseEvent({ type: 'mouseMoved', x, y });
  await c.Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: btn, buttons: btnNum, clickCount: 1 });
  await c.Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: btn });
  if (double_click) {
    await new Promise(r => setTimeout(r, 50));
    await c.Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: btn, buttons: btnNum, clickCount: 2 });
    await c.Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: btn });
  }
  return { success: true, x, y, button: btn, double_click: !!double_click };
}

export async function findElement({ query, strategy }) {
  const strat = strategy || 'text';
  const results = await evaluate(`
    (function() {
      var query = ${JSON.stringify(query)};
      var strategy = ${JSON.stringify(strat)};
      var results = [];
      if (strategy === 'css') {
        var els = document.querySelectorAll(query);
        for (var i = 0; i < Math.min(els.length, 20); i++) {
          var rect = els[i].getBoundingClientRect();
          results.push({ tag: els[i].tagName.toLowerCase(), text: (els[i].textContent || '').trim().substring(0, 80), aria_label: els[i].getAttribute('aria-label') || null, data_name: els[i].getAttribute('data-name') || null, x: rect.x, y: rect.y, width: rect.width, height: rect.height, visible: els[i].offsetParent !== null });
        }
      } else if (strategy === 'aria-label') {
        var els = document.querySelectorAll('[aria-label*="' + query.replace(/"/g, '\\\\"') + '"]');
        for (var i = 0; i < Math.min(els.length, 20); i++) {
          var rect = els[i].getBoundingClientRect();
          results.push({ tag: els[i].tagName.toLowerCase(), text: (els[i].textContent || '').trim().substring(0, 80), aria_label: els[i].getAttribute('aria-label') || null, data_name: els[i].getAttribute('data-name') || null, x: rect.x, y: rect.y, width: rect.width, height: rect.height, visible: els[i].offsetParent !== null });
        }
      } else {
        var all = document.querySelectorAll('button, a, [role="button"], [role="menuitem"], [role="tab"], input, select, label, span, div, h1, h2, h3, h4');
        for (var i = 0; i < all.length; i++) {
          var text = all[i].textContent.trim();
          if (text.toLowerCase().indexOf(query.toLowerCase()) !== -1 && text.length < 200) {
            var rect = all[i].getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              results.push({ tag: all[i].tagName.toLowerCase(), text: text.substring(0, 80), aria_label: all[i].getAttribute('aria-label') || null, data_name: all[i].getAttribute('data-name') || null, x: rect.x, y: rect.y, width: rect.width, height: rect.height, visible: all[i].offsetParent !== null });
              if (results.length >= 20) break;
            }
          }
        }
      }
      return results;
    })()
  `);
  return { success: true, query, strategy: strat, count: results?.length || 0, elements: results || [] };
}

export async function uiEvaluate({ expression }) {
  const result = await evaluate(expression);
  return { success: true, result };
}
