# Graph Report - console  (2026-08-15)

## Corpus Check
- 55 files · ~345,631 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 4941 nodes · 10818 edges · 179 communities (102 shown, 77 thin omitted)
- Extraction: 97% EXTRACTED · 3% INFERRED · 0% AMBIGUOUS · INFERRED: 311 edges (avg confidence: 0.56)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `acb1ccd3`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- three.core.js
- three.module.js
- $
- AetherApi
- .normalize
- d
- i
- Matrix4
- s
- esc
- get
- .constructor
- Box3
- .dot
- l
- Vector4
- constructor
- ui.js
- x
- Vector3
- u
- _
- app.js
- .setValues
- .toJSON
- .dispose
- .applyMatrix4
- .copy
- Vector2
- .equals
- .invert
- WebGLRenderer
- update
- push
- .refresh
- WebXRManager
- s
- r
- h
- dashboard.js
- n
- icon
- Color
- p
- t
- b
- KeyframeTrack
- PropertyBinding
- warn
- LoadingManager
- .push
- .load
- o
- AnimationAction
- aether.js
- .dispose
- error
- Sphere
- Object3D
- d
- .setAttribute
- Quaternion
- c
- M
- home.js
- AnimationMixer
- BatchedMesh
- PMREMGenerator
- a
- views/studio.js
- InterleavedBuffer
- Plane
- l
- .setIndex
- .getAttribute
- .fromJSON
- PerspectiveCamera
- WebGLBindingStates
- v
- package.json
- AudioListener
- .dispatchEvent
- ._onChangeCallback
- Path
- has
- w
- aetherOverlay.js
- c
- i
- v
- b
- Interpolant
- .push
- ._register
- CubicBezier
- main.js
- PropertyMixer
- .dispose
- .addGroup
- PositionalAudio
- QuadraticBezierCurve
- h
- n
- _applyMinimumContrast
- Spherical
- Timer
- LineCurve
- .constructor
- devices.js
- .toArray
- WebGLMaterials
- add
- Curve
- Mesh
- RenderTarget
- Texture
- CurvePath
- WebGLEnvironments
- .push
- F
- Skeleton
- addShape
- Layers
- Material
- terminalPanel
- ExtrudeGeometry
- LightShadow
- k
- delete
- safety.js
- addMarker
- openCommandPalette
- .parse
- FrustumArray
- cloneUniforms
- u
- createMemoryGraph
- Clock
- Shape
- GLBufferAttribute
- runtimeStatusPanel
- AnimationObjectGroup
- MaterialLoader
- .clearSelection
- .constructor
- VideoFrameTexture
- addon-fit.js
- CompressedArrayTexture
- DataArrayTexture
- DataTextureLoader
- Fog
- FogExp2
- .constructor
- TextureUtils
- ConeGeometry
- DodecahedronGeometry
- IcosahedronGeometry
- LinearInterpolant
- OctahedronGeometry
- TetrahedronGeometry
- Uniform
- preload.js
- AmbientLight
- ArrayCamera
- DataTexture
- Float32BufferAttribute
- LineSegments
- StringKeyframeTrack
- Uint8BufferAttribute
- Uint8ClampedBufferAttribute
- WebGLRenderTarget

## God Nodes (most connected - your core abstractions)
1. `$` - 404 edges
2. `d` - 140 edges
3. `AetherApi` - 139 edges
4. `esc()` - 139 edges
5. `icon()` - 114 edges
6. `i()` - 105 edges
7. `s()` - 103 edges
8. `_` - 97 edges
9. `toast()` - 93 edges
10. `u` - 86 edges

## Surprising Connections (you probably didn't know these)
- `notConfigured()` --calls--> `icon()`  [EXTRACTED]
  apps/console/renderer/views/home.js → apps/console/renderer/lib/icons.js
- `render()` --calls--> `icon()`  [EXTRACTED]
  apps/console/renderer/views/panels/terminalPanel.js → apps/console/renderer/lib/icons.js
- `populateVoices()` --calls--> `esc()`  [EXTRACTED]
  apps/console/renderer/views/aether.js → apps/console/renderer/lib/ui.js
- `systemStatus()` --calls--> `esc()`  [EXTRACTED]
  apps/console/renderer/views/dashboard.js → apps/console/renderer/lib/ui.js
