# Video and editor integration verification (round 2)

Condensed from a research pass on **2026-11-22**: vendor docs, vendor-owned PDFs, specs, official sample repositories and open-source code that exercises a vendor API. **UNVERIFIED** = not stated in a retrievable primary source. Nothing was executed in an editor (no Mac, Premiere, Lightroom, Resolve, Capture One or Final Cut was available). Open-source licences were noted so GPL/AGPL code is not copied.

## 1. Lightroom Classic SDK (public information only)

The SDK and API reference sit behind an Adobe login. Names below are confirmed by sample code in Adobe's SDK 8 samples and by three independent open-source plugins (MIDI2LR GPL-3.0, Automaat `lightroom-mcp` MIT, `noopz/lightroom_mcp` Apache-2.0; **do not copy GPL code**).

- **`LrSocket` reverses our original design.** `LrSocket.bind{...}` makes **Lightroom the TCP listener** and the external process connects; each socket is **one direction only** (`mode = "send"` or `"receive"`), so two sockets are needed. Callbacks: `onConnecting(socket, port)`, `onConnected`, `onMessage(socket, message)`, `onClosed`, `onError`. Send mode may not notice a client disconnect on Windows, and `socket:reconnect()` has hung Lightroom in one plugin.
- **`LrHttp` is client-only** (`get(url, headers, timeoutSec)`, `post(url, body, headers[, method, timeout])`, `postMultipart`); no listener was found. Headers are an array of `{field =, value =}` tables. It must run inside a task, and Lightroom's Lua 5.1 cannot yield across a plain `pcall`, so wrap it with `LrTasks.pcall`. **A long-poll against an agent-side HTTP server is the pattern a published plugin uses** (`LrHttp.get(base .. "/jobs/next", headers, 5)`, results `LrHttp.post`, a token header), and it works for Premiere too.
- **Info.lua**: `LrSdkVersion`, `LrSdkMinimumVersion` (15.0 in current plugins), `LrToolkitIdentifier`, `LrPluginName`, `LrPluginInfoUrl`, `LrPluginInfoProvider`, `LrLibraryMenuItems = {{title, file, enabledWhen}}`, `LrInitPlugin`, `LrShutdownPlugin`, `LrForceInitPlugin` (effective only if the plugin also exposes a menu item), `VERSION = {major, minor, revision, build}`. A bare `LrTasks.startAsyncTask` started in `LrInitPlugin` is cancelled when the init script returns: use `LrFunctionContext.postAsyncTaskWithContext`.
- **Catalog and develop calls** confirmed in plugin code: `LrApplication.activeCatalog()`, `catalog:withWriteAccessDo(name, fn, {timeout = 30})`, `catalog:addPhoto(path)` inside write access, `catalog:findPhotoByPath(path, caseSensitive)`, `photo:applyDevelopSettings(tbl, historyName)` inside write access (the history name is the step shown in the History panel, which is how an apply is undone in Lightroom), `photo:getDevelopSettings()`, `photo:requestJpegThumbnail(w, h, callback)` (keep the returned request referenced until the callback fires), `LrDevelopController.setValue/getValue` (needs the Develop module), `LrShell.openFilesInApp`, `LrPathUtils`, `LrFileUtils`, `LrTasks.startAsyncTask/sleep/pcall`.
- **No `LrJson` was found** in six plugins; each bundles its own pure-Lua JSON (whether an official one exists is UNVERIFIED). Friedl's `JSON.lua` is CC-BY 3.0; write our own or bundle an MIT one.
- **UNVERIFIED**: official `LrSocket`/`LrHttp` parameter text and bind address, `LrJson`, `LrHttp` async requirement text.

## 2. Premiere Pro UXP

