// Every transition, one per beat-pair, each labelled with its own call. One still re-framed per clip
// (move keeps a chosen point centred), so the transitions are easy to read.
// Build: reel build examples/transitions.rx.js --gif 480
const still = "media/forest_kit_poster.png"
const look = (x, y, call, transition) =>
  shot(still, { beats: 2, move: { zoom: 2.2, x, y }, in: transition, caption: { text: call, size: 30, pos: "top" } })
trailer("transitions", { w: 640, h: 360, fps: 30, bpm: 96, music: { src: "media/theme.ogg", fadeOut: 0.6 } },
  look(0.2, 0.5, '"cut"', "cut"),
  look(0.4, 0.4, "fade(0.5)", fade(0.5)),
  look(0.6, 0.5, "dip(0.6)", dip(0.6)),
  look(0.8, 0.6, "flash(0.25)", flash(0.25)),
  look(0.3, 0.7, "wipe(0.4)", wipe(0.4)),
  look(0.7, 0.3, 'slide(0.4, "up")', slide(0.4, "up")),
  look(0.5, 0.5, "zoom(0.5)", zoom(0.5)))
