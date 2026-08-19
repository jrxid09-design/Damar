# Graph Report - renderer  (2026-08-15)

## Corpus Check
- 55 files · ~346,871 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 5074 nodes · 10957 edges · 182 communities (113 shown, 69 thin omitted)
- Extraction: 97% EXTRACTED · 3% INFERRED · 0% AMBIGUOUS · INFERRED: 311 edges (avg confidence: 0.56)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `acb1ccd3`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- three.core.js
- $
- three.module.js
- AetherApi
- d
- i
- .constructor
- t
- s
- Object3D
- .copy
- warn
- o
- .subVectors
- x
- .push
- get
- .multiplyScalar
- Vector3
- constructor
- _
- app.js
- Box3
- .toJSON
- .setValues
- u
- dashboard.js
- l
- esc
- .normalize
- Vector2
- WebGLRenderer
- KeyframeTrack
- .dispose
- h
- Curve
- s
- PropertyBinding
- .fromBufferAttribute
- ui.js
- M
- r
- n
- earcutLinked
- .multiplyMatrices
- Color
- Vector4
- WebXRManager
- b
- Store
- .get
- icon
- Quaternion
- AnimationAction
- BatchedMesh
- Matrix4
- toast
- .dispose
- Matrix3
- PMREMGenerator
- views/studio.js
- d
- a
- c
- aetherOverlay.js
- Plane
- push
- AnimationMixer
- .dispose
- Sphere
- WebGLState
- update
- _askForLink
- BufferGeometry
- l
- v
- p
- LoadingManager
- PropertyMixer
- InterleavedBuffer
- PerspectiveCamera
- WebGLBindingStates
- properties
- .load
- .dispatchEvent
- Path
- .fromJSON
- w
- Audio
- .fromArray
- c
- i
- properties
- Euler
- arraysEqual
- v
- b
- CubicBezier
- aether.js
- QuadraticBezierCurve
- h
- n
- Camera
- .parse
- Timer
- .constructor
- devices.js
- properties
- properties
- WebGLMaterials
- add
- Interpolant
- RenderTarget
- Texture
- properties
- properties
- .connect
- BoxGeometry
- Skeleton
- getParameters
- .push
- F
- properties
- position
- properties
- .toShapes
- Loader
- addShape
- PositionalAudio
- .splice
- definitions
- properties
- Raycaster
- Layers
- Material
- k
- delete
- safety.js
- diameter_mm
- states.js
- AudioListener
- cloneUniforms
- Cylindrical
- u
- Clock
- AudioAnalyser
- GLBufferAttribute
- Spherical
- runtimeStatusPanel
- tools.js
- AETHER CHARACTER — CANONICAL IMPLEMENTATION RULES
- CapsuleGeometry
- MaterialLoader
- UniformsGroup
- VideoFrameTexture
- addon-fit.js
- motion.js
- CompressedArrayTexture
- DataArrayTexture
- DataTextureLoader
- Fog
- FogExp2
- ImageBitmapLoader
- TextureUtils
- CircleGeometry
- CubeDepthTexture
- CylinderGeometry
- DodecahedronGeometry
- ExternalTexture
- IcosahedronGeometry
- LatheGeometry
- LinearInterpolant
- MultiDrawRenderList
- OctahedronGeometry
- TetrahedronGeometry
- TorusGeometry
- TorusKnotGeometry

## God Nodes (most connected - your core abstractions)
1. `$` - 404 edges
2. `esc()` - 140 edges
3. `d` - 140 edges
4. `AetherApi` - 139 edges
5. `icon()` - 114 edges
6. `i()` - 105 edges
7. `s()` - 103 edges
8. `_` - 97 edges
9. `toast()` - 93 edges
10. `u` - 86 edges

## Surprising Connections (you probably didn't know these)
- `render()` --calls--> `icon()`  [EXTRACTED]
  apps/console/renderer/views/panels/terminalPanel.js → apps/console/renderer/lib/icons.js
- `populateVoices()` --calls--> `esc()`  [EXTRACTED]
  apps/console/renderer/views/aether.js → apps/console/renderer/lib/ui.js
- `systemStatus()` --calls--> `esc()`  [EXTRACTED]
  apps/console/renderer/views/dashboard.js → apps/console/renderer/lib/ui.js
- `save()` --calls--> `toast()`  [EXTRACTED]
  apps/console/renderer/views/devices.js → apps/console/renderer/lib/ui.js
- `wire()` --calls--> `toast()`  [EXTRACTED]
  apps/console/renderer/views/home.js → apps/console/renderer/lib/ui.js

## Import Cycles
- None detected.

## Communities (182 total, 69 thin omitted)

### Community 0 - "three.core.js"
Cohesion: 0.01
Nodes (227): RFC-3987, _addedEvent, _alignedPosition, _axis, _baseVector, _batchIntersects, _boneMatrix, _box (+219 more)

### Community 1 - "$"
Cohesion: 0.01
Nodes (83): $, addCsiHandler(), addDcsHandler(), addDecoration(), addLineToLink(), _addLineToZone(), addMarker(), _addMouseDownListeners() (+75 more)

### Community 2 - "three.module.js"
Cohesion: 0.01
Nodes (131): AmbientLight, ArcCurve, ArrayCamera, AudioContext, BezierInterpolant, Bone, BooleanKeyframeTrack, _cache (+123 more)

### Community 6 - ".constructor"
Cohesion: 0.06
Nodes (43): createCanvasElement(), getDFGLUT(), dispose(), WebGLClipping(), projectPlanes(), resetGlobalState(), WebGLIndexedBufferRenderer(), renderInstances() (+35 more)

### Community 7 - "t"
Cohesion: 0.04
Nodes (32): acquire(), _announceCharacters(), _applyScrollModifier(), a(), consumeWheelEvent(), _createSelectionElement(), dispose(), ee (+24 more)

### Community 9 - "Object3D"
Cohesion: 0.05
Nodes (3): LOD, Object3D, StereoCamera

### Community 10 - ".copy"
Cohesion: 0.07
Nodes (8): checkIntersection(), checkIntersection$1(), FrustumArray, Line, Mesh, _points, testPoint(), transformVertex()

### Community 11 - "warn"
Cohesion: 0.08
Nodes (47): createElementNS(), enhanceLogMessage(), error(), ImageUtils, serializeImage(), warn(), includeReplacer(), setValueT1() (+39 more)

### Community 12 - "o"
Cohesion: 0.05
Nodes (8): openCommandPalette(), choose(), close(), filter(), onKey(), paint(), renderList(), o()

### Community 13 - ".subVectors"
Cohesion: 0.05
Nodes (6): checkGeometryIntersection(), scalePt2(), Ray, satForAxes(), SphericalHarmonics3, Triangle

### Community 14 - "x"
Cohesion: 0.05
Nodes (3): selectAll(), selectLines(), x

### Community 15 - ".push"
Cohesion: 0.06
Nodes (18): arrayNeedsUint32(), buildPlane(), generateCap(), generateTorso(), ExtrudeGeometry, getBoneList(), isUniqueEdge(), PlaneGeometry (+10 more)

### Community 16 - "get"
Cohesion: 0.08
Nodes (52): probeAsync(), WebGLAttributes(), get(), remove(), update(), updateBuffer(), releaseStatesOfGeometry(), WebGLCapabilities() (+44 more)

### Community 17 - ".multiplyScalar"
Cohesion: 0.07
Nodes (4): handleTriangle(), handleVertex(), Line3, toHalfFloat()

### Community 19 - "constructor"
Cohesion: 0.05
Nodes (51): addEncoding(), addProtocol(), _alignRowWidth(), _clearLiveRegion(), clearRange(), clearTextureAtlas(), _computeKeybinding(), _computeKeyCodeChord() (+43 more)

