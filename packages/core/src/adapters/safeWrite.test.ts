import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { sha256Hex, throwIfCancelled, writeReplacing } from "./safeWrite.js";

const dir = mkdtempSync(path.join(tmpdir(), "vivah-safewrite-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const fresh = () => path.join(dir, `f${n++}.xmp`);

describe("writeReplacing", () => {
  it("creates a new file whose undo is deleting it, and leaves no temporary files behind", async () => {
    const file = fresh();
    const out = await writeReplacing(file, "hello");

    expect(readFileSync(file, "utf8")).toBe("hello");
    expect(out.replaced).toEqual({ target: file, writtenSha256: sha256Hex(Buffer.from("hello")) });
    expect(out.warning).toBeUndefined();
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("keeps a copy of what it replaces, a separate one for each replacement", async () => {
    const file = fresh();
    const backups = path.join(dir, "backups-a");
    writeFileSync(file, "original");

    const first = await writeReplacing(file, "second", { backupDir: backups });
    const second = await writeReplacing(file, "third", { backupDir: backups });

    expect(readFileSync(file, "utf8")).toBe("third");
    expect(readFileSync(first.replaced!.backup!, "utf8")).toBe("original");
    expect(readFileSync(second.replaced!.backup!, "utf8")).toBe("second");
    expect(second.replaced!.backup).not.toBe(first.replaced!.backup);
    expect(path.basename(first.replaced!.backup!)).toContain(path.basename(file));
  });

  it("will not report as undoable a replacement of an existing file it has no backup of, because undoing would delete the user's file", async () => {
    const file = fresh();
    writeFileSync(file, "the photographer's own edits");

    const out = await writeReplacing(file, "ours");

    expect(readFileSync(file, "utf8")).toBe("ours");
    expect(out.replaced).toBeUndefined();
    expect(out.warning).toMatch(/cannot be undone/);
  });

  it("lets the new content be built from the bytes that were there, read once", async () => {
    const file = fresh();
    writeFileSync(file, "keep me");
    let seen: string | undefined = "unset";

    await writeReplacing(file, (before) => {
      seen = before?.toString("utf8");
      return `${seen} + more`;
    }, { backupDir: path.join(dir, "backups-b") });
    expect(seen).toBe("keep me");
    expect(readFileSync(file, "utf8")).toBe("keep me + more");

    const none = fresh();
    await writeReplacing(none, (before) => (seen = before === undefined ? "nothing" : "something"));
    expect(seen).toBe("nothing");
  });

  it("fails with a clear error and leaves nothing behind when the file cannot be written", async () => {
    const file = path.join(dir, "no-such-folder", "x.xmp");
    await expect(writeReplacing(file, "x")).rejects.toMatchObject({ code: "ADAPTER_APPLY_FAILED", message: expect.stringContaining("x.xmp") });
    mkdirSync(path.join(dir, "no-such-folder"));
    expect(readdirSync(path.join(dir, "no-such-folder"))).toEqual([]);
  });

  it("keeps the original and leaves no temporary file when the replacement cannot be put in place", async () => {
    const asADirectory = path.join(dir, "is-a-folder");
    mkdirSync(asADirectory);
    await expect(writeReplacing(asADirectory, "x")).rejects.toMatchObject({ code: "ADAPTER_APPLY_FAILED" });
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});

describe("throwIfCancelled", () => {
  it("passes without a context or a live signal, and stops a cancelled job with its own code", () => {
    expect(() => throwIfCancelled()).not.toThrow();
    expect(() => throwIfCancelled({ jobId: "j", signal: new AbortController().signal })).not.toThrow();
    const controller = new AbortController();
    controller.abort();
    expect(() => throwIfCancelled({ signal: controller.signal })).toThrowError(expect.objectContaining({ code: "ADAPTER_CANCELLED" }));
  });
});
