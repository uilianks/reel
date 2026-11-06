# reel reference

## Files

A trailer file (`.rx.js` or `.rx.ts`) runs in a sandbox whose globals are the DSL below.
`include("other.rx.js")` runs another file in the same project. Media paths resolve relative to the
file that names them. Sources are anything ffmpeg reads: MP4/WebM/MOV, animated GIF (loops), PNG/JPG
(stills), WAV/OGG/MP3 for music and sfx.

## trailer(name, opts, ...clips)

| Option | Default | |
|---|---|---|
| `w`, `h` | 1920, 1080 | Even pixel sizes. |
| `fps` | 30 | |
| `bpm` | — | Enables `beats`, the beat grid and alignment checks. |
| `beat0` | 0 | Trailer second of the first beat. |
| `music` | — | Path, or `{ src, from: 0, vol: 1, fadeOut: 1.5 }`. |
| `letterbox` | — | Bars for this aspect ratio (2.39, 2). Titles stay inside. |
| `fadeIn`, `fadeOut` | 0 | From / to black, seconds. |
| `grade` | — | A look over the whole trailer (see Grades). |

## shot(src, opts)

| Option | Default | |
|---|---|---|
| `dur` / `beats` | 3 s | Length. One or the other. |
| `from` | 0 | Source second where the shot starts. |
| `speed` | 1 | 0.5 = slow motion (source audio is time-stretched too). |
| `fit` | `"cover"` | `"contain"` letterboxes the source on `bg`. |
| `bg` | `"#000000"` | |
| `pixel` | false | Nearest-neighbour scaling for pixel art. |
| `move` | — | `{ zoom, x, y, ease }`; each value or `[start, end]`. `x`, `y` (0..1) is the source point kept at frame centre (clamped so a covering image never shows its edge). `ease`: `linear in out inOut` (default `inOut`). |
| `audio` | 0 | Volume of the source's own audio (`true` = 1). |
| `caption` | — | String or `{ text, size: 44, pos: "bottom", font, weight, color, tracking, shadow: true }`. |
| `sfx`, `in`, `overlay`, `grade` | | See below. |

A shot that needs source time past the end of a video holds its last frame (`info` warns).

## title(text, opts)

`dur | beats` (default 2 s), `sub` (half the size), `size` (64), `font` ("Noto Sans", via fontconfig), `weight` (900),
`color`, `tracking` (0.08 em), `pos` (`center top bottom`), `shadow`, `bg` ("#000000"),
`anim`: `push` (slow 6% zoom, default), `punch` (slams in from 125%), `none`. Text fades in and out
over 0.2 s (`punch` doesn't fade in).

## Overlays

`overlay: { src, x: 0.5, y: 0.5, w: 0.25, h, at: 0, dur, opacity: 1, pixel: false }` (one or a list) on any
shot or title draws an image, GIF or video over it: logos, sprites, picture-in-picture, HUD mockups, a
character cut-out. `x`, `y` are its center as fractions of the frame; `w` its width as a fraction of the
frame width (or `h` its height; the other side keeps the aspect); `at` and `dur` are seconds into the
clip. GIFs loop, videos play from their start, stills stay. Overlays sit under captions and title text.

## Grades

`grade: { brightness: 0, contrast: 1, saturation: 1, gamma: 1, tint, tintAmount: 0.25, vignette: 0 }` on a
shot, a title or the trailer is a look: brightness (-1..1) and contrast (0..4) around mid-gray, `gamma`
(0.1..5), `saturation` (0 = black and white), `tint` (a hex color mixed in by `tintAmount`) and a
`vignette` (0..1, darkens the corners). A clip's grade applies to the clip (overlays and caption
included); the trailer's grade applies to every frame before the letterbox. Teal-and-orange, bleached
flashbacks, night tints, VHS fades: all a few numbers.

## Transitions

Set on the incoming clip's `in`. They play over its first `d` seconds; the outgoing clip keeps
playing underneath (its source runs on past its own length).

| | Default d | |
|---|---|---|
| `"cut"` | — | |
| `fade(d)` | 0.5 | Crossfade. |
| `dip(d, color)` | 0.6, black | Out to a color and back. |
| `flash(d, color)` | 0.25, white | Hard cut under a decaying flash. |
| `wipe(d)` | 0.4 | Left to right. |
| `slide(d, dir)` | 0.4, "left" | The new clip pushes the old one out: it enters from `dir` (`left`, `right`, `up`, `down`). |
| `zoom(d)` | 0.5 | The old clip keeps growing while the new one fades over it. |

## sfx(src, { at: 0, vol: 1 })

Placed `at` seconds into its clip. A bare path in `sfx:` means `sfx(path)`.

## Commands

| | |
|---|---|
| `reel build f [--only a,b] [--proxy] [--gif [WIDTH]] [--no-preview] [--out DIR]` | MP4 + contact sheet; `--gif` adds an animated GIF (480 px wide at 15 fps, or WIDTH px) for READMEs, store pages and posts. |
| `reel info f [name]` | Clip table, beat alignment, music loudness/hits, tempo estimate, warnings. |
| `reel frame f name seconds` | One exact frame, full size. |
| `reel serve f [--port 4340]` | Live viewer, proxy renders, feedback. |
| `reel list f` | Trailers, lengths, locations. |

Outputs: `out/<name>.mp4` (rendered to `<name>.part.mp4`, renamed when complete; the same for the GIF), `out/<name>.gif` (`--gif`), `out/_proxy/<name>.mp4`, `out/_preview/<name>.png` (contact sheet),
`out/_feedback/<name>.json` + `<name>.n<k>.png`.
