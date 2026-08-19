# Graph Report - console  (2026-08-15)

## Corpus Check
- 58 files · ~347,799 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 5112 nodes · 11013 edges · 191 communities (117 shown, 74 thin omitted)
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
- .get
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
- .multiplyScalar
- Vector2
- .equals
- .copy
- WebGLRenderer
- update
- WebGLBackground
- _handleMouseMove
- WebXRManager
- s
- r
- h
- dashboard.js
- n
- icon
- Color
- .push
- .constructor
- b
- KeyframeTrack
- PropertyBinding
- warn
- .load
- l
- Loader
- o
- AnimationAction
- aether.js
- .dispose
- error
- Sphere
- Object3D
- d
- .constructor
- Quaternion
- c
- M
- home.js
- AnimationMixer
- BatchedMesh
- PMREMGenerator
- t
- views/studio.js
- InterleavedBuffer
- Plane
- l
- .setAttribute
- settings.js
- .fromJSON
- PerspectiveCamera
- WebGLBindingStates
- i
- package.json
- AudioListener
- .dispatchEvent
- ._onChangeCallback
- Path
- getParameters
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
- BoxGeometry
- PositionalAudio
- QuadraticBezierCurve
- h
- n
- _applyMinimumContrast
- Cylindrical
- Timer
- properties
- .constructor
- devices.js
- properties
- WebGLMaterials
- add
- Curve
- arraysEqual
- RenderTarget
- Texture
- entity.js
- .dispose
- .push
- F
- .toArray
- addShape
- Layers
- Material
- terminalPanel
- Shape
- setProgram
- k
- .clamp
- safety.js
- addMarker
- openCommandPalette
- AnimationClip
- FrustumArray
- cloneUniforms
- u
- createMemoryGraph
- Clock
- createRow
- GLBufferAttribute
- runtimeStatusPanel
- AnimationObjectGroup
- MaterialLoader
- LoadingManager
- .constructor
- VideoFrameTexture
- addon-fit.js
- CompressedArrayTexture
- DataArrayTexture
- properties
- Fog
- FogExp2
- properties
- properties
- properties
- DodecahedronGeometry
- IcosahedronGeometry
- LinearInterpolant
- OctahedronGeometry
- TetrahedronGeometry
- position
- preload.js
- properties
- definitions
- properties
- properties
- diameter_mm
- .setStyle
- Uint8ClampedBufferAttribute
- WebGLRenderTarget
- AETHER CHARACTER — CANONICAL IMPLEMENTATION RULES
- UniformsGroup
- Light
- CubeDepthTexture
- CubeTexture
- ExternalTexture
- QuaternionLinearInterpolant
- StructuredUniform
- Int16BufferAttribute
- Int32BufferAttribute
- LineLoop

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

## Communities (191 total, 74 thin omitted)

### Community 0 - "three.core.js"
Cohesion: 0.01
Nodes (228): RFC-3987, _addedEvent, _alignedPosition, _axis, _baseVector, _batchIntersects, _boneMatrix, _box (+220 more)

### Community 1 - "three.module.js"
Cohesion: 0.01
Nodes (125): AmbientLight, ArcCurve, ArrayCamera, BezierInterpolant, Bone, BooleanKeyframeTrack, _cache, CanvasTexture (+117 more)

### Community 2 - "$"
Cohesion: 0.02
Nodes (62): $, addDecoration(), _addLineToZone(), _addMouseDownListeners(), addOscHandler(), addRefreshCallback(), areSelectionValuesReversed(), _batchedMemoryCleanup() (+54 more)

### Community 4 - ".normalize"
Cohesion: 0.05
Nodes (7): BufferAttribute, DataUtils, denormalize(), Float16BufferAttribute, InterleavedBufferAttribute, isUniqueEdge(), WireframeGeometry

### Community 7 - "Matrix4"
Cohesion: 0.03
Nodes (4): InstancedMesh, Matrix2, Matrix3, Matrix4

### Community 9 - "esc"
Cohesion: 0.14
Nodes (39): esc(), toast(), fillModels(), enrichProposals(), renderSensors(), checkNearby(), phoneListAction(), refreshCases() (+31 more)

