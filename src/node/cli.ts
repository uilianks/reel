// reel command line.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { frameAt } from "../core/compose.ts";
import { ReelError, didYouMean, wrap } from "../core/errors.ts";
import { png } from "../core/png.ts";
import type { Project } from "../core/project.ts";
import { loadProject } from "./load.ts";
import { FrameSource, inspect } from "./media.ts";
import { renderProxy } from "./proxy.ts";
import { gifFromMp4, renderMp4 } from "./render.ts";
import { contactSheet, report } from "./report.ts";
import { serve } from "./server.ts";

const USAGE = `reel — video game trailers as code

  reel build <trailer.rx.js> [--out DIR] [--only a,b] [--proxy] [--scale N] [--gif [WIDTH]] [--no-preview]
      Render each trailer to out/<name>.mp4 (H.264 + AAC) and a contact sheet to
      out/_preview/<name>.png. --proxy renders half size, fast, to out/_proxy/. --scale N renders N times the trailer's size (2 turns 1080p into 4K: titles and
      overlays scale with it) at full quality, in cached chunks on every free core, to out/<name>_<w>x<h>.mp4.
      --gif also writes out/<name>.gif (480 px wide at 15 fps, or WIDTH px) for READMEs and posts.
  reel info  <trailer.rx.js> [name]
      Clip times, beat alignment, music loudness and hits per clip, warnings.
  reel frame <trailer.rx.js> <name> <seconds> [--out DIR]
      Write the exact frame at a time, full size, to out/_preview/<name>@<s>.png.
  reel serve <trailer.rx.js> [--port 4340] [--out DIR]
      Live viewer: scrub the timeline, play a proxy with sound, leave notes for the agent.
  reel list  <trailer.rx.js>
      List trailers with their source locations.

Trailer files may be .js or .ts. Media paths are relative to the file. Needs ffmpeg.`;

interface Args { cmd?: string; file?: string; rest: string[]; out?: string; only?: string[]; proxy?: boolean; scale?: number; preview?: boolean; port?: number; gif?: number }

function parse(argv: string[]): Args {
  const a: Args = { rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    const val = () => {
      const x = argv[++i];
      if (x === undefined) throw new ReelError(`${v} needs a value`);
      return x;
    };
    if (v === "--out") a.out = val();
    else if (v === "--only") a.only = val().split(",").map((s) => s.trim()).filter(Boolean);
    else if (v === "--proxy") a.proxy = true;
    else if (v === "--scale") a.scale = Number(val());
    else if (v === "--gif") { const n = Number(argv[i + 1]); if (Number.isFinite(n) && n > 0) { a.gif = n; i++; } else a.gif = 480; }
    else if (v === "--no-preview") a.preview = false;
    else if (v === "--port") a.port = Number(val());
    else if (v === "-h" || v === "--help") a.cmd = "help";
    else if (v.startsWith("--")) throw new ReelError(`unknown flag ${v}\n\n${USAGE}`);
    else if (!a.cmd) a.cmd = v;
    else if (!a.file) a.file = v;
    else a.rest.push(v);
  }
  return a;
}

function pick(p: Project, only?: string[]): string[] {
  if (!only) return p.order;
  for (const n of only) if (!p.trailers.has(n)) throw new ReelError(`unknown trailer '${n}'${didYouMean(n, p.order)}`);
  return only;
}

export async function main(argv: string[]): Promise<number> {
  let a: Args;
  try { a = parse(argv); } catch (e) { console.error(wrap(e).message); return 2; }
  if (!a.cmd || a.cmd === "help" || !a.file) {
    console.log(USAGE);
    return a.cmd === "help" ? 0 : 2;
  }
  const file = resolve(a.file);
  const outDir = a.out ? resolve(a.out) : join(dirname(file), "out");
  try {
    switch (a.cmd) {
      case "build": {
        const p = loadProject(file);
        let failed = 0;
        for (const name of pick(p, a.only)) {
          try {
            const tl = p.timeline(name);
            const r = report(tl);
            if (a.preview !== false) {
              mkdirSync(join(outDir, "_preview"), { recursive: true });
              writeFileSync(join(outDir, "_preview", name + ".png"), contactSheet(tl, r.music));
            }
            const big = !a.proxy && a.scale !== undefined && a.scale !== 1;
            const out = join(outDir, a.proxy ? "_proxy" : "", big ? `${name}_${Math.round(tl.def.w * a.scale!)}x${Math.round(tl.def.h * a.scale!)}.mp4` : name + ".mp4");
            let shown = -1;
            const onProgress = (f: number, n: number) => { const pc = Math.floor((f / n) * 10); if (process.stderr.isTTY && pc !== shown) { shown = pc; process.stderr.write(`\r${name} ${pc * 10}%`); } };
            // the proxy is drawn in cached chunks on every free core: an edit redraws only what it touched
            const res = a.proxy ? await renderProxy(tl, out, { file, name, scale: 0.5, onProgress }) : big ? await renderProxy(tl, out, { file, name, scale: a.scale!, preset: "medium", crf: 18, onProgress }) : await renderMp4(tl, out, { scale: 1, preset: "medium", crf: 18, onProgress });
            if (process.stderr.isTTY) process.stderr.write("\r\x1b[K");
            let gifNote = "";
            if (a.gif) { const g = join(outDir, name + ".gif"); gifFromMp4(out, g, a.gif); gifNote = ` + ${g}`; }
            console.log(`${r.text.split("\n")[0]} -> ${out} (${(res.ms / 1000).toFixed(1)}s)${gifNote}`);
            for (const w of r.warnings) console.log("  warning: " + w);
          } catch (e) {
            failed++;
            console.error("error: " + wrap(e, (s) => p.locFromStack(s)).message);
          }
        }
        console.log(`-> ${outDir}${failed ? ` (${failed} error${failed > 1 ? "s" : ""})` : ""}`);
        return failed ? 1 : 0;
      }
      case "info": {
        const p = loadProject(file);
        for (const name of pick(p, a.rest[0] ? [a.rest[0]] : undefined)) console.log(report(p.timeline(name)).text + "\n");
        return 0;
      }
      case "frame": {
        const [name, ts] = a.rest;
        const t = Number(ts);
        if (!name || !Number.isFinite(t)) throw new ReelError("frame needs a trailer and a time: reel frame <file> <name> <seconds>");
        const tl = loadProject(file).timeline(name);
        if (t < 0 || t >= tl.dur) throw new ReelError(`time ${t} is outside the trailer (0..${tl.dur.toFixed(2)}s)`);
        const tf = Math.floor(t * tl.def.fps + 1e-6) / tl.def.fps;
        const im = frameAt(tl, tf, new FrameSource(tl, inspect(tl).probes));
        const out = join(outDir, "_preview", `${name}@${tf.toFixed(2)}.png`);
        mkdirSync(dirname(out), { recursive: true });
        writeFileSync(out, png(im.w, im.h, im.data, (b) => deflateSync(b)));
        console.log(`${name} frame ${Math.round(tf * tl.def.fps)} (${tf.toFixed(3)}s) -> ${out}`);
        return 0;
      }
      case "list": {
        const p = loadProject(file);
        for (const n of p.order) {
          const tl = p.timeline(n);
          console.log(`${n.padEnd(24)} ${tl.dur.toFixed(2).padStart(7)}s ${String(tl.clips.length).padStart(3)} clips  ${tl.def.loc ?? ""}`);
        }
        return 0;
      }
      case "serve": {
        const s = await serve(file, { port: a.port, out: outDir });
        console.log(`reel live viewer: ${s.url}  (watching ${file}; Ctrl+C to stop)`);
        return await new Promise<number>(() => {});
      }
      default:
        console.error(`unknown command '${a.cmd}'\n\n${USAGE}`);
        return 2;
    }
  } catch (e) {
    console.error("error: " + wrap(e).message);
    return 1;
  }
}
