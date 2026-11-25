import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const version = "1.13.8";
const archives = {
  "win32-x64": ["win-x64-static-MT-Release-lib", 123206268, "56ffcf3c454c1f14f7bc9887286cc8143e7e542dc632804e1c447d5f8d534eaf"],
  "win32-arm64": ["win-arm64-static-MT-Release-lib", 140595209, "609988769f805ca2a602622174ac737edf6dce8a50efa2da9da2d915947da31b"],
  "linux-x64": ["linux-x64-static-lib", 22952328, "e1fdc5b67530e15741ef897fa5ffff297056f3bf0c6d829a27af9225a4c4b5a6"],
  "linux-arm64": ["linux-aarch64-static-lib", 21325380, "77983e3cf29aa60f2e531d249dbd01d15596530550c8db2e9e02fc6a655da6bb"],
};
const platform = archives[process.platform + "-" + process.arch];
if (!platform) throw new Error("Unsupported Sherpa ONNX build platform");

const [suffix, size, sha256] = platform;
const stem = "sherpa-onnx-v" + version + "-" + suffix;
const file = stem + ".tar.bz2";
const cache = resolve("target", "sherpa-onnx-prebuilt");
const archive = join(cache, file);

async function verified(path) {
  const info = await stat(path).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!info?.isFile() || info.size !== size) return false;
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex") === sha256;
}

await mkdir(cache, { recursive: true });
if (!await verified(archive)) {
  const partial = join(cache, file + "." + randomUUID() + ".download");
  try {
    const response = await fetch("https://github.com/k2-fsa/sherpa-onnx/releases/download/v" + version + "/" + file,
      { signal: AbortSignal.timeout(240_000) });
    if (!response.ok || !response.body) throw new Error("Sherpa ONNX download failed: HTTP " + response.status);
    let length = 0;
    await pipeline(Readable.fromWeb(response.body), async function* (chunks) {
      for await (const chunk of chunks) {
        length += chunk.length;
        if (length > size) throw new Error("Sherpa ONNX archive is larger than expected");
        yield chunk;
      }
    }, createWriteStream(partial, { flags: "wx" }));
    if (!await verified(partial)) throw new Error("Sherpa ONNX archive failed SHA-256 verification");
    await rename(partial, archive);
  } finally {
    await rm(partial, { force: true });
  }
}

// A fresh extraction keeps the verified build independent of any earlier
// extraction by the dependency's own build script.
const extracted = await mkdtemp(join(cache, "verified-"));
const result = spawnSync("tar", ["-xf", archive, "-C", extracted], { stdio: ["ignore", "ignore", "inherit"] });
if (result.error) throw result.error;
if (result.status !== 0) throw new Error("Sherpa ONNX archive could not be extracted");
const lib = join(extracted, stem, "lib");
if (!(await stat(lib)).isDirectory()) throw new Error("Sherpa ONNX library directory is missing");
console.log(lib);