### Community 10 - "get"
Cohesion: 0.10
Nodes (54): createElementNS(), WebGLCapabilities(), getMaxAnisotropy(), textureFormatReadable(), textureTypeReadable(), WebGLProperties(), get(), has() (+46 more)

### Community 11 - ".constructor"
Cohesion: 0.07
Nodes (41): createCanvasElement(), probeAsync(), addUniform(), _createPlanes(), parseUniform(), shadowCastingAndTexturingLightsFirst(), ShadowUniformsCache(), WebGLClipping() (+33 more)

### Community 12 - "Box3"
Cohesion: 0.05
Nodes (5): ascSort(), Box2, Box3, intersect(), Raycaster

### Community 13 - ".dot"
Cohesion: 0.05
Nodes (7): checkGeometryIntersection(), scalePt2(), Line3, Mesh, Ray, satForAxes(), Triangle

### Community 16 - "constructor"
Cohesion: 0.05
Nodes (51): addEncoding(), addProtocol(), _alignRowWidth(), _clearLiveRegion(), clearRange(), clearTextureAtlas(), _computeKeybinding(), _computeKeyCodeChord() (+43 more)

### Community 17 - "ui.js"
Cohesion: 0.07
Nodes (32): aiChoices, api, paths, Store, terminalApi, clockTime(), duration(), el() (+24 more)

### Community 18 - "x"
Cohesion: 0.05
Nodes (3): selectAll(), selectLines(), x

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
Cohesion: 0.05
Nodes (12): DepthTexture, EllipseCurve, HemisphereLight, InstancedBufferAttribute, InstancedBufferGeometry, InstancedInterleavedBuffer, LightProbe, extractFromCache() (+4 more)

### Community 25 - ".dispose"
Cohesion: 0.06
Nodes (20): add(), clearAllMarkers(), clearMarkers(), compositionstart(), _createElement(), de, fire(), G() (+12 more)

### Community 26 - ".applyMatrix4"
Cohesion: 0.07
Nodes (5): BufferGeometry, checkIntersection(), Line, _points, testPoint()

### Community 27 - ".multiplyScalar"
Cohesion: 0.07
Nodes (5): ArrowHelper, handleTriangle(), handleVertex(), LineCurve, LineCurve3

### Community 29 - ".equals"
Cohesion: 0.07
Nodes (34): addContour(), compareXYSlope(), createNode(), cureLocalIntersections(), earcut(), earcutLinked(), eliminateHole(), eliminateHoles() (+26 more)

### Community 30 - ".copy"
Cohesion: 0.04
Nodes (11): Camera, checkIntersection$1(), createColorManagement(), CubeCamera, LightShadow, LOD, PlaneHelper, SkeletonHelper (+3 more)

### Community 31 - "WebGLRenderer"
Cohesion: 0.09
Nodes (14): setupView(), WebGLRenderer, renderObject(), renderObjects(), renderScene(), renderTransmissionPass(), setupLightsView(), WebGLShadowMap() (+6 more)

### Community 32 - "update"
Cohesion: 0.12
Nodes (25): WebGLAttributes(), createBuffer(), get(), remove(), update(), updateBuffer(), WebGLBufferRenderer(), render() (+17 more)

### Community 33 - "WebGLBackground"
Cohesion: 0.39
Nodes (7): getUnlitUniformColorSpace(), WebGLBackground(), addToRenderList(), dispose(), getBackground(), render(), setClear()

### Community 34 - "_handleMouseMove"
Cohesion: 0.08
Nodes (33): _areCoordsInSelection(), _askForLink(), _checkLinkProviderResult(), _clearCurrentLink(), clearSelection(), _createLinkUnderlineEvent(), _fireEventIfSelectionChanged(), _fireOnSelectionChange() (+25 more)

### Community 35 - "WebXRManager"
Cohesion: 0.07
Nodes (12): WebGLAnimation(), onAnimationFrame(), onAnimationFrame(), WebXRManager, onAnimationFrame(), onInputSourcesChange(), onSessionEnd(), onSessionEvent() (+4 more)

### Community 36 - "s"
Cohesion: 0.07
Nodes (9): acquire(), clear(), m(), o(), r(), onDidRemoveLastListener(), s(), T (+1 more)

