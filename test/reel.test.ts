import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { type Img, type Sources, frameAt, image, needs, shotPlacement } from "../src/core/compose.ts";
import { loadSource } from "../src/node/load.ts";
import { FrameSource, inspect, probe } from "../src/node/media.ts";
import { analyzeMusic } from "../src/node/music.ts";
import { renderMp4 } from "../src/node/render.ts";
import { report } from "../src/node/report.ts";
import { serve } from "../src/node/server.ts";

const throwsMsg = (fn: () => unknown, re: RegExp) => assert.throws(fn, (e: Error) => re.test(e.message));
const dir = mkdtempSync(join(tmpdir(), "reel-"));
after(() => rmSync(dir, { recursive: true, force: true }));

/** Test media made by ffmpeg: a red still, a 2 s video that is blue then green, a 120 bpm click track. */
const ff = (...a: string[]) => assert.equal(spawnSync("ffmpeg", ["-y", "-v", "error", ...a]).status, 0);
ff("-f", "lavfi", "-i", "color=c=red:s=64x36", "-frames:v", "1", join(dir, "red.png"));
ff("-f", "lavfi", "-i", "color=c=blue:s=64x36:d=1:r=30", "-f", "lavfi", "-i", "color=c=lime:s=64x36:d=1:r=30",
  "-filter_complex", "[0][1]concat=n=2:v=1", "-pix_fmt", "yuv420p", join(dir, "bg.mp4"));
ff("-f", "lavfi", "-i", "aevalsrc='if(lt(mod(t,0.5),0.02),sin(2*PI*1000*t),0)':s=22050:d=6", join(dir, "click.wav"));

const solid = (r: number, g: number, b: number, w = 4, h = 4): Img => {
  const im = image(w, h);
  for (let i = 0; i < w * h; i++) im.data.set([r, g, b, 255], i * 4);
  return im;
};
const px = (im: Img, x: number, y: number) => Array.from(im.data.subarray((y * im.w + x) * 4, (y * im.w + x) * 4 + 3));

test("beats become frame-exact clip times", () => {
  const p = loadSource(`trailer("t", { w: 64, h: 36, fps: 30, bpm: 100 }, shot("a.png", { beats: 2 }), title("HI", { beats: 1 }), shot("a.png", { dur: 1 }))`, "t.rx.js", dir);
  const tl = p.timeline("t");
  assert.deepEqual(tl.clips.map((c) => [c.start, c.frames]), [[0, 36], [1.2, 18], [1.8, 30]]);
  assert.equal(tl.frames, 84);
  assert.equal(tl.beats[3], 1.8);
});

