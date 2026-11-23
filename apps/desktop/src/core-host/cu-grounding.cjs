'use strict';
// HYBRID GROUNDING for Computer-Use: resolve an on-screen target through the
// most reliable channel available, in a fixed order:
//   1. api    - a registered per-app deterministic resolver (app API / macro /
//               known control contract). Most reliable; no pixels involved.
//   2. uia    - Windows UI Automation: find the element by Name/AutomationId
//               inside the exact target window and return its real bounding
//               rectangle centre. Deterministic, resolution-independent.
//   3. vision - no coordinates are invented here; the caller falls back to the
//               model's vision grounding for unmapped targets only.
// The UIA probe is ONE fixed PowerShell script; the window title and element
// name travel as environment data, never inside the script text, so a quote in
// a title cannot become code (same pattern as desktopCapabilities).
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const pexec = promisify(execFile);

const UIA_SCRIPT = [
  'Add-Type -AssemblyName UIAutomationClient',
  'Add-Type -AssemblyName UIAutomationTypes',
  '$root = [System.Windows.Automation.AutomationElement]::RootElement',
  '$cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $env:DAMAR_UIA_TITLE)',
  '$win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)',
  'if (-not $win) { @{ ok = $false; error = "WINDOW_NOT_FOUND" } | ConvertTo-Json -Compress; exit }',
  '$conds = @()',
  'if ($env:DAMAR_UIA_AID) { $conds += New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, $env:DAMAR_UIA_AID) }',
  'if ($env:DAMAR_UIA_NAME) { $conds += New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $env:DAMAR_UIA_NAME) }',
  'foreach ($c in $conds) {',
  '  $el = $win.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $c)',
  '  if ($el) { $r = $el.Current.BoundingRectangle; @{ ok = $true; x = [int]($r.X + $r.Width / 2); y = [int]($r.Y + $r.Height / 2); name = $el.Current.Name; automationId = $el.Current.AutomationId } | ConvertTo-Json -Compress; exit }',
  '}',
  '@{ ok = $false; error = "ELEMENT_NOT_FOUND" } | ConvertTo-Json -Compress',
].join('\n');

async function defaultRunUia({ windowTitle, elementName = null, automationId = null }) {
  const env = {
    ...process.env,
    DAMAR_UIA_TITLE: String(windowTitle || ''),
    DAMAR_UIA_NAME: elementName ? String(elementName) : '',
    DAMAR_UIA_AID: automationId ? String(automationId) : '',
  };
  const { stdout } = await pexec('powershell',
    ['-NoProfile', '-NonInteractive', '-Command', UIA_SCRIPT],
    { timeout: 15000, windowsHide: true, maxBuffer: 256 * 1024, env });
  const line = String(stdout || '').split('\n').map(s => s.trim()).filter(s => s.startsWith('{')).pop();
  if (!line) return { ok: false, error: 'UIA_NO_RESULT' };
  try { return JSON.parse(line); } catch { return { ok: false, error: 'UIA_BAD_RESULT' }; }
}

function createGrounding({ runUia = defaultRunUia, apiResolvers = {} } = {}) {
  return {
    channels: ['api', 'uia', 'vision'],
    async resolve({ app = null, windowTitle = null, elementName = null, automationId = null } = {}) {
      if (app && typeof apiResolvers[app] === 'function') {
        try {
          const hit = await apiResolvers[app]({ windowTitle, elementName, automationId });
          if (hit && Number.isFinite(hit.x) && Number.isFinite(hit.y)) {
            return { channel: 'api', x: Math.round(hit.x), y: Math.round(hit.y), element: hit.element || null };
          }
        } catch { /* fall through to the next channel */ }
      }
      if (windowTitle && (elementName || automationId)) {
        try {
          const hit = await runUia({ windowTitle, elementName, automationId });
          if (hit && hit.ok === true && Number.isFinite(hit.x) && Number.isFinite(hit.y)) {
            return { channel: 'uia', x: hit.x, y: hit.y, element: { name: hit.name || null, automationId: hit.automationId || null } };
          }
        } catch { /* fall through to vision */ }
      }
      return { channel: 'vision', x: null, y: null, note: 'no deterministic channel resolved the target; model vision grounding required' };
    },
  };
}

module.exports = { createGrounding, defaultRunUia, UIA_SCRIPT };