### Community 37 - "r"
Cohesion: 0.06
Nodes (12): _cancelCallback(), emitOne(), end(), put(), r(), reject(), _requestCallback(), reset() (+4 more)

### Community 38 - "h"
Cohesion: 0.05
Nodes (4): h(), _handleSelectionChange(), has(), warn()

### Community 39 - "dashboard.js"
Cohesion: 0.11
Nodes (13): createOrbitalGauge(), createTimeline(), draw(), setData(), AI_STAGES, dashboard, disconnected(), enrichAgents() (+5 more)

### Community 41 - "icon"
Cohesion: 0.14
Nodes (39): icon(), bytes(), pill(), relativeTime(), truncateText(), drawHealth(), flow(), files (+31 more)

### Community 42 - "Color"
Cohesion: 0.08
Nodes (4): Color, hue2rgb(), LinearToSRGB(), SRGBToLinear()

### Community 43 - ".push"
Cohesion: 0.09
Nodes (7): contains(), createInstance(), fireAsync(), _handleMouseDown(), p(), registerHandler(), shouldForceSelection()

### Community 44 - ".constructor"
Cohesion: 0.40
Nodes (4): addEscHandler(), getPositionOfChildWindowRelativeToAncestorWindow(), getSameOriginWindowChain(), registerEscHandler()

### Community 45 - "b"
Cohesion: 0.09
Nodes (3): b, hook(), unhook()

### Community 46 - "KeyframeTrack"
Cohesion: 0.16
Nodes (3): KeyframeTrack, QuaternionKeyframeTrack, subclip()

### Community 48 - "warn"
Cohesion: 0.07
Nodes (9): Audio, AudioAnalyser, enhanceLogMessage(), getGeometry(), getMaterial(), getTexture(), parseConstant(), setQuaternionFromProperEuler() (+1 more)

### Community 49 - ".load"
Cohesion: 0.12
Nodes (10): AudioLoader, handleError(), FileLoader, readData(), ImageBitmapLoader, ImageLoader, onImageError(), onImageLoad() (+2 more)

### Community 50 - "l"
Cohesion: 0.06
Nodes (7): getJoinedCharacters(), _getJoinedRanges(), l(), _mergeRanges(), _removeIntersectingLinks(), scroll(), _stringRangesToCellRanges()

### Community 51 - "Loader"
Cohesion: 0.09
Nodes (8): BufferGeometryLoader, CompressedTextureLoader, loadTexture(), CubeTextureLoader, loadTexture(), DataTextureLoader, Loader, TextureLoader

### Community 54 - "aether.js"
Cohesion: 0.10
Nodes (20): applyRobot(), blobToBase64(), distortionCurve(), MicRecorder, neural, tts, aether, ask() (+12 more)

### Community 55 - ".dispose"
Cohesion: 0.06
Nodes (8): DirectionalLight, DirectionalLightHelper, HemisphereLightHelper, HTMLTexture, PointLight, SpotLight, SpotLightHelper, VideoTexture

### Community 56 - "error"
Cohesion: 0.13
Nodes (33): error(), WebGLInfo(), update(), WebGLState(), activeTexture(), compressedTexImage2D(), compressedTexImage3D(), compressedTexSubImage2D() (+25 more)

### Community 59 - "d"
Cohesion: 0.09
Nodes (4): d, g, o(), onDidAddFirstListener()

### Community 60 - ".constructor"
Cohesion: 0.33
Nodes (3): AxesHelper, addLine(), addPoint()

### Community 64 - "home.js"
Cohesion: 0.11
Nodes (21): createApp(), render(), select(), unmount(), buildConnectApp(), buildSpaceApp(), buildStudioApp(), devices (+13 more)

### Community 66 - "BatchedMesh"
Cohesion: 0.07
Nodes (8): ascIdSort(), BatchedMesh, CameraHelper, copyArrayContents(), copyAttributeData(), EdgesGeometry, setPoint(), SkinnedMesh

### Community 67 - "PMREMGenerator"
Cohesion: 0.17
Nodes (8): _createRenderTarget(), _getBlurShader(), _getCommonVertexShader(), _getCubemapMaterial(), _getEquirectMaterial(), _getGGXShader(), PMREMGenerator, _setViewport()

