import { randomUUID } from "node:crypto";
import { link, open, unlink } from "node:fs/promises";
import path from "node:path";

async function syncDirectory(directory: string) {
  let handle;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!["EINVAL", "ENOTSUP", "EPERM", "EISDIR"].includes(code || "")) {
      throw error;
    }
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Durably installs immutable bytes without ever exposing a partial target.
 *
 * The temporary file is written and fsynced in the target directory. A hard
 * link then installs it atomically with no-replace semantics: concurrent
 * writers either create the target or observe EEXIST. Orphaned temp files from
 * a process crash never shadow the authoritative target and can be swept
 * independently.
 */
export async function installImmutableFileAtomically(input: {
  target: string;
  buffer: Buffer;
}): Promise<"installed" | "exists"> {
  const directory = path.dirname(input.target);
  const temporary = path.join(
    directory,
    `.${path.basename(input.target)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle;
  let installed = false;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(input.buffer);
    await handle.sync();
    await handle.close();
    handle = undefined;

    try {
      await link(temporary, input.target);
      installed = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    return installed ? "installed" : "exists";
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
    if (installed) await syncDirectory(directory);
  }
}