- `save()` --calls--> `toast()`  [EXTRACTED]
  apps/console/renderer/views/devices.js → apps/console/renderer/lib/ui.js

## Import Cycles
- None detected.

## Communities (179 total, 77 thin omitted)

### Community 0 - "three.core.js"
Cohesion: 0.01
Nodes (225): RFC-3987, _addedEvent, _alignedPosition, _axis, _baseVector, _batchIntersects, _boneMatrix, _box (+217 more)

### Community 1 - "three.module.js"
Cohesion: 0.01
Nodes (137): ArcCurve, BezierInterpolant, Bone, BooleanKeyframeTrack, _cache, CanvasTexture, ColorKeyframeTrack, ColorManagement (+129 more)

### Community 2 - "$"
Cohesion: 0.02
Nodes (43): $, addDecoration(), _addLineToZone(), addOscHandler(), addRefreshCallback(), areSelectionValuesReversed(), _batchedMemoryCleanup(), clear() (+35 more)

### Community 4 - ".normalize"
Cohesion: 0.05
Nodes (6): BufferAttribute, createColorManagement(), DataUtils, denormalize(), Float16BufferAttribute, InterleavedBufferAttribute

### Community 7 - "Matrix4"
Cohesion: 0.04
Nodes (4): CatmullRomCurve3, Matrix2, Matrix3, Matrix4

### Community 9 - "esc"
Cohesion: 0.09
Nodes (63): esc(), pill(), toast(), fillModels(), checkNearby(), phoneListAction(), refreshCases(), refreshPhoneList() (+55 more)

### Community 10 - "get"
Cohesion: 0.10
Nodes (60): createElementNS(), setValueT1(), setValueT2DArray1(), setValueT3D1(), setValueT6(), getContext(), get(), activeTexture() (+52 more)

### Community 11 - ".constructor"
Cohesion: 0.06
Nodes (39): createCanvasElement(), log(), getDFGLUT(), WebGLClipping(), projectPlanes(), resetGlobalState(), WebGLIndexedBufferRenderer(), render() (+31 more)

### Community 12 - "Box3"
Cohesion: 0.05
Nodes (5): ascSort(), Box2, Box3, intersect(), Raycaster

### Community 13 - ".dot"
Cohesion: 0.06
Nodes (6): checkGeometryIntersection(), Line3, Ray, satForAxes(), testPoint(), Triangle

### Community 14 - "l"
Cohesion: 0.07
Nodes (8): _convertViewportColToCharacterIndex(), getLine(), _getWordAt(), _isCharWordSeparator(), l(), provideLinks(), _reflowSmaller(), _stringRangesToCellRanges()

### Community 16 - "constructor"
Cohesion: 0.05
Nodes (56): addEncoding(), addProtocol(), _alignRowWidth(), _announceCharacters(), _clearLiveRegion(), clearRange(), clearTextureAtlas(), _computeKeybinding() (+48 more)

### Community 17 - "ui.js"
Cohesion: 0.07
Nodes (32): aiChoices, api, paths, Store, terminalApi, clockTime(), duration(), el() (+24 more)

### Community 21 - "_"
Cohesion: 0.05
Nodes (16): _, _bufferColsToStringOffset(), bufferEvents(), cancel(), didOptionsChange(), find(), _findInLine(), findNextWithSelection() (+8 more)

### Community 22 - "app.js"
Cohesion: 0.09
Nodes (47): APPS, appStatus(), buildLauncher(), buildTitlebar(), CATEGORIES, closeLauncher(), connect(), disconnect() (+39 more)

### Community 23 - ".setValues"
Cohesion: 0.04
Nodes (15): LineBasicMaterial, LineDashedMaterial, MeshBasicMaterial, MeshDepthMaterial, MeshDistanceMaterial, MeshLambertMaterial, MeshMatcapMaterial, MeshNormalMaterial (+7 more)

### Community 24 - ".toJSON"
Cohesion: 0.04
Nodes (14): CatmullRom(), DepthTexture, EllipseCurve, HemisphereLight, InstancedBufferAttribute, InstancedBufferGeometry, InstancedInterleavedBuffer, LightProbe (+6 more)

### Community 25 - ".dispose"
Cohesion: 0.05
Nodes (23): add(), clearAllMarkers(), clearMarkers(), compositionstart(), _createElement(), de, fire(), G() (+15 more)