### Community 68 - "t"
Cohesion: 0.05
Nodes (23): a(), acquire(), addCsiHandler(), addDcsHandler(), _announceCharacters(), a(), _createSelectionElement(), dispose() (+15 more)

### Community 69 - "views/studio.js"
Cohesion: 0.14
Nodes (21): agents, plugins, skills, SUB, activeSection(), collect(), draftsSection(), drawParams() (+13 more)

### Community 72 - "l"
Cohesion: 0.11
Nodes (6): constructor(), emitOne(), l(), reject(), resolve(), setIfNotSet()

### Community 73 - ".setAttribute"
Cohesion: 0.05
Nodes (12): arrayNeedsUint32(), buildPlane(), CapsuleGeometry, CircleGeometry, CylinderGeometry, generateCap(), generateTorso(), LatheGeometry (+4 more)

### Community 74 - "settings.js"
Cohesion: 0.16
Nodes (23): aiPanel(), automationPanel(), homePanel(), modelField(), modelGlyph(), peoplePanel(), providerFields(), renderDaemonConfig() (+15 more)

### Community 76 - "PerspectiveCamera"
Cohesion: 0.12
Nodes (3): OrthographicCamera, PerspectiveCamera, SpotLightShadow

### Community 77 - "WebGLBindingStates"
Cohesion: 0.14
Nodes (22): WebGLBindingStates(), bindVertexArrayObject(), createBindingState(), createVertexArrayObject(), deleteVertexArrayObject(), disableUnusedAttributes(), dispose(), enableAttribute() (+14 more)

### Community 78 - "i"
Cohesion: 0.05
Nodes (22): _applyScrollModifier(), cancel(), cancelAndSet(), consumeWheelEvent(), doRun(), endUpdate(), _equalEvents(), get() (+14 more)

### Community 79 - "package.json"
Cohesion: 0.10
Nodes (20): electron, dependencies, three, @xterm/addon-fit, @xterm/addon-search, @xterm/xterm, description, devDependencies (+12 more)

### Community 80 - "AudioListener"
Cohesion: 0.10
Nodes (5): AudioContext, AudioListener, ImageUtils, serializeImage(), Source

### Community 84 - "getParameters"
Cohesion: 0.08
Nodes (27): isPackedRGFormat(), getMaxPrecision(), WebGLGeometries(), get(), getWireframeAttribute(), onGeometryDispose(), update(), updateWireframeAttribute() (+19 more)

### Community 85 - "w"
Cohesion: 0.11
Nodes (3): f, keys(), w

### Community 86 - "aetherOverlay.js"
Cohesion: 0.14
Nodes (22): ask(), build(), close(), conversation, finishListening(), openOverlay(), prefs, render() (+14 more)

### Community 89 - "v"
Cohesion: 0.13
Nodes (4): a(), cancelAndSet(), doRun(), v

### Community 91 - "Interpolant"
Cohesion: 0.15
Nodes (3): CubicInterpolant, DiscreteInterpolant, Interpolant

### Community 92 - ".push"
Cohesion: 0.13
Nodes (11): getBoneList(), log(), MultiDrawRenderList, getInteriorPoint(), pointInPolygon(), toJSON(), generateBufferData(), generateIndices() (+3 more)

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
Cohesion: 0.09
Nodes (5): Box3Helper, BoxHelper, GridHelper, PointLightHelper, PolarGridHelper

### Community 100 - "QuadraticBezierCurve"
Cohesion: 0.12
Nodes (6): QuadraticBezier(), QuadraticBezierCurve, QuadraticBezierCurve3, QuadraticBezierP0(), QuadraticBezierP1(), QuadraticBezierP2()

### Community 101 - "h"
Cohesion: 0.18
Nodes (3): get(), h(), has()

### Community 103 - "_applyMinimumContrast"
Cohesion: 0.13
Nodes (12): _addStyle(), ae(), _applyMinimumContrast(), bufferEvents(), forEach(), ge(), getColor(), _getContrastCache() (+4 more)

### Community 107 - "properties"
Cohesion: 0.10
Nodes (22): properties, terminalNode, const, const, const, maximum, minimum, const (+14 more)