test("errors carry the file location and the clip path", () => {
  throwsMsg(() => loadSource(`trailer("t", {}, shot("a.png", { zom: 2 }))`, "t.rx.js"), /t\.rx\.js:1:\d+: .*shot: unknown option 'zom'/);
  throwsMsg(() => loadSource(`trailer("t", {}, shot("a.png", { move: { zoom: [1, 1.2] }, in: "fdae" }))`, "t.rx.js"), /did you mean 'fade'/);
  const p = loadSource(`trailer("t", {},\n  shot("a.png", { beats: 2 }))`, "t.rx.js");
  throwsMsg(() => p.timeline("t"), /t\.rx\.js:2:3: clip 1 \(shot a\.png\) > trailer 't'|t\.rx\.js:2:3: .*beats: 2 needs the trailer's bpm/);
  const q = loadSource(`trailer("t", { w: 64, h: 36 }, shot("missing.mp4"))`, "t.rx.js", dir);
  throwsMsg(() => report(q.timeline("t")), /no such file/);
});

test("cover keeps the frame filled and puts the focus point in the middle", () => {
  const p = loadSource(`trailer("t", {}, shot("a.png", { move: { zoom: 2, x: 0, y: 0.5 } }))`, "t.rx.js", dir);
  const d = p.trailers.get("t")!.clips[0];
  if (d.kind !== "shot") throw new Error();
  const { s, tx, ty } = shotPlacement(d, 100, 100, 200, 100, 0);
  assert.equal(s, 4);
  assert.equal(tx, 0);              // focus at the left edge, clamped so no black shows
  assert.equal(ty, -150);           // vertical focus 0.5 -> centred
});

test("transitions blend the outgoing and incoming clips", () => {
  const p = loadSource(`trailer("t", { w: 16, h: 16, fps: 10 }, shot("a.png", { dur: 1 }), shot("b.png", { dur: 1, in: fade(1) }), shot("c.png", { dur: 1, in: dip(1, "#ffffff") }))`, "t.rx.js", dir);
  const tl = p.timeline("t");
  const colors: Record<string, Img> = { "a.png": solid(255, 0, 0), "b.png": solid(0, 0, 255), "c.png": solid(0, 255, 0) };
  const src: Sources = { shot: (c) => colors[(c.def as { src: string }).src.replace(/^.*\//, "")], text: () => image(1, 1) };
  assert.deepEqual(needs(tl, 1.5).map((n) => n.clip.i), [1, 0]);
  const mid = px(frameAt(tl, 1.5, src), 4, 4);
  assert.ok(Math.abs(mid[0] - 128) < 3 && Math.abs(mid[2] - 128) < 3, `fade midpoint ${mid}`);
  assert.deepEqual(px(frameAt(tl, 2.5, src), 4, 4), [255, 255, 255]);   // dip peak
  assert.deepEqual(px(frameAt(tl, 0.5, src), 4, 4), [255, 0, 0]);
});

test("music analysis finds the tempo and the clicks", () => {
  const mi = analyzeMusic({ src: join(dir, "click.wav"), from: 0, vol: 1, fadeOut: 0 }, 6);
  assert.ok(mi.bpm && Math.abs(mi.bpm - 120) <= 1.5, `bpm ${mi.bpm}`);
  for (const h of mi.hits.slice(0, 6)) assert.ok(Math.abs(h.t / 0.5 - Math.round(h.t / 0.5)) < 0.1, `hit ${h.t} off the 0.5 s grid`);
});

test("the report checks beat alignment and source length", () => {
  const p = loadSource(`trailer("t", { w: 64, h: 36, bpm: 120, music: "click.wav" }, shot("bg.mp4", { dur: 1.3 }), shot("bg.mp4", { dur: 1.3, from: 1 }))`, "t.rx.js", dir);
  const r = report(p.timeline("t"));
  assert.match(r.text, /1 cut\(s\) off the beat grid/);
  assert.ok(r.warnings.some((w) => /holds the last frame/.test(w)), r.warnings.join("\n"));
});

test("renders an MP4 with the right length, size, picture and sound", async () => {
  const p = loadSource(`trailer("t", { w: 64, h: 36, fps: 30, music: "click.wav" },
    shot("bg.mp4", { dur: 1 }), shot("red.png", { dur: 0.5, in: fade(0.2) }), title("GO", { dur: 0.5, size: 20 }))`, "t.rx.js", dir);
  const out = join(dir, "t.mp4");
  await renderMp4(p.timeline("t"), out);
  const pr = probe(out);
  assert.equal(pr.w, 64); assert.equal(pr.h, 36); assert.ok(pr.audio);
  assert.ok(Math.abs(pr.dur! - 2) < 0.08, `duration ${pr.dur}`);
  // Frame 15 (0.5 s) is still the blue half of bg.mp4; frame 40 (1.33 s) is the red still.
  const at = (t: number) => Array.from(spawnSync("ffmpeg", ["-v", "error", "-ss", String(t), "-i", out, "-frames:v", "1", "-vf", "crop=2:2:31:17,scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]).stdout);
  const blue = at(0.5), red = at(1.33);
  assert.ok(blue[2] > 180 && blue[0] < 60, `blue ${blue}`);
  assert.ok(red[0] > 180 && red[2] < 60, `red ${red}`);
  assert.ok(!existsSync(join(dir, "t.part.mp4")), "the part file was renamed");
});

test("a render that fails or is cancelled leaves no MP4 under the real name", async () => {
  const p = loadSource(`trailer("c", { w: 64, h: 36, fps: 30 }, shot("red.png", { dur: 2 }))`, "c.rx.js", dir);
  const out = join(dir, "c.mp4"), ac = new AbortController();
  await assert.rejects(renderMp4(p.timeline("c"), out, { signal: ac.signal, onProgress: (f) => { if (f === 10) ac.abort(); } }), /cancelled/);
  assert.ok(!existsSync(out) && !existsSync(join(dir, "c.part.mp4")));
});

test("the live viewer serves state, exact frames and feedback", async () => {
  const file = join(dir, "live.rx.js");
  spawnSync("sh", ["-c", `printf '%s' 'trailer("t", { w: 64, h: 36 }, shot("red.png", { dur: 1 }))' > ${file}`]);
  const s = await serve(file, { port: 0, log: () => {} });
  try {
    const frame = await fetch(s.url + "api/frame?name=t&t=0.5&w=64");
    assert.equal(frame.headers.get("content-type"), "image/png");
    const r = await fetch(s.url + "api/feedback", { method: "POST", body: JSON.stringify({ name: "t", notes: [{ t: 0.4, text: "more red" }] }) });
    assert.equal(r.status, 200);
    const fb = JSON.parse(readFileSync(join(dir, "out", "_feedback", "t.json"), "utf8"));
    assert.equal(fb.notes[0].clip.n, 1);
    assert.match(fb.notes[0].clip.loc, /live\.rx\.js:1:\d+/);
  } finally {
    s.close();
  }
});

test("beat cuts stay on the grid at any tempo, and clips point at the line that made them", () => {
  const p = loadSource(`const play = (b) => shot("a.png", { beats: b })
trailer("t", { w: 64, h: 36, fps: 30, bpm: 84 },
  play(1), play(2), play(3),
  ${"play(2), ".repeat(40)}play(1))`, "t.rx.js", dir);
  const tl = p.timeline("t"), spb = 60 / 84;
  for (const c of tl.clips) {
    const beats = c.start / spb;
    assert.ok(Math.abs(beats - Math.round(beats)) * spb <= 0.5 / 30 + 1e-9, `clip ${c.i + 1} starts ${c.start} off the grid`);
  }
  assert.match(tl.clips[1].def.loc!, /^t\.rx\.js:3:/);
});

test("slide and zoom transitions, clip and trailer grades, overlays over clips", () => {
  const p = loadSource(`trailer("t", { w: 16, h: 16, fps: 10, grade: { saturation: 1 } },
    shot("a.png", { dur: 1, grade: { brightness: -0.5 } }),
    shot("b.png", { dur: 1, in: slide(1, "left") }),
    shot("c.png", { dur: 1, in: zoom(1) }),
    shot("a.png", { dur: 1, overlay: { src: "c.png", x: 0.25, y: 0.25, w: 0.25, at: 0.5 } }))`, "t.rx.js", dir);
  const tl = p.timeline("t");
  const colors: Record<string, Img> = { "a.png": solid(255, 0, 0), "b.png": solid(0, 0, 255), "c.png": solid(0, 255, 0) };
  const name = (s: string) => s.replace(/^.*\//, "");
  const src: Sources = { shot: (c) => colors[name((c.def as { src: string }).src)], text: () => image(1, 1), overlay: (ov) => colors[name(ov.src)] };
  assert.deepEqual(px(frameAt(tl, 0.5, src), 4, 4), [128, 0, 0], "the clip grade darkens the red shot");
  // slide from the left at the midpoint: the incoming blue covers the left half, red is pushed right
  const mid = frameAt(tl, 1.5, src);
  assert.deepEqual(px(mid, 3, 8), [0, 0, 255]);
  assert.deepEqual(px(mid, 12, 8), [128, 0, 0]);
  // zoom midpoint: a mix of the grown blue and the incoming green
  const z = px(frameAt(tl, 2.5, src), 8, 8);
  assert.ok(z[1] > 100 && z[2] > 60 && z[0] < 30, `zoom mix ${z}`);
  // the overlay appears half a second in, a quarter of the frame wide, centred at (0.25, 0.25)
  assert.deepEqual(px(frameAt(tl, 3.2, src), 4, 4), [255, 0, 0], "before `at`: no overlay");
  assert.deepEqual(px(frameAt(tl, 3.7, src), 4, 4), [0, 255, 0], "overlay pixel");
  assert.deepEqual(px(frameAt(tl, 3.7, src), 12, 12), [255, 0, 0], "outside the overlay");
  const down = loadSource(`trailer("t", { w: 16, h: 16, fps: 10 }, shot("a.png", { dur: 1 }), shot("b.png", { dur: 1, in: slide(1, "down") }))`, "t.rx.js", dir).timeline("t");
  assert.deepEqual(px(frameAt(down, 1.5, src), 8, 12), [0, 0, 255], "from below: the bottom half is the new clip");
  assert.deepEqual(px(frameAt(down, 1.5, src), 8, 3), [255, 0, 0]);
  throwsMsg(() => loadSource(`trailer("t", {}, shot("a.png", { in: slide(0.3, "sideways") }))`, "t.rx.js"), /slide\(\) direction must be one of/);
  throwsMsg(() => loadSource(`trailer("t", {}, shot("a.png", { grade: { contrast: 9 } }))`, "t.rx.js"), /contrast must be in 0\.\.4/);
  throwsMsg(() => loadSource(`trailer("t", {}, shot("a.png", { overlay: { src: "x.png", w: 0.2, h: 0.2 } }))`, "t.rx.js"), /give w or h/);
  throwsMsg(() => loadSource(`trailer("t", {}, shot("a.png", { overlay: { src: "x.png", opacty: 1 } }))`, "t.rx.js"), /unknown option 'opacty'/);
  assert.equal(frameAt(tl, 1.5, src).w, 16);
});

test("grade: saturation, tint and vignette change the right pixels", async () => {
  const { grade } = await import("../src/core/compose.ts");
  const im = solid(200, 50, 50, 20, 10);
  grade(im, { brightness: 0, contrast: 1, saturation: 0, gamma: 1, tintAmount: 0, vignette: 0 });
  const g = px(im, 10, 5);
  assert.ok(g[0] === g[1] && g[1] === g[2], `desaturated to gray: ${g}`);
  const t = solid(100, 100, 100, 20, 10);
  grade(t, { brightness: 0, contrast: 1, saturation: 1, gamma: 1, tint: "#ff0000", tintAmount: 0.5, vignette: 0 });
  assert.deepEqual(px(t, 10, 5), [178, 50, 50]);
  const v = solid(200, 200, 200, 20, 10);
  grade(v, { brightness: 0, contrast: 1, saturation: 1, gamma: 1, tintAmount: 0, vignette: 1 });
  assert.ok(px(v, 10, 5)[0] > 190 && px(v, 0, 0)[0] < 80, `vignette darkens the corners: ${px(v, 10, 5)} vs ${px(v, 0, 0)}`);
});

test("overlays are probed, decoded at their size and rendered; --gif writes an animated GIF", async () => {
  const p = loadSource(`trailer("t", { w: 64, h: 36, fps: 30 }, shot("bg.mp4", { dur: 0.5, overlay: [{ src: "red.png", x: 0.25, y: 0.5, w: 0.5 }, { src: "bg.mp4", x: 0.8, y: 0.8, h: 0.3, opacity: 0.5 }] }))`, "t.rx.js", dir);
  const tl = p.timeline("t");
  const { probes } = inspect(tl);
  assert.ok(probes.has(join(dir, "red.png")));
  const im = frameAt(tl, 0.2, new FrameSource(tl, probes));
  const left = px(im, 16, 18), right = px(im, 50, 10);
  assert.ok(left[0] > 180 && left[2] < 60, `the red overlay covers the left quarter: ${left}`);
  assert.ok(right[2] > 180 && right[0] < 60, `the clip shows through elsewhere: ${right}`);
  const missing = loadSource(`trailer("t", { w: 64, h: 36 }, shot("red.png", { overlay: { src: "nope.png" } }))`, "t.rx.js", dir);
  throwsMsg(() => inspect(missing.timeline("t")), /clip 1 .* overlay.*no such file|no such file/);
  const { gifFromMp4, renderMp4: render } = await import("../src/node/render.ts");
  const mp4 = join(dir, "ov.mp4"), gif = join(dir, "ov.gif");
  await render(tl, mp4);
  gifFromMp4(mp4, gif, 32, 10);
  const b = readFileSync(gif);
  assert.equal(b.toString("ascii", 0, 6), "GIF89a");
  assert.equal(b.readUInt16LE(6), 32, "scaled to the asked width");
});
