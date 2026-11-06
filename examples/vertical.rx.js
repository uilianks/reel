// A 9:16 short for phones: one wide poster re-aimed by camera moves, captions, a night grade, pixel
// torches as overlays on the end card, and a cave ambience under it all.
// Build: reel build examples/vertical.rx.js --gif 240
const poster = "media/forest_kit_poster.png"
const torch = (x) => ({ src: "media/torch.gif", x, y: 0.3, h: 0.13, pixel: true })
trailer("vertical", { w: 360, h: 640, fps: 30, music: { src: "media/cave.ogg", fadeOut: 0.8 }, fadeIn: 0.4, fadeOut: 0.4 },
  shot(poster, { dur: 2.2, move: { zoom: [1, 1.1], x: [0.15, 0.35] }, caption: { text: "Deep in the forest...", size: 26 } }),
  shot(poster, { dur: 2.2, move: { zoom: [1.4, 1.6], x: [0.6, 0.8], y: 0.6 }, in: fade(0.4),
    caption: { text: "...the torches burn", size: 26 },
    grade: { brightness: -0.08, saturation: 0.8, tint: "#3050a0", tintAmount: 0.2, vignette: 0.6 } }),
  title("FOREST KIT", { dur: 1.6, size: 48, sub: "vex · pxl · chirp", in: dip(0.4), overlay: [torch(0.36), torch(0.64)] }))