### Community 108 - ".constructor"
Cohesion: 0.22
Nodes (12): PolyhedronGeometry, applyRadius(), azimuth(), correctSeam(), correctUV(), correctUVs(), generateUVs(), getVertexByIndex() (+4 more)

### Community 110 - "devices.js"
Cohesion: 0.28
Nodes (10): deviceOptions(), live, renderAudio(), renderVideo(), save(), startAudio(), startVideo(), stopAudio() (+2 more)

### Community 111 - "properties"
Cohesion: 0.11
Nodes (19): const, const, const, const, const, const, const, properties (+11 more)

### Community 112 - "WebGLMaterials"
Cohesion: 0.33
Nodes (14): WebGLMaterials(), refreshMaterialUniforms(), refreshTransformUniform(), refreshUniformsCommon(), refreshUniformsDash(), refreshUniformsDistance(), refreshUniformsLine(), refreshUniformsMatcap() (+6 more)

### Community 113 - "add"
Cohesion: 0.22
Nodes (5): add(), a(), dispose(), onWillAddFirstListener(), r

### Community 115 - "arraysEqual"
Cohesion: 0.21
Nodes (19): allocTexUnits(), arraysEqual(), copyArray(), setValueM2(), setValueM3(), setValueM4(), setValueT1Array(), setValueT2DArrayArray() (+11 more)

### Community 116 - "RenderTarget"
Cohesion: 0.17
Nodes (4): RenderTarget, RenderTarget3D, WebGL3DRenderTarget, WebGLArrayRenderTarget

### Community 118 - "entity.js"
Cohesion: 0.17
Nodes (12): COL, createEntity(), setState(), tick(), mm(), EYE_SHAPES, LEGACY_MAP, PATTERN_WEIGHTS (+4 more)

### Community 120 - ".dispose"
Cohesion: 0.17
Nodes (13): WebGLCubeRenderTarget, WebGLEnvironments(), dispose(), get(), getCube(), getPMREM(), isCubeTextureComplete(), mapTextureMapping() (+5 more)

### Community 121 - ".push"
Cohesion: 0.20
Nodes (3): fireAsync(), p, wrapEvent()

### Community 123 - ".toArray"
Cohesion: 0.09
Nodes (7): CatmullRom(), CatmullRomCurve3, CubicPoly(), init(), flattenJSON(), Skeleton, SplineCurve

### Community 124 - "addShape"
Cohesion: 0.31
Nodes (9): addShape(), addUV(), addVertex(), buildLidFaces(), buildSideFaces(), f3(), f4(), sidewalls() (+1 more)

### Community 127 - "terminalPanel"
Cohesion: 0.35
Nodes (11): terminalPanel(), close(), mount(), open(), openByPurpose(), rename(), render(), renderTabs() (+3 more)

### Community 128 - "Shape"
Cohesion: 0.14
Nodes (4): ExtrudeGeometry, Shape, ShapeGeometry, addShape()

### Community 129 - "setProgram"
Cohesion: 0.14
Nodes (14): getDFGLUT(), refreshFogUniforms(), WebGLMorphtargets(), update(), disposeTexture(), getUniforms(), findLightProbeGrid(), getUniformList() (+6 more)

### Community 133 - "safety.js"
Cohesion: 0.36
Nodes (9): gateCard(), load(), OUTCOME, paint(), safety, stopCard(), trailCard(), VERIFY (+1 more)

### Community 134 - "addMarker"
Cohesion: 0.28
Nodes (7): addLineToLink(), addMarker(), _getEntryIdKey(), register(), registerLink(), _removeMarker(), _removeMarkerFromLink()

### Community 135 - "openCommandPalette"
Cohesion: 0.50
Nodes (7): openCommandPalette(), choose(), close(), filter(), onKey(), paint(), renderList()

### Community 136 - "AnimationClip"
Cohesion: 0.11
Nodes (3): AnimationClip, AnimationLoader, AnimationUtils

### Community 138 - "cloneUniforms"
Cohesion: 0.25
Nodes (5): cloneUniforms(), cloneUniformsGroups(), isThreeObject(), mergeUniforms(), ShaderMaterial

### Community 140 - "createMemoryGraph"
Cohesion: 0.43
Nodes (5): createMemoryGraph(), draw(), setData(), step(), tick()