### Community 26 - ".applyMatrix4"
Cohesion: 0.07
Nodes (3): ArrowHelper, BufferGeometry, checkIntersection()

### Community 27 - ".copy"
Cohesion: 0.09
Nodes (7): handleTriangle(), handleVertex(), checkIntersection$1(), scalePt2(), SphericalHarmonics3, Sprite, transformVertex()

### Community 29 - ".equals"
Cohesion: 0.07
Nodes (34): addContour(), compareXYSlope(), createNode(), cureLocalIntersections(), earcut(), earcutLinked(), eliminateHole(), eliminateHoles() (+26 more)

### Community 30 - ".invert"
Cohesion: 0.07
Nodes (3): Camera, CubeCamera, SkeletonHelper

### Community 31 - "WebGLRenderer"
Cohesion: 0.09
Nodes (12): WebGLRenderer, renderObject(), renderObjects(), renderScene(), renderTransmissionPass(), setupLightsView(), WebGLShadowMap(), getDepthMaterial() (+4 more)

### Community 32 - "update"
Cohesion: 0.07
Nodes (42): WebGLAttributes(), createBuffer(), get(), remove(), update(), updateBuffer(), releaseStatesOfGeometry(), WebGLBufferRenderer() (+34 more)

### Community 33 - "push"
Cohesion: 0.07
Nodes (37): getUnlitUniformColorSpace(), addUniform(), parseUniform(), shadowCastingAndTexturingLightsFirst(), ShadowUniformsCache(), WebGLBackground(), addToRenderList(), dispose() (+29 more)

### Community 34 - ".refresh"
Cohesion: 0.06
Nodes (40): _addMouseDownListeners(), _areCoordsInSelection(), _askForLink(), _checkLinkProviderResult(), _clearCurrentLink(), clearSelection(), _createLinkUnderlineEvent(), _dragScroll() (+32 more)

### Community 35 - "WebXRManager"
Cohesion: 0.07
Nodes (12): WebGLAnimation(), onAnimationFrame(), onAnimationFrame(), WebXRDepthSensing, WebXRManager, onInputSourcesChange(), onSessionEnd(), onSessionEvent() (+4 more)

### Community 36 - "s"
Cohesion: 0.07
Nodes (9): acquire(), clear(), m(), o(), r(), onDidRemoveLastListener(), s(), T (+1 more)

### Community 37 - "r"
Cohesion: 0.06
Nodes (12): _cancelCallback(), createInstance(), emitOne(), keys(), put(), r(), reject(), _requestCallback() (+4 more)

### Community 39 - "dashboard.js"
Cohesion: 0.07
Nodes (21): aetherState, ALIAS, CANON, listeners, createEntity(), COLOR, createOrbitalGauge(), createTimeline() (+13 more)

### Community 41 - "icon"
Cohesion: 0.14
Nodes (35): icon(), bytes(), relativeTime(), truncateText(), files, load(), sep(), AUDIT_TONE (+27 more)

### Community 42 - "Color"
Cohesion: 0.07
Nodes (6): Color, handleAlpha(), damp(), hue2rgb(), LinearToSRGB(), SRGBToLinear()

### Community 43 - "p"
Cohesion: 0.09
Nodes (10): contains(), _handleMouseDown(), isMonitoring(), p(), prevCodePoint(), shouldForceSelection(), startMonitoring(), stopMonitoring() (+2 more)

### Community 44 - "t"
Cohesion: 0.06
Nodes (24): acquire(), addCsiHandler(), addDcsHandler(), addEscHandler(), _applyScrollModifier(), consumeWheelEvent(), endUpdate(), _equalEvents() (+16 more)

### Community 45 - "b"
Cohesion: 0.09
Nodes (3): b, hook(), unhook()

### Community 46 - "KeyframeTrack"
Cohesion: 0.08
Nodes (5): AnimationClip, AnimationUtils, KeyframeTrack, QuaternionKeyframeTrack, subclip()

### Community 48 - "warn"
Cohesion: 0.08
Nodes (5): Audio, AudioAnalyser, parseConstant(), setQuaternionFromProperEuler(), warn()

### Community 49 - "LoadingManager"
Cohesion: 0.08
Nodes (14): handleError(), getArrayBuffer(), getInterleavedBuffer(), FileLoader, getTypedArray(), ImageBitmapLoader, ImageLoader, onImageError() (+6 more)

