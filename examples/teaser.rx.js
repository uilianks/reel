// A 10 s teaser cut on the beat of a chirp theme (96 bpm): pixel-art scenes from pxl, a vex poster,
// title cards, camera moves and transitions. Build: reel build examples/teaser.rx.js --gif 480
trailer("teaser", { w: 640, h: 360, fps: 30, bpm: 96, music: { src: "media/theme.ogg", fadeOut: 1 }, letterbox: 2, fadeIn: 0.5 },
  shot("media/no_magic_night.gif", { beats: 4, pixel: true, move: { zoom: [1, 1.25], y: [0.55, 0.7] } }),
  title("SOMETHING IS BREWING", { beats: 2, size: 34, tracking: 0.16, in: dip(0.3) }),
  shot("media/cave.gif", { beats: 2, pixel: true, move: { zoom: [1.1, 1.3], x: [0.3, 0.6] }, in: flash(0.2) }),
  shot("media/forest_kit_poster.png", { beats: 2, move: { zoom: [1.3, 1.1], x: 0.4 }, in: slide(0.3, "right") }),
  shot("media/forest_kit_anims.gif", { beats: 2, fit: "contain", bg: "#1d2b3a", in: wipe(0.3) }),
  title("NO MAGIC", { beats: 4, size: 72, sub: "A REEL EXAMPLE", anim: "punch", in: flash(0.25) }))