### Community 142 - "createRow"
Cohesion: 0.17
Nodes (4): _convertViewportColToCharacterIndex(), createRow(), _getWordAt(), _isCharWordSeparator()

### Community 144 - "runtimeStatusPanel"
Cohesion: 0.43
Nodes (5): runtimeStatusPanel(), card(), load(), mount(), restart()

### Community 147 - "LoadingManager"
Cohesion: 0.14
Nodes (6): getArrayBuffer(), getInterleavedBuffer(), getTypedArray(), LoaderUtils, LoadingManager, deserializeImage()

### Community 154 - "properties"
Cohesion: 0.14
Nodes (14): const, properties, maximum, minimum, const, maximum, minimum, axis (+6 more)

### Community 157 - "properties"
Cohesion: 0.14
Nodes (14): properties, type, crownHalo, const, maximum, minimum, innerDiameter_mm, scale (+6 more)

### Community 158 - "properties"
Cohesion: 0.15
Nodes (13): micro_diamond, point, tiny_shard, const, properties, type, color, internalEnergyCore (+5 more)

### Community 159 - "properties"
Cohesion: 0.17
Nodes (12): const, orbitalShell, maximum, minimum, type, properties, type, architecture (+4 more)

### Community 165 - "position"
Cohesion: 0.18
Nodes (11): type, properties, const, x, y, z, facialInterface, interior (+3 more)

### Community 168 - "properties"
Cohesion: 0.18
Nodes (11): items, properties, type, const, curvature_degrees, distance_from_center_mm, length_mm, mustFloat (+3 more)

### Community 169 - "definitions"
Cohesion: 0.20
Nodes (9): type, definitions, cognitiveCore, energySpine, interfaceHead, type, $id, type (+1 more)

### Community 170 - "properties"
Cohesion: 0.20
Nodes (10): const, particles, const, properties, type, defaultDensity, distribution, size_mm (+2 more)

### Community 171 - "properties"
Cohesion: 0.20
Nodes (10): levitationField, properties, type, const, maximum, minimum, outerDiameter_mm, ringCount (+2 more)

### Community 172 - "diameter_mm"
Cohesion: 0.22
Nodes (9): properties, type, const, maximum, minimum, connector, diameter_mm, type (+1 more)

### Community 179 - "AETHER CHARACTER — CANONICAL IMPLEMENTATION RULES"
Cohesion: 0.33
Nodes (5): AETHER CHARACTER — CANONICAL IMPLEMENTATION RULES, LARANGAN KERAS, PRIMARY SILHOUETTE (mandatory), STATE (aether-state.json), WARNA (aether-materials.json)

## Knowledge Gaps
- **395 isolated node(s):** `{
    app,
    BrowserWindow,
    ipcMain,
    shell,
    screen,
    session,
    Menu,
    dialog
}`, `path`, `fs`, `{ spawn }`, `DEV` (+390 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **74 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `$` connect `$` to `.render`, `d`, `addMarker`, `i`, `s`, `.constructor`, `createRow`, `.get`, `constructor`, `x`, `u`, `.dispose`, `_handleMouseMove`, `WebXRManager`, `r`, `h`, `n`, `.push`, `.constructor`, `b`, `l`, `o`, `c`, `M`, `t`, `i`, `._register`, `_applyMinimumContrast`, `F`?**
  _High betweenness centrality (0.210) - this node is a cross-community bridge._
- **Why does `WebGLRenderer` connect `WebGLRenderer` to `three.module.js`, `WebXRManager`, `get`, `.constructor`, `WebGLBindingStates`, `error`, `.dispose`?**
  _High betweenness centrality (0.121) - this node is a cross-community bridge._
- **Why does `_width()` connect `WebXRManager` to `$`?**
  _High betweenness centrality (0.119) - this node is a cross-community bridge._
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
  _395 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `three.core.js` be split into smaller, more focused modules?**
  _Cohesion score 0.007661520869068039 - nodes in this community are weakly interconnected._
- **Should `three.module.js` be split into smaller, more focused modules?**
  _Cohesion score 0.01355847090578118 - nodes in this community are weakly interconnected._
- **Should `$` be split into smaller, more focused modules?**
  _Cohesion score 0.015638207945900255 - nodes in this community are weakly interconnected._