### Community 50 - ".push"
Cohesion: 0.07
Nodes (11): createRow(), getJoinedCharacters(), _getJoinedRanges(), getSameOriginWindowChain(), _mergeRanges(), registerHandler(), scroll(), selectionText() (+3 more)

### Community 51 - ".load"
Cohesion: 0.11
Nodes (8): AudioLoader, BufferGeometryLoader, CompressedTextureLoader, loadTexture(), CubeTextureLoader, loadTexture(), Loader, TextureLoader

### Community 54 - "aether.js"
Cohesion: 0.10
Nodes (20): applyRobot(), blobToBase64(), distortionCurve(), MicRecorder, neural, tts, aether, ask() (+12 more)

### Community 55 - ".dispose"
Cohesion: 0.06
Nodes (8): DirectionalLight, DirectionalLightHelper, HemisphereLightHelper, HTMLTexture, PointLight, SpotLight, SpotLightHelper, VideoTexture

### Community 56 - "error"
Cohesion: 0.12
Nodes (25): enhanceLogMessage(), error(), readData(), WebGLInfo(), update(), WebGLState(), ColorBuffer(), compressedTexImage3D() (+17 more)

### Community 59 - "d"
Cohesion: 0.09
Nodes (4): d, g, o(), onDidAddFirstListener()

### Community 60 - ".setAttribute"
Cohesion: 0.09
Nodes (6): AxesHelper, BoxHelper, addLine(), addPoint(), CapsuleGeometry, LatheGeometry

### Community 64 - "home.js"
Cohesion: 0.11
Nodes (21): createApp(), render(), select(), unmount(), buildConnectApp(), buildSpaceApp(), family, CONTROLLABLE (+13 more)

### Community 66 - "BatchedMesh"
Cohesion: 0.14
Nodes (3): ascIdSort(), BatchedMesh, copyArrayContents()

### Community 67 - "PMREMGenerator"
Cohesion: 0.15
Nodes (9): _createPlanes(), _createRenderTarget(), _getBlurShader(), _getCommonVertexShader(), _getCubemapMaterial(), _getEquirectMaterial(), _getGGXShader(), PMREMGenerator (+1 more)

### Community 69 - "views/studio.js"
Cohesion: 0.14
Nodes (21): buildStudioApp(), plugins, skills, SUB, activeSection(), collect(), draftsSection(), drawParams() (+13 more)

### Community 70 - "InterleavedBuffer"
Cohesion: 0.09
Nodes (3): generateUUID(), InterleavedBuffer, UniformsGroup

### Community 72 - "l"
Cohesion: 0.11
Nodes (6): constructor(), emitOne(), l(), reject(), resolve(), setIfNotSet()

### Community 73 - ".setIndex"
Cohesion: 0.08
Nodes (6): arrayNeedsUint32(), CircleGeometry, PlaneGeometry, RingGeometry, SphereGeometry, TorusGeometry

### Community 74 - ".getAttribute"
Cohesion: 0.15
Nodes (5): CameraHelper, copyAttributeData(), EdgesGeometry, setPoint(), SkinnedMesh

### Community 75 - ".fromJSON"
Cohesion: 0.19
Nodes (5): ObjectLoader, deserializeImage(), getGeometry(), getMaterial(), getTexture()

### Community 76 - "PerspectiveCamera"
Cohesion: 0.12
Nodes (3): OrthographicCamera, PerspectiveCamera, SpotLightShadow

### Community 77 - "WebGLBindingStates"
Cohesion: 0.17
Nodes (21): WebGLBindingStates(), bindVertexArrayObject(), createBindingState(), createVertexArrayObject(), deleteVertexArrayObject(), disableUnusedAttributes(), dispose(), enableAttribute() (+13 more)

### Community 78 - "v"
Cohesion: 0.11
Nodes (7): cancel(), cancelAndSet(), doRun(), isScheduled(), schedule(), v(), work()

### Community 79 - "package.json"
Cohesion: 0.10
Nodes (20): electron, dependencies, three, @xterm/addon-fit, @xterm/addon-search, @xterm/xterm, description, devDependencies (+12 more)

### Community 80 - "AudioListener"
Cohesion: 0.10
Nodes (5): AudioContext, AudioListener, ImageUtils, serializeImage(), Source