- UXP shipped as public beta in Premiere 25.2.0 and officially in **25.6.0** (use `host.minVersion "25.6.0"`); manifest v5 with `manifestVersion`, `id`, `name`, `version`, `host {app: "premierepro", minVersion}`, `entrypoints`, `requiredPermissions {network {domains}, localFileSystem}`. Anything not declared is denied.
- **Panels are network clients only**: `fetch`, `XMLHttpRequest` and a client-side `WebSocket`; no raw TCP, and a plugin cannot host a server. Loopback syntax is **UNVERIFIED**: docs show only `https://`/`wss://` domains; the one loopback sample uses `"domains": "all"` with `http://localhost`, and macOS restricts `http://`. Test `"all"` first, then a narrow entry.
- Mutations are Actions inside `project.lockedAccess(() => project.executeTransaction(cb, label))`. Calls: `Project.getActiveProject`, `project.importFiles(paths, suppressUI, targetBin)`, `project.createSequenceFromMedia(name, items)`, `SequenceEditor.getEditor(seq).createInsertProjectItemAction(...)` / `createOverwriteItemAction`, `ClipProjectItem.createSetInOutPointsAction`, `TransitionFactory.createVideoTransition(matchName)` (**match names undocumented**), `EncoderManager.exportSequence`. Whether inserting honours source In/Out marks, and the cross-dissolve match name, are UNVERIFIED.

## 3. DaVinci Resolve

- External scripting is **Studio only** ("External Scripting Using: (Resolve Studio only)", Reference Manual 21); the free edition has Console-only scripting, so the free path is File > Import of the FCPXML/EDL we write. Python (or Lua) with `RESOLVE_SCRIPT_API`/`RESOLVE_SCRIPT_LIB`, Resolve running (`-nogui` works); no Node binding. `ImportTimelineFromFile(path, {timelineName, importSourceClips, ...})` takes FCPXML/EDL/OTIO/AAF; `Timeline.Export` can write `EXPORT_FCPXML_1_10`; grading via `TimelineItem.SetCDL`, `Graph.SetLUT`, `ApplyGradeFromDRX`. Resolve reads **only cross dissolves** from an EDL and converts other transitions to a dissolve of the same duration.

## 4. Capture One

AppleScript is **macOS only** (official); no Windows automation. JXA also works; scripts live in `~/Library/Scripts/Capture One Scripts/`. Dictionary details (`apply style`, `apply adjustments`, `process` is Pro-only, adjustment-settings properties) come from a third-party generated dictionary, so treat them as secondary. `.costyle` files are portable between platforms; **no format specification exists** for `.costyle` or `.cos`.

## 5. FCPXML 1.10

- Cross dissolve between two spine clips: an `effect` resource (`id`, `name`, `uid` required) and `<transition name offset duration><filter-video ref .../></transition>` between the clips; the DTD says it overlaps the end of the previous clip and the start of the next. **The built-in Cross Dissolve `uid` is not in Apple's docs** (third-party code uses `FxPlug:4731E73A-8DAC-4113-9A30-AE85B1761265`); centring the transition on the cut (`offset = cut − duration/2`) is third-party practice and needs source handles of half the duration on both clips. Test in real Final Cut.
- Music: an `asset-clip` (or `audio`) connected inside the first spine clip with `lane="-1"` and `audioRole="music"` (roles are `main.sub`, e.g. `music.music-1`); volume via `adjust-volume` with `param name="amount"` and `fadeIn`/`fadeOut` (`type` linear/easeIn/easeOut/easeInOut, `duration` required). The fade XML is assembled from the DTD and UNVERIFIED in Final Cut. Anchored-item offset convention is UNVERIFIED; anchoring to a spine `gap` sidesteps it.
- `asset` has no `src` attribute in 1.10 (use `media-rep`, new in 1.9); `src` may be an absolute or relative URL.

## 6. CMX 3600 EDL

