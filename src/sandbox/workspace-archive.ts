import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create, extract } from "tar";

export async function packWorkspace(workspacePath: string): Promise<Buffer> {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "nocode-pack-"));
  const archivePath = join(temporaryDirectory, "workspace.tar.gz");
  try {
    await create(
      {
        cwd: workspacePath,
        file: archivePath,
        gzip: true,
        portable: true,
      },
      ["."],
    );
    return await readFile(archivePath);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function replaceWorkspace(
  workspacePath: string,
  archive: Buffer,
): Promise<void> {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "nocode-unpack-"));
  const archivePath = join(temporaryDirectory, "workspace.tar.gz");
  try {
    await writeFile(archivePath, archive);
    await rm(workspacePath, { recursive: true, force: true });
    await mkdir(workspacePath, { recursive: true });
    await extract({
      cwd: workspacePath,
      file: archivePath,
      gzip: true,
      preservePaths: false,
      strict: true,
    });
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}