### Community 81 - ".dispatchEvent"
Cohesion: 0.11
Nodes (3): Light, Scene, WebXRController

### Community 84 - "has"
Cohesion: 0.16
Nodes (11): isPackedRGFormat(), WebGLCapabilities(), getMaxAnisotropy(), getMaxPrecision(), textureFormatReadable(), textureTypeReadable(), getChannel(), getParameters() (+3 more)

### Community 85 - "w"
Cohesion: 0.11
Nodes (3): f, keys(), w

### Community 86 - "aetherOverlay.js"
Cohesion: 0.22
Nodes (16): ask(), build(), close(), conversation, finishListening(), openOverlay(), prefs, render() (+8 more)

### Community 89 - "v"
Cohesion: 0.13
Nodes (4): a(), cancelAndSet(), doRun(), v

### Community 91 - "Interpolant"
Cohesion: 0.12
Nodes (4): CubicInterpolant, DiscreteInterpolant, Interpolant, QuaternionLinearInterpolant

### Community 92 - ".push"
Cohesion: 0.17
Nodes (9): getBoneList(), MultiDrawRenderList, getInteriorPoint(), pointInPolygon(), toJSON(), generateBufferData(), generateIndices(), generateSegment() (+1 more)

### Community 94 - "CubicBezier"
Cohesion: 0.12
Nodes (7): CubicBezier(), CubicBezierCurve, CubicBezierCurve3, CubicBezierP0(), CubicBezierP1(), CubicBezierP2(), CubicBezierP3()

### Community 95 - "main.js"
Cohesion: 0.17
Nodes (13): {
    app,
    BrowserWindow,
    ipcMain,
    shell,
    screen,
    session,
    Menu,
    dialog
}, daemonEntry(), DEFAULT_SETTINGS, DEV, fs, path, probeDaemon(), readSettings() (+5 more)

### Community 97 - ".dispose"
Cohesion: 0.12
Nodes (5): Box3Helper, GridHelper, PlaneHelper, PointLightHelper, PolarGridHelper

### Community 98 - ".addGroup"
Cohesion: 0.13
Nodes (5): BoxGeometry, buildPlane(), CylinderGeometry, generateCap(), generateTorso()

### Community 100 - "QuadraticBezierCurve"
Cohesion: 0.12
Nodes (6): QuadraticBezier(), QuadraticBezierCurve, QuadraticBezierCurve3, QuadraticBezierP0(), QuadraticBezierP1(), QuadraticBezierP2()

### Community 101 - "h"
Cohesion: 0.18
Nodes (3): get(), h(), has()

### Community 103 - "_applyMinimumContrast"
Cohesion: 0.13
Nodes (12): _addStyle(), ae(), _applyMinimumContrast(), bufferEvents(), forEach(), ge(), getColor(), _getContrastCache() (+4 more)

### Community 108 - ".constructor"
Cohesion: 0.22
Nodes (12): PolyhedronGeometry, applyRadius(), azimuth(), correctSeam(), correctUV(), correctUVs(), generateUVs(), getVertexByIndex() (+4 more)

### Community 110 - "devices.js"
Cohesion: 0.24
Nodes (12): deviceOptions(), devices, live, renderAudio(), renderSensors(), renderVideo(), save(), startAudio() (+4 more)

### Community 112 - "WebGLMaterials"
Cohesion: 0.33
Nodes (14): WebGLMaterials(), refreshMaterialUniforms(), refreshTransformUniform(), refreshUniformsCommon(), refreshUniformsDash(), refreshUniformsDistance(), refreshUniformsLine(), refreshUniformsMatcap() (+6 more)

### Community 113 - "add"
Cohesion: 0.22
Nodes (5): add(), a(), dispose(), onWillAddFirstListener(), r

### Community 115 - "Mesh"
Cohesion: 0.17
Nodes (3): Line, Mesh, _points

### Community 116 - "RenderTarget"
Cohesion: 0.17
Nodes (4): RenderTarget, RenderTarget3D, WebGL3DRenderTarget, WebGLArrayRenderTarget

### Community 120 - "WebGLEnvironments"
Cohesion: 0.26
Nodes (10): WebGLCubeRenderTarget, WebGLEnvironments(), dispose(), get(), getCube(), getPMREM(), isCubeTextureComplete(), mapTextureMapping() (+2 more)