### Community 20 - "_"
Cohesion: 0.05
Nodes (16): _, _bufferColsToStringOffset(), bufferEvents(), cancel(), didOptionsChange(), find(), _findInLine(), findNextWithSelection() (+8 more)

### Community 21 - "app.js"
Cohesion: 0.09
Nodes (48): APPS, appStatus(), buildLauncher(), buildTitlebar(), CATEGORIES, closeLauncher(), connect(), disconnect() (+40 more)

### Community 23 - ".toJSON"
Cohesion: 0.04
Nodes (14): CatmullRom(), DepthTexture, EllipseCurve, HemisphereLight, InstancedBufferAttribute, InstancedBufferGeometry, InstancedInterleavedBuffer, LightProbe (+6 more)

### Community 24 - ".setValues"
Cohesion: 0.04
Nodes (15): LineBasicMaterial, LineDashedMaterial, MeshBasicMaterial, MeshDepthMaterial, MeshDistanceMaterial, MeshLambertMaterial, MeshMatcapMaterial, MeshNormalMaterial (+7 more)

### Community 26 - "dashboard.js"
Cohesion: 0.05
Nodes (31): aetherState, ALIAS, CANON, listeners, COL, createEntity(), tick(), makeDotTexture() (+23 more)

### Community 27 - "l"
Cohesion: 0.05
Nodes (10): createRow(), getJoinedCharacters(), l(), provideLinks(), _reflowSmaller(), scroll(), selectionText(), translateBufferLineToString() (+2 more)

### Community 28 - "esc"
Cohesion: 0.11
Nodes (46): bytes(), esc(), pill(), loadUsage(), table(), usageBars(), appCenter(), backupPanel() (+38 more)

### Community 29 - ".normalize"
Cohesion: 0.07
Nodes (4): BufferAttribute, DataUtils, denormalize(), Float16BufferAttribute

### Community 31 - "WebGLRenderer"
Cohesion: 0.08
Nodes (15): WebGLLights(), setupView(), WebGLRenderer, renderObject(), renderObjects(), renderScene(), renderTransmissionPass(), setupLightsView() (+7 more)

### Community 32 - "KeyframeTrack"
Cohesion: 0.07
Nodes (8): AnimationClip, AnimationLoader, AnimationUtils, getTrackTypeForValueTypeName(), KeyframeTrack, parseKeyframeTrack(), QuaternionKeyframeTrack, subclip()

### Community 33 - ".dispose"
Cohesion: 0.06
Nodes (20): add(), clearAllMarkers(), clearMarkers(), compositionstart(), _createElement(), de, fire(), G() (+12 more)

### Community 35 - "Curve"
Cohesion: 0.07
Nodes (4): Curve, CurvePath, LineCurve, LineCurve3

### Community 36 - "s"
Cohesion: 0.07
Nodes (9): acquire(), clear(), m(), o(), r(), onDidRemoveLastListener(), s(), T (+1 more)

### Community 37 - "PropertyBinding"
Cohesion: 0.06
Nodes (3): AnimationObjectGroup, Composite, PropertyBinding

### Community 38 - ".fromBufferAttribute"
Cohesion: 0.09
Nodes (4): copyAttributeData(), InterleavedBufferAttribute, log(), onContextLost()

### Community 39 - "ui.js"
Cohesion: 0.10
Nodes (24): aiChoices, api, paths, duration(), el(), gauge(), markdown(), statusPill() (+16 more)

### Community 40 - "M"
Cohesion: 0.06
Nodes (8): addEscHandler(), getPositionOfChildWindowRelativeToAncestorWindow(), getSameOriginWindowChain(), hook(), k(), M, registerEscHandler(), z()

### Community 41 - "r"
Cohesion: 0.06
Nodes (12): _cancelCallback(), emitOne(), end(), put(), r(), reject(), _requestCallback(), reset() (+4 more)

### Community 43 - "earcutLinked"
Cohesion: 0.08
Nodes (34): addContour(), compareXYSlope(), createNode(), cureLocalIntersections(), earcut(), earcutLinked(), eliminateHole(), eliminateHoles() (+26 more)

### Community 44 - ".multiplyMatrices"
Cohesion: 0.07
Nodes (4): CubeCamera, LightShadow, PlaneHelper, SkinnedMesh

### Community 45 - "Color"
Cohesion: 0.08
Nodes (6): Color, handleAlpha(), createColorManagement(), hue2rgb(), LinearToSRGB(), SRGBToLinear()

### Community 47 - "WebXRManager"
Cohesion: 0.09
Nodes (11): WebGLAnimation(), onAnimationFrame(), onAnimationFrame(), WebXRManager, onInputSourcesChange(), onSessionEnd(), onSessionEvent(), setProjectionFromUnion() (+3 more)

### Community 49 - "Store"
Cohesion: 0.10
Nodes (23): Store, terminalApi, clockTime(), append(), draw(), lineHtml(), logs, matches() (+15 more)

### Community 50 - ".get"
Cohesion: 0.13
Nodes (3): _convertViewportColToCharacterIndex(), _getWordAt(), _isCharWordSeparator()

### Community 51 - "icon"
Cohesion: 0.14
Nodes (31): icon(), relativeTime(), truncateText(), flow(), files, load(), sep(), CONTROLLABLE (+23 more)

### Community 54 - "BatchedMesh"
Cohesion: 0.10
Nodes (4): ascIdSort(), BatchedMesh, copyArrayContents(), flattenJSON()

### Community 56 - "toast"
Cohesion: 0.15
Nodes (30): toast(), checkNearby(), phoneListAction(), refreshCases(), refreshPhoneList(), refreshTrackList(), renderBreach(), renderInvestigate() (+22 more)

### Community 57 - ".dispose"
Cohesion: 0.07
Nodes (10): AxesHelper, Box3Helper, BoxHelper, addLine(), addPoint(), DirectionalLightHelper, GridHelper, PointLightHelper (+2 more)

### Community 58 - "Matrix3"
Cohesion: 0.07
Nodes (3): Matrix3, warnOnce(), WebGLExtensions()

### Community 59 - "PMREMGenerator"
Cohesion: 0.12
Nodes (14): _getCubemapMaterial(), _getEquirectMaterial(), PMREMGenerator, _setViewport(), WebGLCubeRenderTarget, WebGLEnvironments(), dispose(), get() (+6 more)

### Community 60 - "views/studio.js"
Cohesion: 0.11
Nodes (24): createApp(), render(), select(), unmount(), buildConnectApp(), buildSpaceApp(), buildStudioApp(), family (+16 more)

### Community 61 - "d"
Cohesion: 0.09
Nodes (4): d, g, o(), onDidAddFirstListener()

### Community 62 - "a"
Cohesion: 0.10
Nodes (3): a(), createInstance(), keys()

### Community 64 - "aetherOverlay.js"
Cohesion: 0.13
Nodes (18): ask(), build(), close(), conversation, finishListening(), greetAndListen(), openOverlay(), prefs (+10 more)

### Community 66 - "push"
Cohesion: 0.12
Nodes (21): addUniform(), parseUniform(), WebGLPrograms(), dispose(), getChannel(), getProgramCacheKey(), getProgramCacheKeyBooleans(), getProgramCacheKeyParameters() (+13 more)

### Community 68 - ".dispose"
Cohesion: 0.07
Nodes (5): DirectionalLight, HTMLTexture, PointLight, SpotLight, VideoTexture

### Community 70 - "WebGLState"
Cohesion: 0.17
Nodes (21): getUnlitUniformColorSpace(), WebGLBackground(), addToRenderList(), getBackground(), render(), setClear(), WebGLState(), ColorBuffer() (+13 more)

### Community 71 - "update"
Cohesion: 0.12
Nodes (23): createBuffer(), WebGLBufferRenderer(), render(), renderInstances(), renderMultiDraw(), render(), WebGLObjects(), onInstancedMeshDispose() (+15 more)

### Community 72 - "_askForLink"
Cohesion: 0.10
Nodes (22): _addStyle(), ae(), _applyMinimumContrast(), _askForLink(), bufferEvents(), _checkLinkProviderResult(), _clearCurrentLink(), _createLinkUnderlineEvent() (+14 more)

### Community 73 - "BufferGeometry"
Cohesion: 0.13
Nodes (4): BufferGeometry, CameraHelper, HemisphereLightHelper, setPoint()

### Community 74 - "l"
Cohesion: 0.11
Nodes (6): constructor(), emitOne(), l(), reject(), resolve(), setIfNotSet()

### Community 75 - "v"
Cohesion: 0.10
Nodes (7): cancel(), cancelAndSet(), doRun(), isScheduled(), schedule(), v(), work()

### Community 76 - "p"
Cohesion: 0.15
Nodes (6): contains(), _handleMouseDown(), p(), shouldForceSelection(), ue, warn()

### Community 77 - "LoadingManager"
Cohesion: 0.13
Nodes (8): handleError(), FileLoader, readData(), ImageLoader, onImageError(), onImageLoad(), removeEventListeners(), LoadingManager

### Community 78 - "PropertyMixer"
Cohesion: 0.11
Nodes (3): makeClipAdditive(), PropertyMixer, QuaternionLinearInterpolant

### Community 79 - "InterleavedBuffer"
Cohesion: 0.09
Nodes (3): generateUUID(), InterleavedBuffer, Source

### Community 80 - "PerspectiveCamera"
Cohesion: 0.12
Nodes (3): OrthographicCamera, PerspectiveCamera, SpotLightShadow

### Community 81 - "WebGLBindingStates"
Cohesion: 0.17
Nodes (21): WebGLBindingStates(), bindVertexArrayObject(), createBindingState(), createVertexArrayObject(), deleteVertexArrayObject(), disableUnusedAttributes(), dispose(), enableAttribute() (+13 more)

### Community 82 - "properties"
Cohesion: 0.10
Nodes (22): properties, terminalNode, const, const, const, maximum, minimum, type (+14 more)

### Community 83 - ".load"
Cohesion: 0.20
Nodes (5): AudioLoader, CompressedTextureLoader, loadTexture(), loadTexture(), TextureLoader

### Community 84 - ".dispatchEvent"
Cohesion: 0.11
Nodes (3): Light, Scene, WebXRController

### Community 86 - ".fromJSON"
Cohesion: 0.21
Nodes (5): ObjectLoader, getGeometry(), getMaterial(), getTexture(), parseConstant()

### Community 87 - "w"
Cohesion: 0.11
Nodes (3): f, keys(), w

### Community 89 - ".fromArray"
Cohesion: 0.11
Nodes (3): CatmullRomCurve3, InstancedMesh, Matrix2

### Community 92 - "properties"
Cohesion: 0.11
Nodes (19): const, const, const, const, const, const, const, properties (+11 more)

### Community 94 - "arraysEqual"
Cohesion: 0.21
Nodes (19): allocTexUnits(), arraysEqual(), copyArray(), setValueM2(), setValueM3(), setValueM4(), setValueT1Array(), setValueT2DArrayArray() (+11 more)

### Community 95 - "v"
Cohesion: 0.13
Nodes (4): a(), cancelAndSet(), doRun(), v

### Community 97 - "CubicBezier"
Cohesion: 0.12
Nodes (7): CubicBezier(), CubicBezierCurve, CubicBezierCurve3, CubicBezierP0(), CubicBezierP1(), CubicBezierP2(), CubicBezierP3()

### Community 98 - "aether.js"
Cohesion: 0.18
Nodes (14): aether, ask(), conversation, populateVoices(), prefs, renderTranscript(), setState(), speak() (+6 more)

### Community 99 - "QuadraticBezierCurve"
Cohesion: 0.12
Nodes (6): QuadraticBezier(), QuadraticBezierCurve, QuadraticBezierCurve3, QuadraticBezierP0(), QuadraticBezierP1(), QuadraticBezierP2()

### Community 100 - "h"
Cohesion: 0.18
Nodes (3): get(), h(), has()

### Community 103 - ".parse"
Cohesion: 0.19
Nodes (8): BufferGeometryLoader, getArrayBuffer(), getInterleavedBuffer(), getTypedArray(), LoaderUtils, deserializeImage(), loadImage(), deserializeImage()

### Community 105 - ".constructor"
Cohesion: 0.22
Nodes (12): PolyhedronGeometry, applyRadius(), azimuth(), correctSeam(), correctUV(), correctUVs(), generateUVs(), getVertexByIndex() (+4 more)

### Community 107 - "devices.js"
Cohesion: 0.24
Nodes (12): deviceOptions(), devices, live, renderAudio(), renderSensors(), renderVideo(), save(), startAudio() (+4 more)

### Community 108 - "properties"
Cohesion: 0.14
Nodes (14): const, properties, maximum, minimum, const, maximum, minimum, axis (+6 more)

### Community 109 - "properties"
Cohesion: 0.14
Nodes (14): properties, type, crownHalo, const, maximum, minimum, innerDiameter_mm, scale (+6 more)

### Community 110 - "WebGLMaterials"
Cohesion: 0.33
Nodes (14): WebGLMaterials(), refreshMaterialUniforms(), refreshTransformUniform(), refreshUniformsCommon(), refreshUniformsDash(), refreshUniformsDistance(), refreshUniformsLine(), refreshUniformsMatcap() (+6 more)

### Community 111 - "add"
Cohesion: 0.22
Nodes (5): add(), a(), dispose(), onWillAddFirstListener(), r

### Community 112 - "Interpolant"
Cohesion: 0.15
Nodes (3): CubicInterpolant, DiscreteInterpolant, Interpolant

### Community 113 - "RenderTarget"
Cohesion: 0.17
Nodes (4): RenderTarget, RenderTarget3D, WebGL3DRenderTarget, WebGLArrayRenderTarget

### Community 115 - "properties"
Cohesion: 0.17
Nodes (12): const, orbitalShell, maximum, minimum, type, properties, type, architecture (+4 more)

### Community 116 - "properties"
Cohesion: 0.17
Nodes (12): levitationField, properties, type, const, const, maximum, minimum, orientation (+4 more)

### Community 118 - "BoxGeometry"
Cohesion: 0.12
Nodes (4): BoxGeometry, ConeGeometry, CubeTexture, Uniform

### Community 119 - "Skeleton"
Cohesion: 0.20
Nodes (3): CubicPoly(), init(), Skeleton

### Community 120 - "getParameters"
Cohesion: 0.23
Nodes (4): isPackedRGFormat(), getMaxPrecision(), getParameters(), WebGLShaderCache

### Community 121 - ".push"
Cohesion: 0.20
Nodes (3): fireAsync(), p, wrapEvent()

### Community 123 - "properties"
Cohesion: 0.18
Nodes (11): const, properties, color, secondaryColor, shape, const, const, enum (+3 more)

### Community 124 - "position"
Cohesion: 0.18
Nodes (11): type, properties, const, x, y, z, facialInterface, interior (+3 more)

### Community 125 - "properties"
Cohesion: 0.18
Nodes (11): items, properties, type, const, curvature_degrees, distance_from_center_mm, length_mm, mustFloat (+3 more)

### Community 126 - ".toShapes"
Cohesion: 0.24
Nodes (3): Shape, getInteriorPoint(), pointInPolygon()

### Community 128 - "addShape"
Cohesion: 0.31
Nodes (9): addShape(), addUV(), addVertex(), buildLidFaces(), buildSideFaces(), f3(), f4(), sidewalls() (+1 more)

### Community 130 - ".splice"
Cohesion: 0.18
Nodes (5): _getJoinedRanges(), _mergeRanges(), registerHandler(), _removeIntersectingLinks(), _stringRangesToCellRanges()

### Community 131 - "definitions"
Cohesion: 0.20
Nodes (9): type, definitions, cognitiveCore, energySpine, interfaceHead, type, $id, type (+1 more)

### Community 132 - "properties"
Cohesion: 0.20
Nodes (10): const, particles, const, properties, type, defaultDensity, distribution, size_mm (+2 more)

### Community 133 - "Raycaster"
Cohesion: 0.24
Nodes (3): ascSort(), intersect(), Raycaster

### Community 137 - "delete"
Cohesion: 0.29
Nodes (10): delete(), _flushCleanupDeleted(), _flushCleanupInserted(), _flushDeleted(), _flushInserted(), forEachByKey(), getKeyIterator(), insert() (+2 more)

### Community 138 - "safety.js"
Cohesion: 0.36
Nodes (9): gateCard(), load(), OUTCOME, paint(), safety, stopCard(), trailCard(), VERIFY (+1 more)

### Community 139 - "diameter_mm"
Cohesion: 0.22
Nodes (9): properties, type, const, maximum, minimum, connector, diameter_mm, type (+1 more)

### Community 141 - "states.js"
Cohesion: 0.25
Nodes (6): EYE_SHAPES, LEGACY_MAP, PATTERN_WEIGHTS, STATE_COLOR, STATE_SPECS, TRANSITION_TAU

### Community 143 - "cloneUniforms"
Cohesion: 0.25
Nodes (5): cloneUniforms(), cloneUniformsGroups(), isThreeObject(), mergeUniforms(), ShaderMaterial

### Community 150 - "runtimeStatusPanel"
Cohesion: 0.43
Nodes (5): runtimeStatusPanel(), card(), load(), mount(), restart()

### Community 151 - "tools.js"
Cohesion: 0.48
Nodes (6): allTools, card(), load(), paint(), run(), tools

### Community 152 - "AETHER CHARACTER — CANONICAL IMPLEMENTATION RULES"
Cohesion: 0.33
Nodes (5): AETHER CHARACTER — CANONICAL IMPLEMENTATION RULES, LARANGAN KERAS, PRIMARY SILHOUETTE (mandatory), STATE (aether-state.json), WARNA (aether-materials.json)

## Knowledge Gaps
- **381 isolated node(s):** `CATEGORIES`, `APPS`, `holos`, `safetyState`, `conversation` (+376 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **69 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `$` connect `$` to `.splice`, `d`, `i`, `.constructor`, `t`, `s`, `delete`, `o`, `x`, `constructor`, `u`, `l`, `.dispose`, `h`, `M`, `r`, `n`, `WebXRManager`, `b`, `.get`, `a`, `c`, `_askForLink`, `v`, `p`, `F`?**
  _High betweenness centrality (0.212) - this node is a cross-community bridge._
- **Why does `WebGLRenderer` connect `WebGLRenderer` to `three.module.js`, `push`, `WebGLState`, `.constructor`, `warn`, `WebXRManager`, `get`?**
  _High betweenness centrality (0.123) - this node is a cross-community bridge._
- **Why does `_width()` connect `WebXRManager` to `$`?**
  _High betweenness centrality (0.122) - this node is a cross-community bridge._
- **What connects `CATEGORIES`, `APPS`, `holos` to the rest of the system?**
  _381 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `three.core.js` be split into smaller, more focused modules?**
  _Cohesion score 0.007691637883493455 - nodes in this community are weakly interconnected._
- **Should `$` be split into smaller, more focused modules?**
  _Cohesion score 0.014690982776089158 - nodes in this community are weakly interconnected._
- **Should `three.module.js` be split into smaller, more focused modules?**
  _Cohesion score 0.01274320172943452 - nodes in this community are weakly interconnected._