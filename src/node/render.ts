// Render a timeline to MP4: frames composed in order and piped to ffmpeg (H.264), mixed with the
// music, sfx and any shot audio in the same ffmpeg run.
import { spawn } from "node:child_process";
import { mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { type Img, type Sources, type TextSpec, frameAt, image, needs, scaled } from "../core/compose.ts";
import { ReelError } from "../core/errors.ts";
import type { Clip, Overlay, ShotDef, Timeline } from "../core/project.ts";
import { spawnSync } from "node:child_process";
import { FrameSource, type Probe, ShotStream, decodeSize, inspect, textImage } from "./media.ts";

export interface RenderOptions {
  /** Draw this many times smaller (0.5 = proxy). */
  scale?: number;
  /** x264 preset. */
  preset?: string;
  crf?: number;
  onProgress?: (frame: number, frames: number) => void;
  /** Stops the render (the live viewer cancels a proxy when the file changes). */
  signal?: AbortSignal;
  /** Only these frames [from, to) are drawn, as a silent clip that starts at `from` (a chunk of a proxy: see proxy.ts). */
  range?: [number, number];
}

/** ffmpeg audio inputs and the filter that mixes them into [a], or nothing if the trailer is silent. */
export function audioGraph(tl: Timeline, probes: Map<string, Probe>, first: number): { inputs: string[]; filter?: string } {
  const inputs: string[] = [], parts: string[] = [], labels: string[] = [], D = tl.dur.toFixed(4);
  let k = first;
  const m = tl.def.music;
  if (m) {
    inputs.push("-ss", String(m.from), "-i", m.src);
    const fo = Math.min(m.fadeOut, tl.dur);
    parts.push(`[${k}:a]atrim=0:${D},asetpts=PTS-STARTPTS,volume=${m.vol}${fo > 0 ? `,afade=t=out:st=${(tl.dur - fo).toFixed(4)}:d=${fo}` : ""}[m]`);
    labels.push("[m]"); k++;
  }
  for (const c of tl.clips) {
    for (const [j, s] of c.def.sfx.entries()) {
      inputs.push("-i", s.src);
      const ms = Math.round((c.start + s.at) * 1000);
      parts.push(`[${k}:a]volume=${s.vol},adelay=${ms}:all=1[s${c.i}_${j}]`);
      labels.push(`[s${c.i}_${j}]`); k++;
    }
    const d = c.def;
    if (d.kind === "shot" && d.audio > 0 && probes.get(d.src)?.audio) {
      // atempo covers 0.5..2 per stage; chain stages for larger speed changes.
      let tempo = "", sp = d.speed;
      while (sp > 2) { tempo += ",atempo=2"; sp /= 2; }
      while (sp < 0.5) { tempo += ",atempo=0.5"; sp /= 0.5; }
      if (sp !== 1) tempo += `,atempo=${sp}`;
      const len = c.dur.toFixed(4), fade = Math.min(0.05, c.dur / 4);
      inputs.push("-ss", String(d.from), "-i", d.src);
      parts.push(`[${k}:a]asetpts=PTS-STARTPTS${tempo},atrim=0:${len},afade=t=in:d=${fade},afade=t=out:st=${(c.dur - fade).toFixed(4)}:d=${fade},volume=${d.audio},adelay=${Math.round(c.start * 1000)}:all=1[v${c.i}]`);
      labels.push(`[v${c.i}]`); k++;
    }
  }
  if (!labels.length) return { inputs };
  const mix = labels.length > 1 ? `${labels.join("")}amix=inputs=${labels.length}:normalize=0:duration=longest,` : `${labels[0]}`;
  const tail = labels.length > 1 ? "" : "anull,";
  return { inputs, filter: `${parts.join(";")};${mix}${tail}apad,atrim=0:${D},alimiter=limit=0.95:level=false[a]` };
}

/** Live clip frames for the render loop: one ffmpeg stream per moving shot, opened when first needed. */
class StreamSources implements Sources {
  private streams = new Map<number, ShotStream>();
  private stills: FrameSource;
  private texts = new Map<string, Img>();
  /** Frames fetched for the frame being composed. */
  ready = new Map<number, Img>();

  private tl: Timeline;
  private probes: Map<string, Probe>;

  constructor(tl: Timeline, probes: Map<string, Probe>) {
    this.tl = tl;
    this.probes = probes;
    this.stills = new FrameSource(tl, probes);
  }

  async prepare(t: number): Promise<void> {
    this.ready.clear();
    const live = new Set<number>();
    for (const { clip, u } of needs(this.tl, t)) {
      live.add(clip.i);
      if (clip.def.kind !== "shot") continue;
      const p = this.probes.get(clip.def.src)!;
      if (p.dur === undefined) { this.ready.set(clip.i, this.stills.shot(clip, u)); continue; }
      let s = this.streams.get(clip.i);
      if (!s) {
        const d = clip.def as ShotDef, [w, h] = decodeSize(d, p, this.tl.def.w, this.tl.def.h);
        const tail = this.tl.clips[clip.i + 1]?.def.in.dur ?? 0;
        s = new ShotStream(d, p, u, clip.dur + tail - u + 1, this.tl.def.fps, w, h);
        this.streams.set(clip.i, s);
      }
      this.ready.set(clip.i, await s.next());
    }
    for (const [i, s] of this.streams) if (!live.has(i)) { s.close(); this.streams.delete(i); }
  }

  shot(c: Clip): Img {
    const im = this.ready.get(c.i);
    if (!im) throw new ReelError(`internal: clip ${c.i + 1} frame was not prepared`);
    return im;
  }

  text(spec: TextSpec): Img {
    return textImage(spec, this.texts);
  }

  /** Overlays are small and few: random access through the still source is enough. */
  overlay(ov: Overlay, u: number): Img {
    return this.stills.overlay(ov, u);
  }

  close(): void {
    for (const s of this.streams.values()) s.close();
  }
}

/** An animated GIF from a rendered MP4 (two-pass palette), `width` px wide at `fps`, for READMEs, stores and social posts. */
export function gifFromMp4(mp4: string, gif: string, width = 480, fps = 15): void {
  const part = gif.replace(/(\.gif)?$/, ".part.gif");
  const r = spawnSync("ffmpeg", ["-y", "-v", "error", "-i", mp4, "-vf", `fps=${fps},scale=${width}:-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=255:stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a`, "-loop", "0", part]);
  if (r.error) throw new ReelError("--gif needs ffmpeg on PATH");
  if (r.status !== 0) { rmSync(part, { force: true }); throw new ReelError(`ffmpeg failed (gif): ${String(r.stderr).trim().split("\n").slice(-3).join(" | ")}`); }
  renameSync(part, gif);
}

export async function renderMp4(full: Timeline, out: string, opts: RenderOptions = {}): Promise<{ ms: number; warnings: string[] }> {
  const t0 = performance.now();
  const tl = scaled(full, opts.scale ?? 1);
  const { probes, warnings } = inspect(tl);
  const { w, h, fps } = tl.def;
  const [first, last] = opts.range ?? [0, tl.frames];
  // a chunk is silent: its sound is mixed once, over the joined chunks
  const audio = opts.range ? { inputs: [] as string[], filter: undefined } : audioGraph(tl, probes, 1);
  mkdirSync(dirname(out), { recursive: true });
  // ffmpeg writes beside the target and the file is renamed when complete: an interrupted or failed
  // render never leaves a truncated MP4 under the real name (a player or a game would load it).
  const part = out.replace(/(\.mp4)?$/, ".part.mp4");
  const args = ["-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${w}x${h}`, "-r", String(fps), "-i", "pipe:0", ...audio.inputs,
    ...(audio.filter ? ["-filter_complex", audio.filter, "-map", "0:v", "-map", "[a]", "-c:a", "aac", "-b:a", "192k"] : ["-map", "0:v"]),
    "-c:v", "libx264", "-preset", opts.preset ?? "medium", "-crf", String(opts.crf ?? 18), "-pix_fmt", "yuv420p", "-movflags", "+faststart",
    ...(opts.range ? ["-frames:v", String(last - first)] : ["-t", tl.dur.toFixed(4)]), part];
  const ff = spawn("ffmpeg", args, { stdio: ["pipe", "ignore", "pipe"] });
  let err = "";
  ff.stderr.on("data", (b: Buffer) => { err += b; });
  const done = new Promise<void>((ok, fail) => {
    ff.on("error", () => fail(new ReelError("rendering needs ffmpeg on PATH")));
    ff.on("close", (code) => code === 0 ? ok() : fail(new ReelError(`ffmpeg failed: ${err.trim().split("\n").slice(-4).join(" | ")}`)));
  });
  done.catch(() => {});
  ff.stdin.on("error", () => {}); // a dead ffmpeg surfaces through `done`
  const src = new StreamSources(tl, probes);
  try {
    for (let f = first; f < last; f++) {
      if (opts.signal?.aborted) throw new ReelError("render cancelled");
      const t = f / fps;
      await src.prepare(t);
      // A fresh image per frame: the pipe keeps a reference until it is flushed.
      const frame = frameAt(tl, t, src, image(w, h));
      if (!ff.stdin.write(frame.data)) await Promise.race([new Promise((r) => ff.stdin.once("drain", r)), done]);
      opts.onProgress?.(f + 1 - first, last - first);
    }
  } catch (e) {
    ff.kill("SIGKILL");
    rmSync(part, { force: true });
    throw e;
  } finally {
    src.close();
    ff.stdin.end();
  }
  try { await done; } catch (e) { rmSync(part, { force: true }); throw e; }
  renameSync(part, out);
  return { ms: Math.round(performance.now() - t0), warnings };
}
