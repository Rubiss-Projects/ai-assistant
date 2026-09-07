import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inputByteLimit } from "../utils/fetchArtifact.js";
let busy = false;
function mediaCommand(program, args, signal) {
    return new Promise((resolve, reject) => {
        const child = spawn(program, args, {
            stdio: ["ignore", "pipe", "pipe"], signal, killSignal: "SIGKILL",
            env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, LANG: "C", HOME: os.tmpdir() },
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (data) => { stdout = (stdout + data.toString()).slice(-64_000); });
        child.stderr.on("data", (data) => { stderr = (stderr + data.toString()).slice(-8_000); });
        child.on("error", (error) => reject(error.code === "ENOENT"
            ? new Error("FFmpeg/ffprobe is unavailable. Install FFmpeg on the bot host or use the supplied Docker image.") : error));
        child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(`Media processing failed: ${stderr || `exit ${code}`}`)));
    });
}
/** Fixed software encoder recipes; no shell, remote inputs, or model-supplied FFmpeg arguments. */
export async function transcodeVideo(data, codec, signal) {
    if (busy)
        throw new Error("Another video conversion is running. Retry after it finishes.");
    busy = true;
    let directory;
    const timeout = Number(process.env.AI_MEDIA_TIMEOUT_MS ?? 300_000);
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(Number.isSafeInteger(timeout) && timeout > 0 ? Math.min(timeout, 900_000) : 300_000)]);
    const inputOptions = ["-protocol_whitelist", "file,pipe", "-format_whitelist", "mov,matroska,avi,mpegts,mpeg,ogg,flv"];
    try {
        directory = await mkdtemp(path.join(os.tmpdir(), "assistant-media-"));
        const input = path.join(directory, "input");
        const output = path.join(directory, "output.mp4");
        await writeFile(input, data, { mode: 0o600 });
        const probe = JSON.parse(await mediaCommand("ffprobe", ["-v", "error", ...inputOptions,
            "-show_streams", "-show_format", "-of", "json", input], deadline));
        const video = probe.streams?.find((stream) => stream.codec_type === "video");
        if (!video || !video.width || !video.height || video.width * video.height > 3840 * 2160) {
            throw new Error("Input must contain video at no more than 3840×2160 pixels.");
        }
        const duration = Number(probe.format?.duration);
        if (!Number.isFinite(duration) || duration <= 0 || duration > 600) {
            throw new Error("Video duration must be known and no longer than 10 minutes.");
        }
        const encoder = codec === "av1"
            ? ["-c:v", "libsvtav1", "-preset", "10", "-crf", "35", "-svtav1-params", "lp=2"]
            : ["-c:v", codec === "h264" ? "libx264" : "libx265", "-preset", "veryfast", "-crf", "28",
                ...(codec === "hevc" ? ["-x265-params", "pools=2:frame-threads=2"] : [])];
        await mediaCommand("ffmpeg", ["-nostdin", "-v", "error", "-xerror", ...inputOptions, "-threads", "2", "-i", input,
            "-map", "0:v:0", "-map", "0:a:0?", "-map_metadata", "-1", "-map_chapters", "-1", "-sn", "-dn",
            "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-pix_fmt", "yuv420p", ...encoder, "-threads", "2",
            "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", "-fs", String(inputByteLimit()), output], deadline);
        // Decode the completed output before handing it to the agent. A successful process
        // exit alone does not establish that the produced file is usable.
        await mediaCommand("ffmpeg", ["-nostdin", "-v", "error", "-xerror", ...inputOptions, "-threads", "2",
            "-i", output, "-f", "null", "-"], deadline);
        const completed = JSON.parse(await mediaCommand("ffprobe", ["-v", "error", ...inputOptions,
            "-show_entries", "format=duration:stream=codec_name,codec_type", "-of", "json", output], deadline));
        const outputDuration = Number(completed.format?.duration);
        if (completed.streams?.find((stream) => stream.codec_type === "video")?.codec_name !== codec
            || !Number.isFinite(outputDuration) || Math.abs(outputDuration - duration) > Math.max(0.5, duration * 0.01)) {
            throw new Error("Converted video is incomplete or has the wrong codec; the output was rejected.");
        }
        return await readFile(output);
    }
    finally {
        if (directory)
            await rm(directory, { recursive: true, force: true });
        busy = false;
    }
}
