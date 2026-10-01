import fs from "node:fs/promises";
import path from "node:path";

// Menyaring "../" dari teks path tidak cukup: symlink dan path absolut tetap
// lolos. Yang menentukan adalah hasil resolve-nya, dan untuk berkas yang sudah
// ada, jalur nyatanya setelah symlink diikuti.
export async function resolveInsideRoot(root: string, relative: string): Promise<string> {
  const rootReal = await fs.realpath(root);
  const target = path.resolve(rootReal, relative);

  const contains = (base: string, p: string) => p === base || p.startsWith(base + path.sep);
  if (!contains(rootReal, target)) {
    throw new Error(`Path ${relative} is outside the working folder.`);
  }

  // Berkas baru belum punya realpath; yang diperiksa folder induknya.
  try {
    const real = await fs.realpath(target);
    if (!contains(rootReal, real)) throw new Error(`Path ${relative} points outside the working folder through a symlink.`);
    return real;
  } catch (err: any) {
    if (err?.code !== "ENOENT") throw err;
    const parentReal = await fs.realpath(path.dirname(target));
    if (!contains(rootReal, parentReal)) {
      throw new Error(`The destination folder for ${relative} is outside the working folder.`);
    }
    return path.join(parentReal, path.basename(target));
  }
}
