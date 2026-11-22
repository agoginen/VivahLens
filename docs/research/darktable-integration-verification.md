# darktable integration verification (VivahLens)

Researched 2026-11-22, read-only. No darktable binary exists on this machine, so **nothing below was executed**; every behaviour claim comes from reading source or docs.

## 0. Method, pinned versions, evidence tags
- Source pinned to tag `release-5.6.2` of darktable-org/darktable (GitHub "Latest" release, commit `20891f6c6fa7be995e5bf9dff9d1ee5062051773`, published 04 Oct; stable series 5.6). Read from the tag's codeload zip (in memory) plus raw URLs; `lightroom.c` was read both ways and matched (1632 lines).
- Citation form `path:lines` = file at `release-5.6.2`. Raw URL: `https://raw.githubusercontent.com/darktable-org/darktable/release-5.6.2/<path>`.
- Manual = official 5.6 manual, `https://docs.darktable.org/usermanual/5.6/en/<page>` (pages listed in section 8).
- `master` (zip fetched 2026-11-22; newest nightly 20261117 = a670177) was read only to spot drift (section 5).
- The GitHub MCP tools in this environment point at a GHE host that returns 404 for darktable-org, so I used web/raw/codeload and grepped the tag locally instead of `search_code`.
- Tags: **[SRC]** read in source; **[DOC]** manual/release notes; **[ISSUE]** upstream issue text; **[INFER]** my deduction from code, not run; **[UNVERIFIED]** not read in a primary source and/or not tested.

