'use strict';
// Windows media session bridge for the Notch music pill (Fase 3a).
// Reads the System Media Transport Controls (SMTC) current session -
// the OS-level "now playing" shared by Spotify, browsers, media players -
// and issues basic transport controls (play/pause/next/previous).
//
// The bridge is a SENSE + REMOTE for the owner's own desktop media: it
// holds no authority, touches no Core state, and never throws across its
// boundary - any failure (no session, no interactive desktop, WinRT
// unavailable) reports { available: false, reason } so Presence can
// project "no media" honestly instead of inventing a track.
//
// Implementation: one fixed PowerShell script (WinRT via
// System.Runtime.WindowsRuntime); the only caller input is the op name,
// mapped through a frozen allowlist - nothing caller-supplied is ever
// interpolated into the script. Results are cached briefly because
// Presence polls on a 1s cadence and a PowerShell spawn costs ~100ms.
const { execFile } = require('node:child_process');

const OPS = Object.freeze({
  get: null,
  play: 'TryPlayAsync',
  pause: 'TryPauseAsync',
  next: 'TrySkipNextAsync',
  previous: 'TrySkipPreviousAsync',
});
const ACTIONS = Object.freeze(Object.keys(OPS).filter(k => k !== 'get'));
const CACHE_MS = 2500, TIMEOUT_MS = 9000;

const SCRIPT = `
$ErrorActionPreference = 'Stop'
$op = '__OP__'
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media, ContentType = WindowsRuntime]
  $null = [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime]
  $null = [Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType = WindowsRuntime]
  $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -like 'IAsyncOperation*' })[0]
  function AwaitOp($asyncOp, $resultType) {
    $task = $asTaskGeneric.MakeGenericMethod($resultType).Invoke($null, @($asyncOp))
    $task.Wait(-1) | Out-Null
    return $task.Result
  }
  $manager = AwaitOp ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
  $session = $manager.GetCurrentSession()
  if ($null -eq $session) { @{ available = $false; reason = 'NO_SESSION' } | ConvertTo-Json -Compress; exit 0 }
  if ($op -ne 'get') {
    $method = '__METHOD__'
    $ok = AwaitOp ($session.$method()) ([bool])
    @{ available = $true; controlled = $ok } | ConvertTo-Json -Compress; exit 0
  }
  $props = AwaitOp ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
  $playback = $session.GetPlaybackInfo()
  $tl = $session.GetTimelineProperties()
  $posSec = 0.0; $durSec = 0.0
  if ($null -ne $tl) {
    $durSec = ($tl.EndTime - $tl.StartTime).TotalSeconds
    $posSec = ($tl.Position - $tl.StartTime).TotalSeconds
    if ($playback.PlaybackStatus -eq 'Playing' -and $null -ne $tl.LastUpdatedTime) {
      $posSec += ([DateTimeOffset]::UtcNow - $tl.LastUpdatedTime).TotalSeconds
    }
    if ($posSec -lt 0) { $posSec = 0 }
    if ($durSec -gt 0 -and $posSec -gt $durSec) { $posSec = $durSec }
  }
  $artB64 = ''; $artType = ''
  if ($null -ne $props.Thumbnail) {
    try {
      $stream = AwaitOp ($props.Thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
      if ($null -ne $stream) {
        # DataReader reads an IInputStream, not the random-access stream
        # itself; some sessions also report an unusable Size, so load a
        # bounded chunk and read whatever actually arrived.
        $reader = New-Object Windows.Storage.Streams.DataReader($stream.GetInputStreamAt(0))
        $loaded = AwaitOp ($reader.LoadAsync([uint32]400000)) ([uint32])
        if ($loaded -gt 0) {
          $bytes = New-Object byte[] ([int]$loaded)
          $reader.ReadBytes($bytes)
          $artB64 = [Convert]::ToBase64String($bytes)
          $artType = [string]$stream.ContentType
        }
        $reader.Dispose(); $stream.Dispose()
      }
    } catch { $artB64 = ''; $artType = '' }
  }
  @{ available = $true; sourceApp = [string]$session.SourceAppUserModelId; title = [string]$props.Title; artist = [string]$props.Artist; album = [string]$props.AlbumTitle; status = [string]$playback.PlaybackStatus; positionSec = [math]::Round($posSec, 1); durationSec = [math]::Round($durSec, 1); artwork = $artB64; artworkType = $artType } | ConvertTo-Json -Compress
} catch {
  @{ available = $false; reason = 'SMTC_ERROR'; detail = [string]$_.Exception.Message } | ConvertTo-Json -Compress
}`;

function defaultRunner(script) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(String(stdout || ''))));
  });
}

function createMediaSession({ runner = defaultRunner, now = Date.now, cacheMs = CACHE_MS } = {}) {
  let cached = null, cachedAt = 0;
  async function run(op) {
    const method = OPS[op];
    const script = SCRIPT.replace('__OP__', op).replace('__METHOD__', method || '');
    const out = await runner(script);
    const line = String(out).split(/\r?\n/).map(s => s.trim()).filter(Boolean).pop();
    const parsed = JSON.parse(line);
    if (!parsed || typeof parsed !== 'object') throw Error('MEDIA_BAD_OUTPUT');
    return parsed;
  }
  return Object.freeze({
    ACTIONS,
    async getSession() {
      if (cached && now() - cachedAt < cacheMs) return cached;
      try {
        const raw = await run('get');
        cached = raw && raw.available === true
          ? { available: true, sourceApp: String(raw.sourceApp || ''), title: String(raw.title || ''), artist: String(raw.artist || ''), album: String(raw.album || ''), status: String(raw.status || ''),
              positionSec: Number.isFinite(raw.positionSec) ? Math.max(0, raw.positionSec) : 0,
              durationSec: Number.isFinite(raw.durationSec) ? Math.max(0, raw.durationSec) : 0,
              artwork: typeof raw.artwork === 'string' && raw.artwork ? 'data:' + (raw.artwork.startsWith('/9j/') ? 'image/jpeg' : raw.artwork.startsWith('iVBOR') ? 'image/png' : raw.artwork.startsWith('UklGR') ? 'image/webp' : (typeof raw.artworkType === 'string' && raw.artworkType.startsWith('image/') ? raw.artworkType : 'image/jpeg')) + ';base64,' + raw.artwork : '' }
          : { available: false, reason: typeof raw?.reason === 'string' ? raw.reason : 'UNAVAILABLE' };
      } catch {
        cached = { available: false, reason: 'SMTC_UNREACHABLE' };
      }
      cachedAt = now();
      return cached;
    },
    async control(action) {
      if (!ACTIONS.includes(action)) {
        const err = Error('MEDIA_ACTION_INVALID'); err.code = 'MEDIA_ACTION_INVALID'; throw err;
      }
      const raw = await run(action);
      cached = null; // playback state changed; next read must be fresh
      return { ok: raw?.controlled === true, available: raw?.available === true };
    },
  });
}

module.exports = { createMediaSession, ACTIONS };
