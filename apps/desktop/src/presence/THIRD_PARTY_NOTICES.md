# Third-party notices — DAMAR Presence

## Coucou (Louis-CFM/coucou) — MIT License (source code only)

- Upstream: https://github.com/Louis-CFM/coucou
- Revision the Owner prototype adapted: `b1bc09de7f7c24a80bd8eca5729b8bee60f66402`.
  Revision reviewed for the feature matrix: `ab98143461dcd80330c310fa6808bc2cee78e8db` (2026-11-21).
- Adapted code: generic island state/timer logic from `windows/src/island/fsm.ts`, carried in
  `renderer/damar-island-fsm.js` (its header keeps the upstream copyright notice).
  `renderer/damar-island.js` (top-edge overlay, pointer wake, click-through, permission peek with Allow/Deny,
  activity ticker) follows the *behaviour* of `windows/src/island/island.ts` / `windows/src-tauri/src/island.rs`;
  no code was copied from those files.
- Not used: Coucou's name, character, icons, sounds or images. Those are not covered by the MIT License (upstream
  `LICENSE-ASSETS.md`: all rights reserved) and none of them is shipped here. The DAMAR character is **Damar Notch**,
  DAMAR's own design (see `renderer/argon-assets/LICENSE-ASSETS.md` for the provenance check).

```
MIT License

Copyright (c) 2026 Louis Raillé

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Cinzel and Cinzel Decorative — SIL Open Font License 1.1

`renderer/fonts/Cinzel-VariableFont_wght.ttf` (Copyright 2020 The Cinzel Project Authors) and
`renderer/fonts/CinzelDecorative-Bold.ttf` (Copyright 2012 Natanael Gama), unmodified, from github.com/google/fonts
(`ofl/cinzel`, `ofl/cinzeldecorative`). Full license texts: `renderer/fonts/OFL-Cinzel.txt`,
`renderer/fonts/OFL-CinzelDecorative.txt`. Bundled so the surface makes no Google Fonts request.

## Electron

Electron 30.5.1 (MIT), devDependency in `package.json`; its bundled Chromium/Node licenses ship in
`node_modules/electron/dist/LICENSES.chromium.html`.
