import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type VideoAnalysis = { transcript: string; images: string[] };
export type ProcessRunner = (command: string, args: string[]) => Promise<void>;

type VideoAnalyzerOptions = {
  transcribe(bytes: Buffer, mimeType: string): Promise<string>;
  run?: ProcessRunner;
};

const runProcess: ProcessRunner = async (command, args) => {
  await execFileAsync(command, args, {
    maxBuffer: 4 * 1024 * 1024,
    timeout: 120_000,
    killSignal: "SIGKILL",
  });
};

const extensionFor = (mimeType: string): string => {
  const extension = mimeType === "video/quicktime" ? ".mov" : `.${mimeType.split("/")[1] ?? "mp4"}`;
  return /^[.][a-z0-9]+$/i.test(extension) ? extension : ".mp4";
};

export const createVideoAnalyzer = (options: VideoAnalyzerOptions) =>
  async (bytes: Buffer, mimeType: string): Promise<VideoAnalysis> => {
    const directory = await mkdtemp(join(tmpdir(), "flow-video-"));
    const inputPath = join(directory, `recording${extensionFor(mimeType)}`);
    const audioPath = join(directory, "audio.mp3");
    const framePattern = join(directory, "frame-%03d.jpg");

    try {
      await writeFile(inputPath, bytes);
      let transcript = "";
      try {
        await (options.run ?? runProcess)("ffmpeg", [
          "-hide_banner", "-loglevel", "error", "-y", "-threads", "1", "-t", "120", "-i", inputPath,
          "-vn", "-ac", "1", "-ar", "16000", "-b:a", "64k", "-fs", "8388608", audioPath,
        ]);
        transcript = await options.transcribe(await readFile(audioPath), "audio/mpeg");
      } catch {
        transcript = "";
      }

      await (options.run ?? runProcess)("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y", "-threads", "1", "-t", "120", "-i", inputPath,
        "-vf", "fps=1/3,scale='min(1280,iw)':-2", "-frames:v", "12", framePattern,
      ]);
      const frames = (await readdir(directory))
        .filter((name) => /^frame-\d{3}\.jpg$/.test(name))
        .sort()
        .slice(0, 12);
      if (frames.length === 0) throw new Error("Screen recording did not contain readable frames");
      const images = await Promise.all(frames.map(async (name) =>
        `data:image/jpeg;base64,${(await readFile(join(directory, name))).toString("base64")}`));
      return { transcript, images };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };
