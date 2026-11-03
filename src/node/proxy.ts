// The proxy: a fast half-size copy of a trailer for the live viewer (and `build --proxy`).
// It is drawn in chunks of `CHUNK` frames, each by its own process (one per free core), and every chunk is cached by a hash of what
// goes into its frames (the clips that touch it, the trailer's look, the source files' size and time). After an edit only the
// chunks that changed are drawn again; the chunks are joined (no re-encoding) and the sound is mixed once over the result.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scaled } from "../core/compose.ts";
import { ReelError } from "../core/errors.ts";
import type { ClipDef, Timeline } from "../core/project.ts";
import { audioGraph } from "./render.ts";
import { inspect } from "./media.ts";

export const CHUNK = 45;
const KEEP = 400;

export interface ProxyOptions {
  /** The trailer file and its name: each chunk process loads them again. */
  file: string;
  name: string;
  scale?: number;
  jobs?: number;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

const stamp = (path: string) => { try { const s = statSync(path); return `${s.size}:${Math.round(s.mtimeMs)}`; } catch { return "missing"; } };

/** Everything that can change the pixels of frames [first, last): the look of the trailer, the clips near them, the files they read. */
function chunkKey(tl: Timeline, first: number, last: number, scale: number): string {
  const fps = tl.def.fps, t0 = first / fps - 1.5, t1 = last / fps + 1.5;
  const strip = (d: ClipDef) => JSON.stringify(d, (k, v) => (k === "loc" ? undefined : v));
  const clips = tl.clips.filter((c) => c.start + c.dur >= t0 && c.start <= t1);
  const files = new Set<string>();
  for (const c of clips) {
    const d = c.def as { src?: string; overlay?: { src: string }[] };
    if (d.src) files.add(d.src);
    for (const o of d.overlay ?? []) files.add(o.src);
  }
  const { clips: _c, ...look } = tl.def as unknown as Record<string, unknown>;
  const h = createHash("sha1");
  h.update(JSON.stringify({ look: JSON.parse(JSON.stringify(look, (k, v) => (k === "loc" ? undefined : v))), scale, first, last, n: tl.frames }));
  for (const c of clips) h.update(`${c.i}|${c.start.toFixed(4)}|${c.dur.toFixed(4)}|${strip(c.def)}`);
  for (const f of [...files].sort()) h.update(`${f}=${stamp(f)}`);
  return h.digest("hex").slice(0, 20);
}

/** Draws the proxy of `full` into `out`; resolves with the ms it took and how many chunks were reused. */
export async function renderProxy(full: Timeline, out: string, opts: ProxyOptions): Promise<{ ms: number; reused: number; chunks: number }> {
  const t0 = performance.now();
  const scale = opts.scale ?? 0.5;
  const tl = scaled(full, scale);
  const cache = join(dirname(out), "cache", opts.name);
  mkdirSync(cache, { recursive: true });
  const plan: { first: number; last: number; path: string }[] = [];
  for (let f = 0; f < tl.frames; f += CHUNK) {
    const last = Math.min(f + CHUNK, tl.frames);
    plan.push({ first: f, last, path: join(cache, chunkKey(full, f, last, scale) + ".mp4") });
  }
  const todo = plan.filter((c) => !existsSync(c.path));
  let done = plan.length - todo.length;
  opts.onProgress?.(done, plan.length);
  const jobs = Math.max(1, Math.min(opts.jobs ?? cpus().length - 2, todo.length));
  const running = new Set<ChildProcess>();
  const worker = fileURLToPath(new URL("./proxy_worker.ts", import.meta.url));
  const kill = () => { for (const p of running) p.kill("SIGKILL"); };
  opts.signal?.addEventListener("abort", kill, { once: true });
  let next = 0, failure: Error | undefined;
  const lane = async () => {
    while (!failure && !opts.signal?.aborted && next < todo.length) {
      const c = todo[next++], part = c.path.replace(/\.mp4$/, ".part.mp4");
      await new Promise<void>((ok) => {
        const p = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", worker, opts.file, opts.name, String(scale), String(c.first), String(c.last), part], { stdio: ["ignore", "ignore", "pipe"] });
        running.add(p);
        let err = "";
        p.stderr.on("data", (b: Buffer) => { err += b; });
        p.on("close", (code) => {
          running.delete(p);
          if (code === 0 && existsSync(part)) { renameSync(part, c.path); opts.onProgress?.(++done, plan.length); }
          else { rmSync(part, { force: true }); if (!opts.signal?.aborted) failure = new ReelError(`proxy chunk ${c.first}-${c.last} failed: ${err.trim().split("\n").slice(-3).join(" | ")}`); }
          ok();
        });
      });
    }
  };
  await Promise.all(Array.from({ length: jobs }, lane));
  opts.signal?.removeEventListener("abort", kill);
  if (opts.signal?.aborted) throw new ReelError("render cancelled");
  if (failure) throw failure;
  // join the chunks and mix the sound over them in one pass (the video is copied, not drawn again)
  const list = out.replace(/\.mp4$/, ".list.txt"), tmp = out.replace(/\.mp4$/, ".part.mp4");
  writeFileSync(list, plan.map((c) => `file '${c.path.replace(/'/g, "'\\''")}'`).join("\n") + "\n");
  const { probes } = inspect(tl);
  const audio = audioGraph(tl, probes, 1);
  const args = ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", list, ...audio.inputs,
    ...(audio.filter ? ["-filter_complex", audio.filter, "-map", "0:v", "-map", "[a]", "-c:a", "aac", "-b:a", "192k"] : ["-map", "0:v"]),
    "-c:v", "copy", "-movflags", "+faststart", "-t", tl.dur.toFixed(4), tmp];
  const r = spawnSync("ffmpeg", args);
  rmSync(list, { force: true });
  if (r.error || r.status !== 0) { rmSync(tmp, { force: true }); throw new ReelError(`proxy join failed: ${String(r.stderr).trim().split("\n").slice(-3).join(" | ")}`); }
  renameSync(tmp, out);
  prune(cache, new Set(plan.map((c) => c.path)));
  return { ms: Math.round(performance.now() - t0), reused: plan.length - todo.length, chunks: plan.length };
}

/** Old chunks pile up as the trailer is edited: past KEEP files, the oldest ones that this run did not use go. */
function prune(dir: string, used: Set<string>): void {
  const files = readdirSync(dir).filter((f) => f.endsWith(".mp4") && !f.includes(".part")).map((f) => join(dir, f));
  if (files.length <= KEEP) return;
  const old = files.filter((f) => !used.has(f)).sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);
  for (const f of old.slice(0, files.length - KEEP)) rmSync(f, { force: true });
}