- A line has 9 fields: event number, reel (spec says 3 digits; tools tolerate names like `REEL_ONE`), channels, edit type (`C` cut, `D` dissolve, `W` wipe), a 3-digit duration in frames for `D`/`W`, then source in/out and record in/out. **A dissolve is one event over two lines**: the From line (`C`, source in = out = the outgoing clip's out point, record in = out) then the To line (`D nnn`, the incoming clip's range). `FROM CLIP NAME` / `TO CLIP NAME` are de-facto note lines, not in the spec. Channel tokens: `A` (audio 1), `AA` (audio 1 and 2), `V`, `B` (audio 1 and video), `AA/V`. `FCM: DROP FRAME` / `NON-DROP FRAME` precedes events; drop-frame import in Resolve is only enabled at 30 fps.

## 7. Start timecode

`ffprobe -v error -print_format json -show_streams -show_format` exposes `tags.timecode` on the video stream and on a `tmcd` data stream, and on the **format** when the tmcd track is unreferenced. A MOV timecode track stores a 32-bit frame counter (flag 0x0001 = drop frame). String to frames (FFmpeg `timecode.c`): `frames = (hh·3600 + mm·60 + ss)·N + ff` with N the nominal integer rate (30 for 29.97, 60 for 59.94); drop frame (a `;` or `.` before the frames field) subtracts `(N/30·2)·(totalMinutes − ⌊totalMinutes/10⌋)` and is only valid when `N % 30 == 0`. EDL source timecode = start timecode + source in; FCPXML `asset start` = the start timecode and `asset-clip start = asset.start + srcIn`. The SMPTE 12M text itself is UNVERIFIED (the rule is evidenced by FFmpeg's implementation).

## 8. Face, smile and blink detection from Node

- **YuNet** (`opencv_zoo`, MIT, `face_detection_yunet_2023mar.onnx`, 232,589 bytes, SHA-256 `8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4`) runs under `onnxruntime-node` (MIT, prebuilt CPU binaries for Windows, macOS and Linux). Input `[1,3,640,640]` float32, **BGR, 0 to 255**, no mean; outputs `cls_*`, `obj_*`, `bbox_*`, `kps_*` at strides 8, 16 and 32. Decode: `score = sqrt(clamp(cls)·clamp(obj))`; `cx = (c + bbox0)·s`, `w = exp(bbox2)·s`; landmarks right eye, left eye, nose, right mouth corner, left mouth corner; threshold 0.9, then **IoU NMS (0.3) implemented in TypeScript** (not part of the model). Not run here.
- **Closed-eye and smile detection are not possible from YuNet's landmarks**: the eye aspect ratio needs six points per eye and YuNet gives one centre point. A second model with eyelid points or blendshape scores is needed. MediaPipe has no Node runtime (web, Android, iOS, Python only). Do not claim blink or smile detection until such a model is chosen and verified.

## Still UNVERIFIED

The Lightroom SDK reference text, `LrJson`, loopback permission syntax and transition match names in Premiere, the Cross Dissolve `uid` and fade syntax in real Final Cut, Premiere's handling of EDL `FCM` changes and note lines, the SMPTE 12M text, any editor import.

## Sources (retrieved 2026-11-22)

Adobe Lightroom Classic landing page and the SDK 8 samples mirror (`Jaid/lightroom-sdk-8-examples`), `rsjaffe/MIDI2LR`, `Automaat/lightroom-mcp`, `noopz/lightroom_mcp`; developer.adobe.com/premiere-pro/uxp (manifest, network recipe, reference pages) and `AdobeDocs/uxp-premiere-pro-samples`; Blackmagic DaVinci Resolve 21 Reference Manual and the Resolve scripting README; support.captureone.com AppleScript and style articles; Apple's FCPXML 1.10 DTD page and Professional Video Applications documentation; the CMX 3600 specification scan (xmil.biz/EDL-X/CMX3600.pdf) and `OpenTimelineIO/otio-cmx3600-adapter`; FFmpeg `libavformat/mov.c`, `libavutil/timecode.c`, `fftools/ffprobe.c`; `opencv/opencv_zoo`, OpenCV `face_detect.cpp`, onnxruntime.ai Node docs; Soukupová and Čech, "Real-Time Eye Blink Detection using Facial Landmarks" (CVWW 2016).