### Community 121 - ".push"
Cohesion: 0.20
Nodes (3): fireAsync(), p, wrapEvent()

### Community 123 - "Skeleton"
Cohesion: 0.22
Nodes (3): CubicPoly(), init(), Skeleton

### Community 124 - "addShape"
Cohesion: 0.31
Nodes (9): addShape(), addUV(), addVertex(), buildLidFaces(), buildSideFaces(), f3(), f4(), sidewalls() (+1 more)

### Community 127 - "terminalPanel"
Cohesion: 0.38
Nodes (11): terminalPanel(), close(), mount(), open(), openByPurpose(), rename(), render(), renderTabs() (+3 more)

### Community 128 - "ExtrudeGeometry"
Cohesion: 0.20
Nodes (3): ExtrudeGeometry, ShapeGeometry, addShape()

### Community 131 - "delete"
Cohesion: 0.29
Nodes (10): delete(), _flushCleanupDeleted(), _flushCleanupInserted(), _flushDeleted(), _flushInserted(), forEachByKey(), getKeyIterator(), insert() (+2 more)

### Community 133 - "safety.js"
Cohesion: 0.36
Nodes (9): gateCard(), load(), OUTCOME, paint(), safety, stopCard(), trailCard(), VERIFY (+1 more)

### Community 134 - "addMarker"
Cohesion: 0.28
Nodes (7): addLineToLink(), addMarker(), _getEntryIdKey(), register(), registerLink(), _removeMarker(), _removeMarkerFromLink()

### Community 135 - "openCommandPalette"
Cohesion: 0.50
Nodes (7): openCommandPalette(), choose(), close(), filter(), onKey(), paint(), renderList()

### Community 136 - ".parse"
Cohesion: 0.25
Nodes (3): AnimationLoader, getTrackTypeForValueTypeName(), parseKeyframeTrack()

### Community 138 - "cloneUniforms"
Cohesion: 0.25
Nodes (5): cloneUniforms(), cloneUniformsGroups(), isThreeObject(), mergeUniforms(), ShaderMaterial

### Community 140 - "createMemoryGraph"
Cohesion: 0.43
Nodes (5): createMemoryGraph(), draw(), setData(), step(), tick()

### Community 144 - "runtimeStatusPanel"
Cohesion: 0.43
Nodes (5): runtimeStatusPanel(), card(), load(), mount(), restart()

### Community 147 - ".clearSelection"
Cohesion: 0.33
Nodes (5): disable(), end(), _handleBufferActivate(), handleTrim(), reset()

## Knowledge Gaps
- **303 isolated node(s):** `{
    app,
    BrowserWindow,
    ipcMain,
    shell,
    screen,
    session,
    Menu,
    dialog
}`, `path`, `fs`, `{ spawn }`, `DEV` (+298 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **77 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `$` connect `$` to `delete`, `.render`, `d`, `addMarker`, `i`, `s`, `.constructor`, `l`, `constructor`, `x`, `.clearSelection`, `u`, `.dispose`, `.refresh`, `WebXRManager`, `r`, `h`, `n`, `p`, `t`, `b`, `.push`, `o`, `c`, `M`, `a`, `v`, `._register`, `_applyMinimumContrast`, `F`?**
  _High betweenness centrality (0.227) - this node is a cross-community bridge._
- **Why does `WebGLRenderer` connect `WebGLRenderer` to `three.module.js`, `push`, `WebXRManager`, `get`, `.constructor`, `has`, `error`?**
  _High betweenness centrality (0.125) - this node is a cross-community bridge._
- **Why does `_width()` connect `WebXRManager` to `$`?**
  _High betweenness centrality (0.123) - this node is a cross-community bridge._
- **What connects `{
    app,
    BrowserWindow,
    ipcMain,
    shell,
    screen,
    session,
    Menu,
    dialog
}`, `path`, `fs` to the rest of the system?**
  _303 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `three.core.js` be split into smaller, more focused modules?**
  _Cohesion score 0.007751707751707752 - nodes in this community are weakly interconnected._
- **Should `three.module.js` be split into smaller, more focused modules?**
  _Cohesion score 0.014620548412788714 - nodes in this community are weakly interconnected._
- **Should `$` be split into smaller, more focused modules?**
  _Cohesion score 0.016773832820799552 - nodes in this community are weakly interconnected._