## 1. Summary
1. The Lightroom/ACR importer is a small converter covering 10 develop areas (crop, orientation, exposure+blacks, clarity, vignette, grain, tone curve, HSL, split-toning, spot removal). White balance (Temperature/Tint), Contrast2012, Highlights2012, Shadows2012, Whites2012, Saturation, Vibrance, Texture, Dehaze, sharpening and noise reduction are **not read at all**. [SRC]
2. It runs (a) metadata-only when an image is imported and no darktable XMP exists, and (b) for develop settings only when an image is first loaded by a GUI develop with auto-presets not yet applied. It never runs inside `darktable-cli`. [SRC]
3. The only Lightroom-style name it looks for is `IMG_001.xmp` (then `.XMP`); darktable's own sidecar is `IMG_001.CR3.xmp`. [SRC][DOC]
4. `darktable-cli`'s optional 2nd positional argument is read with darktable's native XMP reader. A Lightroom `crs:` file is accepted without error but yields an empty history. [INFER from SRC; matches ISSUE #20953]
5. The native sidecar stores history as attribute-style `rdf:li` entries with **binary struct params** (lowercase hex or `gz`+base64) tied to a per-module `modversion`. Per the code a minimal hand-written file is readable, with several traps (section 4). [SRC; never run here]
6. Recommendation (section 6): generate **native** XMP for a few modules with pinned `modversion`s, run `darktable-cli` per image with an explicit sidecar, a private `--configdir`, and a runtime self-test. Do the Lightroom-to-darktable mapping inside VivahLens, not via darktable.

## 2. Q1 - Lightroom/Adobe XMP import

### 2a. Keys read and what they map to (`src/develop/lightroom.c`, handler `_lrop` 486-1039)
Nodes are selected by XPath for the namespace prefixes `crs, dc, tiff, xmp, exif, lr`, in both element form (`//crs:*`, "Lr 7.0 CC") and attribute form (`//@crs:*`, "Lr up to 6.0") (1292-1306); `_lrop` then compares the **local name only** (so `tiff:ImageWidth`, `xmp:Label`, `crs:Exposure2012` all work the same way). Targets are written straight into `main.history` via `dt_add_hist` (329-382) using **frozen copies of old param structs** (39-235).

| LR/XMP key(s) | darktable target and conversion | lines |
|---|---|---|
| `CropLeft/Top/Right/Bottom`, `CropAngle`, `HasCrop`="True", `ImageWidth`, `ImageLength`, `Orientation` | legacy **`clipping`** ("crop and rotate", deprecated; v5), not the new `crop`. angle = -CropAngle; rect converted to image-centred px with ImageWidth/Length, rotated, normalised by the rotated canvas, `round5`; orientation flips/swaps applied; ratio_n=ratio_d=-2. Also adds `flip` v2 if orientation differs | 494-519, 1324-1397, 50-64 |
| `Exposure2012` | `exposure` (written as frozen **v2** struct `{black, exposure, gain}`): exposure = value in EV, no scaling, only if != 0 | 529-537, 66-70, 1399-1404 |
| `Blacks2012` | `exposure.black`, piecewise-linear table -100:0.020, -50:0.005, 0:0, 50:-0.005, 100:-0.010 | 279-285, 520-528 |
| `Clarity2012` | `bilat` (local contrast) `detail` = table -100:-0.65, 0:0, 100:+0.65; sigma_r=sigma_s=100 | 322-327, 796-804, 1560-1568 |
| `PostCropVignette{Amount,Midpoint,Style,Feather,Roundness}` | `vignette` v3: brightness=table(-100:-1, -50:-0.7, 0:0, 50:0.5, 100:1); scale=table(0:74, 4:75, 25:85, 50:100, 100:100); saturation -0.3 if Style==1 else -0.2; falloff_scale=Feather; Roundness re-derives whratio/scale | 287-299, 538-569, 1415-1449 |
| `GrainAmount`, `GrainFrequency` | `grain`: strength=table(0:0, 25:20, 50:40, 100:80); scale=table(0:100, 50:100, 75:400, 100:800)/53.3 | 301-313, 570-583, 1406-1413 |
| `ToneCurveName2012` (Linear/Medium Contrast/Strong Contrast/Custom), `ToneCurvePV2012` ("x, y" pairs, /255), `Parametric{Shadows,Darks,Lights,Highlights}` (percent added to node y), `Parametric{Shadow,Midtone,Highlight}Split` (/100) | `tonecurve` v3, L channel cubic spline (6 nodes unless Custom), a/b linear | 584-622, 965-982, 1470-1536 |
| `{Hue,Saturation,Luminance}Adjustment` x {Red,Orange,Yellow,Green,Aqua,Blue,Purple,Magenta} | `colorzones` v2, 8 bands: sat = 0.5+v/200; lum = 0.5+(4/9)*v/200; hue = 0.5+(3/9)*v/200 | 489-490, 623-766, 1538-1549 |
| `SplitToning{Shadow,Highlight}Hue` (/255), `...Saturation` (/100), `SplitToningBalance` (table -100:100, 0:0, 100:0) | `splittoning` (compress=50) | 315-320, 767-795, 1551-1558 |
| `RetouchInfo` (list: centerX/Y, radius, sourceX/Y; max 32) | `spots` (deprecated) | 927-964, 1451-1468 |
| `Rating`, `Label`, `GPSLatitude/Longitude(+Ref)`, `subject`, `hierarchicalSubject`, `title`, `description`, `creator`, `rights` | metadata only (rating, colour label red/yellow/green/blue else purple, geotag, tags, dc fields) - applied only when `dev==NULL` (import path) | 805-903, 905-1038, 1570-1609 |
| (side effect) `stEvt:softwareAgent` contains "Lightroom"/"Camera Raw" and image is raw | inserts `colorin` set to matrix "cmatrix" | 1314-1322 |

The manual's list agrees (crop and rotate, black level, exposure, vignette, clarity, tone curve, HSL, split-toning, grain, spot removal; "never identical results to other software") [DOC] `overview/sidecar-files/sidecar-import/`.

### 2b. When it happens, which file, which preferences
Short answer [SRC]: not "always" and not preference-gated. Metadata is imported once at library import if no darktable XMP exists; develop settings are imported once, the first time a GUI develop loads an image whose auto-presets were never applied.
- **File name** [SRC] `dt_get_lightroom_xmp` 242-266: image path with the extension replaced by `xmp`, then `XMP`: `IMG_001.CR3` -> `IMG_001.xmp` / `IMG_001.XMP`. It never tries `IMG_001.CR3.xmp` (that is darktable's own format, read by `dt_exif_xmp_read`; duplicates are `IMG_001_NN.CR3.xmp`: `src/common/image.c:1648-1700`). [DOC]: Lightroom-named files "will be read ... but will not be written to".
- **Gate inside the importer** [SRC] 1133-1217: file must exist; root element `xmpmeta`; if any `stEvt:softwareAgent` exists it must contain "Lightroom" or "Camera Raw", otherwise abort; if none exists it still imports (but `colorin` is not added).
- **Trigger 1 - library import (metadata only)** [SRC] `src/common/image.c:2043-2065`: after import darktable reads `<file>.xmp`; `if(res && nb_xmp == 0)` (res=TRUE means unreadable/missing, `exif.cc:4079-4083, 4699` vs `4701`) it calls `dt_lightroom_import(id, NULL, TRUE)`. With `dev==NULL` only rating, colour label, GPS, tags, title/description/creator/rights are applied (`lightroom.c:1570-1609`); all history inserts are guarded by `dev != NULL` (1314-1568). Then `dt_image_synch_xmp` writes darktable's XMP if the preference allows.
- **Trigger 2 - develop settings, once per image** [SRC] `src/develop/develop.c:2357-2359`: `if(dev->full.pipe && dev->full.pipe->loading && first_run) dt_lightroom_import(imgid, dev, TRUE)` (comment: "first time we are loading the image, try to import lightroom .xmp if any"). `first_run` is true only when `!(flags & DT_IMAGE_AUTO_PRESETS_APPLIED)` (`develop.c:1864-1866`). `full.pipe` exists only for GUI devs (`develop.c:96-103`); `dt_dev_image` (used by overlay/duplicate/snapshot panels) also qualifies [INFER]. Export builds its dev with `dt_dev_init(&dev, FALSE)` (`src/imageio/imageio.c:1067-1069`), so **no Lightroom develop conversion in export / darktable-cli**. [DOC] "This migration happens automatically when entering the darkroom view".
- **Preferences** [SRC]: no Lightroom-specific key exists (grep of `src/` and `data/darktableconfig.xml.in` for "lightroom" finds only the call sites above and keyword-file import). Indirect effects: `write_sidecar_files` (never / after edit / on import; default "on import", `darktableconfig.xml.in:346-359`, read at `image.c:352-380`): once `IMG_001.CR3.xmp` exists the import takes the darktable path and trigger 1 is skipped (`image.c:2058`); `darktable-cli` forces `never` (`src/cli/main.c:455-463`). `run_crawler_on_start` ("look for updated XMP files on startup", default false, `xml:3812-3817`) only watches darktable XMP mtimes. [DOC] `overview/sidecar-files/sidecar/`: after import the database wins over the XMP; later edits by other software are invisible unless that crawler option is on.
- **Upstream evidence** [ISSUE] `github.com/darktable-org/darktable/issues/20953` (open, May 2026, tested on 5.4.1): `darktable-cli file.ARW file.xmp out.jpg` with a Lightroom sidecar is "pixel-identical to exporting without the Lightroom sidecar"; the reporter's workaround is opening the RAW in the GUI once, then `darktable-cli file.ARW file.ARW.xmp out.jpg`. No maintainer reply (marked stale 2026-07-07). `issues/15971` (2023, closed not planned): collaborator says `darktable-cli` is for "applying a given xmp file or presets".

### 2c. Keys ignored [SRC]
`_lrop` has no fallback branch, so any other name is silently skipped (492-904). The handled set is 70 names (494-1025). Names that appear **nowhere** in `lightroom.c` (grep): `Temperature`, `Tint`, `WhiteBalance`, `Contrast2012`, `Highlights2012`, `Shadows2012`, `Whites2012`, `Saturation`, `Vibrance`, `Texture`, `Dehaze`, `Sharpness`, `LuminanceSmoothing`, `ColorNoise*`. By the same reading, also ignored: pre-2012 process keys (`Exposure`, `Shadows`, `Brightness`, `Contrast`), `VignetteAmount` (non post-crop), lens/CA/profile settings, graduated/radial/brush corrections, calibration keys. [INFER for the "also ignored" list]

## 3. Q2 - darktable-cli

### 3a. Syntax [DOC] `special-topics/program-invocation/darktable-cli/` + [SRC] `src/cli/main.c:62-110, 247-453`
```
darktable-cli [<input file or folder>] [<xmp file>] <output file or folder>
  [--width <max width>] [--height <max height>] [--hq <0|1|true|false>] [--upscale <0|1|true|false>]
  [--style <style name>] [--style-overwrite] [--apply-custom-presets <0|1|false|true>]
  [--out-ext <extension>] [--import <file or dir>]... [--library <path>]
  [--icc-type <type>] [--icc-file <file>] [--icc-intent <intent>] [--verbose] [--help [option]]
  [--core <darktable options>]
```
Source also accepts `--export_masks`, `--bpp` (prints "unsupported") and `-v/--version`. 5.6.0 release notes [DOC]: "Add --library <path> option to darktable-cli" (history from a library DB instead of XMP).
- Positional logic [SRC] `main.c:441-452, 500-531`: non-dash args are input, xmp, output in that order; exactly 2 args = input+output (no xmp); >3 is an error; with `--import`, 1 arg = output and 2 args = xmp+output.
- Output may be a file or an existing folder; folder -> pattern `<dir>/$(FILE_NAME)` and ext defaults to `jpg` (`main.c:538-553`). Format is chosen from the output extension (jpg->jpeg, tif->tiff, jxl->jpegxl; `main.c:733-749`) unless `--out-ext` is given, which wins; a redundant matching ext is stripped (`724-731`). [DOC] `image.jpeg` produces `image.jpg`; `output.jpg` with `--out-ext jpeg` produces `output.jpg.jpg`.
- `--width/--height` are **maximum** bounds, 0 = full size (`main.c:85-86, 818-821`); `--hq` default true (high-quality resampling); `--upscale` default false. [DOC]

### 3b. Second positional argument (XMP) [SRC]
- `main.c:666-686`: for every imported image, `dt_exif_xmp_read(image, xmp_filename, FALSE)`; on error prints "error: can't open XMP file" and `exit(1)`. The same XMP is applied to all inputs, so use one process per image for per-image edits.
- This is darktable's native reader: needs `darktable:xmp_version` 2-5 and `darktable:history` entries (section 4). A Lightroom file has neither, so `_read_history_v1` finds nothing (`exif.cc:3469-3579`), the image's history is deleted (`4271-4274`) and the auto-presets flag is cleared (`4620-4628`); the function returns FALSE (success). Export then uses darktable defaults. [INFER; consistent with ISSUE #20953]
- Without the argument darktable reads `<input>.xmp` = `IMG_001.CR3.xmp` at import (`main.c:533-536` comment; `image.c:2045-2050`).
- Upstream tools use exactly this form: `tools/noise/subr.sh:456` `darktable-cli "$input" "$xmp_profiling" "$output" --apply-custom-presets false --core --conf plugins/lighttable/export/iccprofile=image ...`; `src/tests/benchmark/darktable-bench:242` `--hq 1 <image> <xmp> <out> --core --library :memory: --configdir <dir> -d perf`. [SRC]

### 3c. Style, presets, config
- `--style NAME` / `--style-overwrite`: style is looked up in `data.db` by name; unknown name -> "cannot find the style ... imported this style ... without the .dtstyle extension" and the export fails (`imageio.c:1121-1141`, `goto error` -> store() != 0 -> exit 1 [INFER]). Default = append to history; `--style-overwrite` replaces it (`main.c:822-831`; `imageio.c:1145`). [DOC] says `--core --configdir` must also be given; the source does not enforce this.
- User `.dtstyle` files are imported only by GUI/Lua (`libs/styles.c`, `lua/styles.c:280`); at every `dt_init` only `<sharedir>/darktable/styles` is auto-imported (`src/common/darktable.c:1816-1823`). No CLI import exists. [SRC]
- `--apply-custom-presets false` -> `data.db` becomes `:memory:` (`src/common/database.c:4311-4315`): no user presets/styles, but several instances can run in parallel. [DOC][SRC]
- CLI always injects `--library :memory:` (or your `--library`) and `--conf write_sidecar_files=never` before your `--core` args (`main.c:455-463`): no sidecar is written or deleted by the CLI.
- `--core ...` args go straight to darktable: `--configdir DIR` (`darktable.c:1156`; the config-directory manual page misspells it `--config-dir`), `--conf key=value` (not persisted; any key accepted; empty value ignored: `darktable.c:1337-1353`, `conf.c:557-566`), `--library`, `-d params`, `--disable-opencl` etc. [DOC] `program-invocation/darktable/`.
- Without `--configdir` the CLI reads the user's `darktablerc`/`data.db` (Windows default `%LOCALAPPDATA%\darktable` [DOC] `preferences-settings/config-directory/`). [DOC]: "will use the last format configuration used in the export module".

### 3d. Default output behaviour and quality
- Disk storage appends the format extension (`src/imageio/storage/disk.c:437-440`), creates missing parent folders (`411-424`) and, if the target exists, acts on conf `plugins/imageio/storage/disk/overwrite`: 0 unique name `name_01.jpg`, 1 overwrite, 2 overwrite if changed, 3 skip (`disk.c:52-58, 446-481, 570`). The key has no default in `data/darktableconfig.xml.in` (grep), and unknown int keys read as 0 (`conf.c:149-181`), so a fresh config renames (`main.c:555-561` prints "output file already exists, it will get renamed") [INFER]; a darktablerc set via the GUI may differ. Force overwrite with `--core --conf plugins/imageio/storage/disk/overwrite=1`.
- Several inputs with one non-folder output name and no `$` get `_$(SEQUENCE)` appended (`disk.c:366-370`).
- JPEG quality: `--core --conf plugins/imageio/format/jpeg/quality=<5-100>`, default 95 (`darktableconfig.xml.in:2861-2866`, read at `src/imageio/format/jpeg.c:467`). TIFF [DOC]: `plugins/imageio/format/tiff/bpp` (8/16/32), `compress` (0/1/2), `compresslevel` (0-9), `shortfile`. Format key pattern: `plugins/imageio/format/<FORMAT>/<OPTION>`.
- **Exit codes** [SRC]: `0` success and `--version`; `1` for everything else: `--help` (`main.c:251-261` calls `exit(1)`), bad option value, `dt_init` failure (567-576), "no images to export" (656-664), unreadable XMP (681), unknown extension (791), and any failed `store()` (`res=1`, `exit(res)` at 879). A batch keeps going after one failure but exits 1. There are no finer-grained codes.

## 4. Q3 - darktable's own sidecar format

### 4a. Structure [SRC] `src/common/exif.cc` (writer 4704-4866, 5128-5277; reader 3581-3735, 4072-4702)
Top-level `rdf:Description` attributes: `darktable:xmp_version` (**5** in 5.6.2 and master: `exif.cc:81`), `raw_params`, `auto_presets_applied` (0/1), `history_end`, `iop_order_version`, optional `iop_order_list` (only for custom order or multi-instance: `5171-5175`), optional `history_*_hash` (recomputed if absent: `4670-4682`), timestamps. Then `<darktable:masks_history><rdf:Seq/>` and `<darktable:history><rdf:Seq>` holding one `rdf:li` per entry with attributes written in this order (`4815-4850`): `num`, `operation`, `enabled`, `modversion`, `params`, `multi_name`, `multi_name_hand_edited`, `multi_priority`, `blendop_version`, `blendop_params`; then `history_end` = number of active entries (`4860-4865`).
- `params` encoding (`3128-3224`): conf `compress_xmp_tags` (default "only large entries", `xml:360-371`): lowercase hex, or if compressed (always, or entry > 100 bytes) `gz` + 2-digit compression factor + base64(zlib). Decode (`3227-3310`): "gz" prefix -> base64+uncompress, else hex that must match `[0-9a-f]` only (**uppercase hex -> NULL**).
- `multi_name` = instance label; `multi_priority` = instance index (0 = base instance); `multi_name_hand_edited` = flag.
- Real examples in the tag: `src/tests/benchmark/darktable-bench-null.xmp` (xmp_version 4, `history_end="8"`, header + first entry at lines 4-37), `darktable-bench-4.2.xmp:310-317` (exposure v6 `params="000000000000000008d7633f00004842000080c000000000"` = mode 0, black 0, exposure 0.89, 50, -4, 0 [decoded by me]); `tools/noise/profiling-shot.xmp`.

### 4b. Can a minimal hand-written XMP work? Yes per code; rules [SRC], untested here
- Upstream precedent: `tools/dtstyle_to_xmp.py:30-102` builds an XMP from a `.dtstyle` with only history entries (comment at line 44: history_end "not needed ... defaults to the topmost element"). It writes `xmp_version=2`, which selects the **legacy iop order** (`exif.cc:4190-4194`) - do not copy that value.
- Reader requirements (`exif.cc:3581-3735`, `4245-4267`): `xmp_version` in 2..5 (absent -> old v1 reader, finds nothing; >5 -> "schema version not supported", returns error). Each `rdf:li` **must** have `operation`, `modversion`, `params`; if any entry lacks one, the **whole history is discarded** (3719-3732). `enabled` defaults to FALSE when omitted (calloc), `num` defaults to 0 for every entry and for xmp_version >= 3 is used as the DB order (`4369-4382`), so write 0..N-1; `blendop_params` may be omitted (default blending is used: `develop.c:2603-2620`), `multi_priority` defaults 0.
- `history_end` omitted -> all entries active (`exif.cc:4574-4597`); present -> `min(history_end, count)`.
- `iop_order_version`: for xmp_version 4/5 it defaults to **LEGACY(1)** if the key is missing (`exif.cc:4098, 4155-4169`) and the order is stored in the DB (`4598`); auto-apply only sets an order when none exists (`develop.c:2048-2052`). So write `darktable:iop_order_version="4"` (V50, the RAW default: `src/common/iop_order.h:128-139`). [INFER]
- `auto_presets_applied`: "0"/absent -> auto-presets (default workflow) are **prepended** and your entries override same-instance modules (`develop.c:1858, 2234-2271`); "1" -> no workflow presets are added, only mandatory modules (`develop.c:2142-2171`), so the look is flatter. Default workflow in 5.6.2 is "scene-referred (sigmoid)" (`xml:3898-3910`); for non-mono RAW the base `exposure` defaults to **+0.7 EV**, black -0.000244, `compensate_exposure_bias` TRUE (`src/iop/exposure.c:350-361`), so your `exposure` entry replaces rather than adds to that.

### 4c. Params are binary structs tied to `modversion` [SRC]
- Example: `exposure` is `DT_MODULE_INTROSPECTION(7, dt_iop_exposure_params_t)` (`src/iop/exposure.c:47`), struct `{ dt_iop_exposure_mode_t mode; float black; float exposure; float deflicker_percentile; float deflicker_target_level; gboolean compensate_exposure_bias; gboolean compensate_hilite_pres; }` = 28 bytes little-endian (66-75). `legacy_params` upgrades v2..v6 -> v7 (157-308; v2 was `{black, exposure, gain}`).
- Load rule (`develop.c:2565-2568, 2622-2682`): history `modversion == module version` and size equal -> raw `memcpy`; `modversion` **newer** than the running darktable -> "unknown version, using default parameters" (toast only); older -> `legacy_params` chain, and if no conversion exists the entry is dropped with "[dev_read_history] module ... version mismatch" (printed at default log level, 2655-2659). `-d params` prints per-module `version ok/WRONG params ok/WRONG` (2570-2578).
- Other basic-adjustment modules at 5.6.2: `crop` v3 `{float cx,cy,cw,ch; int ratio_n, ratio_d}` = 24 bytes, cw/ch are right/bottom edges in 0..1, ratio 0/0 = freehand, 0/+-1 = original ratio (`crop.c:44, 61-69, 617-656`); `temperature` v4 `{float red,green,blue,various; int preset}` = 20 bytes, i.e. **RGB multipliers, not Kelvin/tint** (`temperature.c:46, 68-75`); `colorbalancergb` v5 with `saturation_global`, `vibrance`, `contrast`, ~33 four-byte fields (`colorbalancergb.c:52, 60-106`; size 132 bytes is my count [INFER]). Deprecated: `basicadj`, `colisa` (flag `IOP_FLAGS_DEPRECATED`: `basicadj.c:181`, `colisa.c:96`).
- Constructed (not run) blobs: exposure v7 +1.0 EV with scene-referred defaults `00000000000080b90000803f00004842000080c00100000001000000`; crop v3 5% border `cdcc4c3dcdcc4c3d3333733f3333733f0000000000000000`.

## 5. Drift: 5.6.2 vs master (2026-11-22) [SRC master zip]
- `DT_XMP_EXIF_VERSION` 5, exposure v7, crop v3, colorbalancergb v5, iop order V50 unchanged. **`temperature` is v5 in master** (adds `gboolean late_correction`, 24 bytes) vs v4 in 5.6.2: a concrete version bump between series, so pinned `modversion` + size tables are mandatory.
- Master `lightroom.c` is longer (2148 vs 1632 lines): adds `RetouchAreas` (`lightroom.c:1276-1288, 1407`) and has no `ToneCurveName2012` literal; still no Temperature/Tint/Contrast/Highlights/Shadows/Whites/Saturation/Vibrance/Texture/Dehaze handlers (grep). `cli/main.c` keeps `write_sidecar_files=never`, `:memory:` default, native-XMP read and `exit(res)` (master `main.c:500-502, 729, 943`).

## 6. Q4 - Recommendation for a third-party tool

**Least fragile**: native darktable XMP + `darktable-cli`, with all version knowledge pinned in VivahLens and verified at run time. Reasons: it is the path upstream's own benchmark/noise tools use [SRC]; params are forward-upgraded by `legacy_params` so an old `modversion` keeps loading on newer darktable; Lightroom XMP conversion is GUI-only and covers none of white balance/contrast/saturation [SRC][ISSUE]; GUI/Xvfb automation is called fragile by the #20953 reporter [ISSUE].

Per adjustment (module choice is a design suggestion [INFER]):
- exposure -> `exposure` v7 (absolute EV; scene-referred default is already +0.7).
- white balance -> omit `temperature` to keep camera as-shot; otherwise write RGB multipliers `{red, green, blue, various, preset}` yourself (K/tint -> multipliers needs the camera matrix; not in darktable's XMP). [UNVERIFIED mapping]
- contrast, saturation -> `colorbalancergb` v5 (`contrast`, `saturation_global`, `vibrance`); needs a full 132-byte default-filled struct, so patch a template rather than pack from scratch. Avoid deprecated `colisa`/`basicadj`.
- crop -> `crop` v3 (not legacy `clipping`).

Exact files and command (Windows; exe folder per [DOC] `invocation-per-os`):
- RAW `D:\shoot\IMG_001.CR3`; sidecar generated by VivahLens `D:\work\IMG_001.CR3.xmp` (RAW file name + `.xmp`; if placed beside the RAW it is auto-read and the 2nd argument can be dropped); output `D:\out\IMG_001.jpg`.
```
& "C:\Program Files\darktable\bin\darktable-cli.exe" "D:\shoot\IMG_001.CR3" "D:\work\IMG_001.CR3.xmp" "D:\out\IMG_001.jpg" `
  --out-ext jpg --hq true --apply-custom-presets false `
  --core --configdir "D:\work\dtconf" `
  --conf plugins/imageio/format/jpeg/quality=92 `
  --conf plugins/imageio/storage/disk/overwrite=1
if ($LASTEXITCODE -ne 0) { throw "darktable-cli failed ($LASTEXITCODE)" }
```
Pass an explicit output **file** (a trailing backslash on a folder is untested on Windows; `main.c:549-551` only trims "/"). [UNVERIFIED on Windows]

Constructed minimal sidecar (from code reading, **not run**):
```xml
<?xml version="1.0" encoding="UTF-8"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="XMP Core 4.4.0-Exiv2">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/" xmlns:darktable="http://darktable.sf.net/"
    xmp:Rating="0" xmpMM:DerivedFrom="IMG_001.CR3" darktable:xmp_version="5" darktable:raw_params="0"
    darktable:auto_presets_applied="0" darktable:history_end="2" darktable:iop_order_version="4">
   <darktable:masks_history><rdf:Seq/></darktable:masks_history>
   <darktable:history><rdf:Seq>
    <rdf:li darktable:num="0" darktable:operation="exposure" darktable:enabled="1" darktable:modversion="7"
      darktable:params="00000000000080b90000803f00004842000080c00100000001000000"
      darktable:multi_name="" darktable:multi_priority="0"/>
    <rdf:li darktable:num="1" darktable:operation="crop" darktable:enabled="1" darktable:modversion="3"
      darktable:params="cdcc4c3dcdcc4c3d3333733f3333733f0000000000000000"
      darktable:multi_name="" darktable:multi_priority="0"/>
   </rdf:Seq></darktable:history>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
```
Safeguards to build in:
1. Table of supported `(operation, modversion, byte size, field offsets)` for darktable 5.6.x; refuse or warn on any other `darktable-cli --version` (exit 0, `main.c:262-268`). Prefer patching floats inside a template XMP saved from the same darktable build; keep lowercase hex.
2. Self-test at install: render a known RAW with +1 EV and a crop, check brightness/size; also run once with `--core -d params` and fail on `WRONG` / "version mismatch" lines in stderr (the "unknown version" case is toast-only, so its CLI visibility is [UNVERIFIED]).
3. One `darktable-cli` process per image (per-image XMP), `--apply-custom-presets false` for parallel runs, private `--configdir` so GUI `darktablerc` state (quality, overwrite, workflow) cannot leak in.
4. For Lightroom parity, port the `lightroom.c` tables (section 2a) into VivahLens and emit native entries; or track upstream request #20953. Manual warns results never match Lightroom exactly. [DOC] Licensing caution: darktable source is GPL-3.0-or-later (header at `src/develop/lightroom.c:1-17` and `src/cli/main.c:5-16`), so porting its code/tables into VivahLens needs a licence review, whereas calling `darktable-cli` as a separate process is a different question. [UNVERIFIED legal point; not a legal opinion]

## 7. Not verified / gaps
- Nothing executed (no darktable here): the hand-written XMP, command line, overwrite default, Windows paths and "LR file as 2nd arg = empty history" are code-derived [INFER]; only the last has independent user confirmation (ISSUE #20953, on 5.4.1).
- Exiv2 acceptance of an XMP without `<?xpacket>` wrapper: upstream samples have none, but not run. `dt_control_log` messages in CLI: unknown. Whether `--datadir` redirects default-style import: not read.
- White-balance K/tint -> multiplier conversion, colorbalancergb default values, and Lua/DBus control paths were not researched. Behaviour for darktable other than 5.6.2 / master is only as noted in sections 2b and 5.

## 8. Sources read
- Source (tag `release-5.6.2`): `src/develop/lightroom.c`, `src/develop/develop.c`, `src/common/image.c`, `src/common/exif.cc`, `src/common/iop_order.{c,h}`, `src/common/database.c`, `src/common/darktable.c`, `src/control/conf.c`, `src/cli/main.c`, `src/imageio/imageio.c`, `src/imageio/storage/disk.c`, `src/imageio/format/jpeg.c`, `src/iop/{exposure,crop,temperature,colorbalancergb,basicadj,colisa}.c`, `data/darktableconfig.xml.in`, `tools/dtstyle_to_xmp.py`, `tools/noise/{subr.sh,darktable-gen-noiseprofile,profiling-shot.xmp}`, `src/tests/benchmark/{darktable-bench,README.txt,*.xmp}`.
- Manual 5.6 (`https://docs.darktable.org/usermanual/5.6/en/`): `special-topics/program-invocation/{darktable-cli,darktable,invocation-per-os}/`, `overview/sidecar-files/{sidecar,sidecar-import}/`, `preferences-settings/{storage,import,config-directory}/`, `module-reference/utility-modules/lighttable/history-stack/`.
- GitHub: releases page (5.6.2 Latest, nightly 20261117; 5.6.0 notes), issues `#20953`, `#15971` (`https://github.com/darktable-org/darktable/issues/<n>`).
