import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { JSDOM } from 'jsdom';

import BendayState from '../src/state/BendayState.js';
import { BendayDialog } from '../src/ui/BendayDialog.js';
import PhotoshopCmykBridge from '../src/bridge/PhotoshopCmykBridge.js';

function loadDialogDom() {
  const htmlPath = path.resolve(__dirname, '../src/index.html');
  const html = fs.readFileSync(htmlPath, 'utf8');
  return new JSDOM(html, { pretendToBeVisual: true });
}

describe('BendayDialog Pass-2 UXP Regression Suite', () => {
  it('defaults to 355-31 (71.2 LPI), reverts cleanly via #btn-mesh-revert, and safely guards select.options === undefined in UXP', () => {
    const dom = loadDialogDom();
    const doc = dom.window.document;
    const win = dom.window;

    // Verify static HTML hints match 355-31 (71.2 LPI) before JS hydration
    expect(doc.getElementById('readout-lpi-hint').textContent).toBe('Auto: 71.2 LPI');
    expect(doc.getElementById('input-lpi-override').getAttribute('placeholder')).toBe('71.2 (Auto)');
    expect(doc.getElementById('btn-mesh-revert').getAttribute('title')).toBe('Reset Screen Mesh to 355-31');
    expect(doc.getElementById('input-mesh-tpi').getAttribute('value')).toBe('355');
    expect(doc.getElementById('input-thread-um').getAttribute('value')).toBe('31');

    // Emulate UXP Torq DOM where HTMLSelectElement.options is undefined
    const meshSelect = doc.getElementById('input-mesh-preset');
    Object.defineProperty(meshSelect, 'options', {
      get: () => undefined,
      configurable: true,
    });

    const state = new BendayState({ dpi: 600 });
    const dialog = new BendayDialog(doc, state, {});

    expect(state.meshTpi).toBe(355);
    expect(state.threadDiaUm).toBe(31);
    expect(meshSelect.value).toBe('355-31');
    expect(doc.getElementById('btn-mesh-revert').classList.contains('visible')).toBe(false);

    // Switch to 230-48 -> revert button appears; clicking revert restores 355-31 and hides revert button
    meshSelect.value = '230-48';
    meshSelect.dispatchEvent(new win.Event('change'));
    expect(state.meshTpi).toBe(230);
    expect(state.threadDiaUm).toBe(48);
    expect(doc.getElementById('btn-mesh-revert').classList.contains('visible')).toBe(true);

    doc.getElementById('btn-mesh-revert').click();
    expect(state.meshTpi).toBe(355);
    expect(state.threadDiaUm).toBe(31);
    expect(meshSelect.value).toBe('355-31');
    expect(doc.getElementById('btn-mesh-revert').classList.contains('visible')).toBe(false);

    dialog.destroy();
  });

  it('removes #btn-benday-cancel, labels primary button "Halftone" / "Halftoning…", and keeps Escape -> onCancel()', () => {
    const htmlPath = path.resolve(__dirname, '../src/index.html');
    const cssPath = path.resolve(__dirname, '../src/styles.css');
    const html = fs.readFileSync(htmlPath, 'utf8');
    const css = fs.readFileSync(cssPath, 'utf8');

    expect(html).not.toContain('btn-benday-cancel');
    expect(css).not.toContain('#btn-benday-cancel');

    const dom = loadDialogDom();
    const doc = dom.window.document;
    const win = dom.window;

    expect(doc.getElementById('btn-benday-cancel')).toBeNull();
    const btnApply = doc.getElementById('btn-benday-apply');
    expect(btnApply.textContent).toBe('Halftone');

    let cancelCount = 0;
    const state = new BendayState({ dpi: 600 });
    const dialog = new BendayDialog(doc, state, {
      onCancel: () => {
        cancelCount++;
      },
    });

    dialog.setApplying(true, 'Building screens…');
    expect(btnApply.textContent).toBe('Halftoning…');
    expect(btnApply.disabled).toBe(true);

    dialog.setApplying(false, 'Ready');
    expect(btnApply.textContent).toBe('Halftone');
    expect(btnApply.disabled).toBe(false);

    doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(cancelCount).toBe(1);

    dialog.destroy();
  });

  it('toggles Crisp Type & Linework (BVG) directly on #chk-bvg-box and #lbl-bvg clicks without relying on <label> click forwarding', () => {
    const dom = loadDialogDom();
    const doc = dom.window.document;
    const win = dom.window;

    const state = new BendayState({ dpi: 600 });
    const dialog = new BendayDialog(doc, state, {});

    const lblBvg = doc.getElementById('lbl-bvg');
    const chkBvg = doc.getElementById('chk-bvg');
    const chkBvgBox = doc.getElementById('chk-bvg-box');
    expect(lblBvg).not.toBeNull();

    // Block any synthetic <input id="chk-bvg"> click/change forwarding to emulate UXP Torq's broken hidden-input label behavior
    chkBvg.addEventListener('click', (e) => {
      e.stopImmediatePropagation();
      e.preventDefault();
    });

    expect(state.bvg).toBe(true);
    expect(chkBvg.checked).toBe(true);
    expect(chkBvgBox.classList.contains('is-checked')).toBe(true);

    // 1. Clicking #chk-bvg-box toggles true -> false
    chkBvgBox.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(state.bvg).toBe(false);
    expect(chkBvg.checked).toBe(false);
    expect(chkBvgBox.classList.contains('is-checked')).toBe(false);

    // 2. Clicking #lbl-bvg toggles false -> true
    lblBvg.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(state.bvg).toBe(true);
    expect(chkBvg.checked).toBe(true);
    expect(chkBvgBox.classList.contains('is-checked')).toBe(true);

    dialog.destroy();
  });

  it('rejects active Photoshop selections cleanly via validateDocument (ERR_ACTIVE_SELECTION) and queryHasActiveSelection', async () => {
    const mockDocWithSelection = {
      id: 101,
      name: 'Poster.psd',
      mode: 'CMYKColorMode',
      width: 1200,
      height: 1600,
      resolution: 300,
      bitsPerChannel: 8,
      layers: [{ id: 1, name: 'Background' }],
      selection: { bounds: { left: 100, top: 100, right: 400, bottom: 500 } },
    };

    const rejected = PhotoshopCmykBridge.validateDocument({ activeDocument: mockDocWithSelection });
    expect(rejected.ok).toBe(false);
    expect(rejected.code).toBe('ERR_ACTIVE_SELECTION');
    expect(rejected.title).toBe('Active Selection');
    expect(rejected.message).toContain('Deselect');

    // Unselected document (selection.bounds === null) passes cleanly
    const mockDocUnselected = {
      ...mockDocWithSelection,
      selection: { bounds: null },
    };
    const accepted = PhotoshopCmykBridge.validateDocument({ activeDocument: mockDocUnselected });
    expect(accepted.ok).toBe(true);

    // ActionManager fallback detects active selection descriptor
    const hasSelTrue = await PhotoshopCmykBridge.queryHasActiveSelection({
      batchPlay: async () => [{ selection: { _obj: 'rectangle', left: 10, top: 10, right: 50, bottom: 50 } }],
    });
    expect(hasSelTrue).toBe(true);

    const hasSelFalse = await PhotoshopCmykBridge.queryHasActiveSelection({
      batchPlay: async () => [{}],
    });
    expect(hasSelFalse).toBe(false);
  });

  it('resets _customMeshExpanded on applyPressConfig so Load Config restores SAATI preset dropdown after Custom was opened', () => {
    const dom = loadDialogDom();
    const doc = dom.window.document;
    const win = dom.window;

    const state = new BendayState({ dpi: 600 });
    const dialog = new BendayDialog(doc, state, {});

    const meshPreset = doc.getElementById('input-mesh-preset');
    const customMeshRow = doc.getElementById('custom-mesh-row');

    // Expand Custom mesh row
    meshPreset.value = 'custom';
    meshPreset.dispatchEvent(new win.Event('change'));
    expect(dialog._customMeshExpanded).toBe(true);
    expect(customMeshRow.classList.contains('visible')).toBe(true);

    // Load a saved config with SAATI preset 230-40 -> dropdown must show '230-40' and hide #custom-mesh-row!
    state.applyPressConfig({ meshTpi: 230, threadDiaUm: 40 });
    expect(dialog._customMeshExpanded).toBe(false);
    expect(meshPreset.value).toBe('230-40');
    expect(customMeshRow.classList.contains('visible')).toBe(false);

    // Loading a non-catalog custom config { meshTpi: 250, threadDiaUm: 38 } -> dropdown shows 'custom' and reveals #custom-mesh-row!
    state.applyPressConfig({ meshTpi: 250, threadDiaUm: 38 });
    expect(dialog._customMeshExpanded).toBe(true);
    expect(meshPreset.value).toBe('custom');
    expect(customMeshRow.classList.contains('visible')).toBe(true);

    dialog.destroy();
  });
});
