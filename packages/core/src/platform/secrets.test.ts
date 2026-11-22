import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { forgetUserSid } from "./privateFile.js";
import { scriptedRunner, type RunOptions, type ScriptedStep } from "./runner.js";
import { createSecretStore, MacKeychainStore, MemorySecretStore, PrivateFileSecretStore, SecretServiceStore, SecretStoreError, WindowsDpapiStore, type SecretStore } from "./secrets.js";

const temps: string[] = [];
const temp = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "vivah-secrets-"));
  temps.push(dir);
  return dir;
};
afterAll(() => temps.forEach((d) => rmSync(d, { recursive: true, force: true })));

const SECRET = "rt_live_9f8e7d6c5b4a — pässword with ünïcode\nand a newline";
const text = (opts: RunOptions) => (typeof opts.stdin === "string" ? opts.stdin : Buffer.from(opts.stdin ?? []).toString("utf8"));
/** Nothing that was handed to a program as an argument may contain any part of the secret. */
const noSecretInArgs = (calls: { command: string; args: readonly string[] }[], secret = SECRET) => {
  for (const call of calls) for (const arg of [call.command, ...call.args]) expect(arg, `${call.command} ${arg}`).not.toContain(secret.split("\n")[0]!.slice(0, 12));
};

/** Behaviour every store must show, whatever is behind it. */
function storeContract(name: string, make: () => Promise<{ store: SecretStore; cleanup?: () => void }> | { store: SecretStore; cleanup?: () => void }, timeout = 10_000) {
  describe(`store contract: ${name}`, () => {
    it("keeps a secret of any content until it is replaced or deleted, and says so when there is none", async () => {
      const { store, cleanup } = await make();
      try {
        expect(await store.get("vivahlens", "token")).toBeUndefined();
        await store.set("vivahlens", "token", SECRET);
        expect(await store.get("vivahlens", "token")).toBe(SECRET);
        await store.set("vivahlens", "token", "");
        expect(await store.get("vivahlens", "token")).toBe("");
        await store.set("vivahlens", "token", "x".repeat(4000));
        expect(await store.get("vivahlens", "token")).toBe("x".repeat(4000));
        expect(await store.get("vivahlens", "other")).toBeUndefined();
        expect(await store.delete("vivahlens", "token")).toBe(true);
        expect(await store.delete("vivahlens", "token")).toBe(false);
        expect(await store.get("vivahlens", "token")).toBeUndefined();
      } finally {
        cleanup?.();
      }
    }, timeout);

    it("refuses names that could be used as a path or a command", async () => {
      const { store, cleanup } = await make();
      try {
        for (const bad of ["", "../x", "a b", "a;b", "a/b", "-rf", "x".repeat(65), "naïve", "a\nb"]) {
          await expect(store.get(bad, "ok"), JSON.stringify(bad)).rejects.toMatchObject({ kind: "invalid-name" });
          await expect(store.set("ok", bad, "s"), JSON.stringify(bad)).rejects.toMatchObject({ kind: "invalid-name" });
          await expect(store.delete(bad, "ok"), JSON.stringify(bad)).rejects.toMatchObject({ kind: "invalid-name" });
        }
      } finally {
        cleanup?.();
      }
    });
  });
}

storeContract("memory", () => ({ store: new MemorySecretStore() }));
storeContract("private file", () => {
  const dir = path.join(temp(), "secrets");
  return { store: new PrivateFileSecretStore({ dir }) };
}, 30_000);

describe("Windows DPAPI through PowerShell", () => {
  /** A stand-in for DPAPI: "protects" by reversing the bytes, tagged so we can tell the two directions apart. */
  function fakePowerShell(over: Partial<{ unprotect: { code: number; stderr: string }; protect: { code: number; stderr: string } }> = {}) {
    const step: ScriptedStep = {
      when: (command) => command.toLowerCase().endsWith("powershell.exe"),
      reply: (_c, args, opts) => {
        const script = Buffer.from(args[args.indexOf("-EncodedCommand") + 1]!, "base64").toString("utf16le");
        const unprotect = script.includes("::Unprotect(");
        const failure = unprotect ? over.unprotect : over.protect;
        if (failure) return { code: failure.code, stderr: failure.stderr };
        const input = Buffer.from(opts.stdin ?? []);
        return { stdout: unprotect ? Buffer.from([...input].reverse()) : Buffer.from([...input].reverse()) };
      },
    };
    return { ...scriptedRunner([step]), script: [step] };
  }

  it("encrypts on the way in and decrypts on the way out, with the secret only ever on standard input", async () => {
    forgetUserSid();
    const dir = path.join(temp(), "dpapi");
    const SID = "S-1-5-21-1-2-3-1001";
    const protectedFiles: ScriptedStep[] = [
      { when: (c) => c.toLowerCase().endsWith("whoami.exe"), reply: { stdout: Buffer.from(`"host\\user","${SID}"\r\n`) } },
      {
        when: (c) => c.toLowerCase().endsWith("icacls.exe"),
        reply: (_c, args) => {
          const at = args.indexOf("/save");
          if (at >= 0) writeFileSync(args[at + 1]!, Buffer.from(`f\r\nD:P(A;;FA;;;${SID})\r\n`, "utf16le"));
          return {};
        },
      },
    ];
    const powershell = fakePowerShell();
    const { run, calls } = scriptedRunner([...protectedFiles, ...powershell.script]);
    const store = new WindowsDpapiStore({ dir, run, platform: "win32", powershell: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" });
    await store.set("vivahlens", "refresh", SECRET);

    const ps = calls.find((c) => c.command.toLowerCase().endsWith("powershell.exe"))!;
    expect(ps.args.slice(0, 5)).toEqual(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand"]);
    expect(Buffer.from(ps.args[5]!, "base64").toString("utf16le")).toContain("[System.Security.Cryptography.ProtectedData]::Protect(");
    expect(ps.opts.env).toEqual({ VL_ENTROPY: "vivahlens:v1:vivahlens:refresh" });
    expect(Buffer.from(ps.opts.stdin as Uint8Array).toString("utf8")).toBe(`v1:${Buffer.from(SECRET).toString("base64")}`);
    noSecretInArgs(calls);
    expect(existsSync(path.join(dir, "vivahlens.refresh.dpapi"))).toBe(true);
    expect(await store.get("vivahlens", "refresh")).toBe(SECRET);
    noSecretInArgs(calls);
  });

  it("tells a damaged or foreign secret from a missing one, and an unusable PowerShell from both", async () => {
    const dir = temp();
    writeFileSync(path.join(dir, "vivahlens.refresh.dpapi"), "blob");
    const corrupt = new WindowsDpapiStore({ dir, run: fakePowerShell({ unprotect: { code: 1, stderr: 'Exception calling "Unprotect": The data is invalid.' } }).run });
    await expect(corrupt.get("vivahlens", "refresh")).rejects.toMatchObject({ kind: "corrupt" });
    const failing = new WindowsDpapiStore({ dir, run: fakePowerShell({ unprotect: { code: 1, stderr: "something else" } }).run });
    await expect(failing.get("vivahlens", "refresh")).rejects.toMatchObject({ kind: "failed" });
    const absent = new WindowsDpapiStore({ dir, run: fakePowerShell().run });
    expect(await absent.get("vivahlens", "nothing")).toBeUndefined();
    const notInstalled = new WindowsDpapiStore({ dir, run: scriptedRunner([{ when: () => true, reply: { code: null, startError: "spawn ENOENT" } }]).run });
    await expect(notInstalled.get("vivahlens", "refresh")).rejects.toMatchObject({ kind: "unavailable" });
    const stored = new WindowsDpapiStore({ dir, run: fakePowerShell().run });
    expect(await stored.delete("vivahlens", "refresh")).toBe(true);
    expect(existsSync(path.join(dir, "vivahlens.refresh.dpapi"))).toBe(false);
  });

  it.skipIf(process.platform !== "win32")("really protects with the current user's DPAPI key: round-trips, rejects another purpose, and leaves no plaintext on disk", async () => {
    forgetUserSid();
    const dir = path.join(temp(), "real");
    const store = new WindowsDpapiStore({ dir });
    await store.set("vivahlens-test", "account-one", SECRET);
    const blob = readFileSync(path.join(dir, "vivahlens-test.account-one.dpapi"));
    expect(blob.includes(Buffer.from("rt_live_9f8e7d6c5b4a"))).toBe(false);
    expect(blob.includes(Buffer.from(Buffer.from(SECRET).toString("base64")))).toBe(false);
    expect(await store.get("vivahlens-test", "account-one")).toBe(SECRET);

    // The same blob presented under another name is for another purpose: DPAPI refuses to open it.
    copyFileSync(path.join(dir, "vivahlens-test.account-one.dpapi"), path.join(dir, "vivahlens-test.account-two.dpapi"));
    await expect(store.get("vivahlens-test", "account-two")).rejects.toMatchObject({ kind: "corrupt" });

    writeFileSync(path.join(dir, "vivahlens-test.account-three.dpapi"), blob.subarray(0, blob.length - 3));
    await expect(store.get("vivahlens-test", "account-three")).rejects.toBeInstanceOf(SecretStoreError);
    expect(await store.delete("vivahlens-test", "account-one")).toBe(true);
  }, 60_000);
});

describe("macOS keychain through security -i", () => {
  const hexOf = (secret: string) => Buffer.from(`v1:${Buffer.from(secret).toString("base64")}`).toString("hex");

  it("stores with the secret as hex on standard input and nothing in the arguments", async () => {
    const { run, calls } = scriptedRunner([{ when: () => true, reply: {} }]);
    await new MacKeychainStore({ run }).set("vivahlens", "refresh", SECRET);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe("/usr/bin/security");
    expect(calls[0]!.args).toEqual(["-i"]);
    expect(text(calls[0]!.opts)).toBe(`add-generic-password -U -a refresh -s vivahlens -l vivahlens -X ${hexOf(SECRET)}\n`);
    noSecretInArgs(calls);
    expect(text(calls[0]!.opts)).not.toContain("rt_live");
  });

  it("reads and decodes, maps the not-found status to undefined, and tells a refusal and a missing tool apart", async () => {
    const reply = (code: number, stdout = "", extra: object = {}) => scriptedRunner([{ when: () => true, reply: { code, stdout: Buffer.from(stdout), ...extra } }]);
    const value = await new MacKeychainStore({ run: reply(0, `v1:${Buffer.from(SECRET).toString("base64")}\n`).run }).get("vivahlens", "refresh");
    expect(value).toBe(SECRET);
    expect(await new MacKeychainStore({ run: reply(44).run }).get("vivahlens", "refresh")).toBeUndefined();
    await expect(new MacKeychainStore({ run: reply(51).run }).get("vivahlens", "refresh")).rejects.toMatchObject({ kind: "failed" });
    await expect(new MacKeychainStore({ run: reply(0, "not-our-format\n").run }).get("vivahlens", "refresh")).rejects.toMatchObject({ kind: "corrupt" });
    await expect(new MacKeychainStore({ run: reply(0, "", { code: null, startError: "spawn ENOENT" }).run }).get("vivahlens", "refresh")).rejects.toMatchObject({ kind: "unavailable" });
    await expect(new MacKeychainStore({ run: reply(1, "").run }).set("vivahlens", "refresh", "x")).rejects.toMatchObject({ kind: "failed" });
  });

  it("deletes and reports whether anything was there", async () => {
    expect(await new MacKeychainStore({ run: scriptedRunner([{ when: () => true, reply: { code: 0 } }]).run }).delete("vivahlens", "refresh")).toBe(true);
    expect(await new MacKeychainStore({ run: scriptedRunner([{ when: () => true, reply: { code: 44 } }]).run }).delete("vivahlens", "refresh")).toBe(false);
  });
});

describe("Linux Secret Service through secret-tool", () => {
  it("stores with the secret on standard input, without a trailing newline, and only plain attributes as arguments", async () => {
    const { run, calls } = scriptedRunner([{ when: () => true, reply: {} }]);
    await new SecretServiceStore({ run }).set("vivahlens", "refresh", SECRET);
    expect(calls[0]!.args).toEqual(["store", "--label", "VivahLens vivahlens/refresh", "service", "vivahlens", "account", "refresh"]);
    expect(text(calls[0]!.opts)).toBe(`v1:${Buffer.from(SECRET).toString("base64")}`);
    expect(text(calls[0]!.opts).endsWith("\n")).toBe(false);
    noSecretInArgs(calls);
  });

  it("treats a silent exit 1 as nothing stored, and any message, timeout or missing tool as no keyring", async () => {
    const answer = (reply: object) => new SecretServiceStore({ run: scriptedRunner([{ when: () => true, reply }]).run });
    expect(await answer({ code: 1, stderr: "" }).get("vivahlens", "refresh")).toBeUndefined();
    expect(await answer({ code: 0, stdout: Buffer.from(`v1:${Buffer.from("hi").toString("base64")}`) }).get("vivahlens", "refresh")).toBe("hi");
    await expect(answer({ code: 1, stderr: "secret-tool: Cannot autolaunch D-Bus without X11 $DISPLAY" }).get("vivahlens", "refresh")).rejects.toMatchObject({ kind: "unavailable", message: expect.stringContaining("D-Bus") });
    await expect(answer({ code: null, timedOut: true }).get("vivahlens", "refresh")).rejects.toMatchObject({ kind: "unavailable" });
    await expect(answer({ code: null, startError: "spawn secret-tool ENOENT" }).get("vivahlens", "refresh")).rejects.toMatchObject({ kind: "unavailable" });
    await expect(answer({ code: 1, stderr: "" }).set("vivahlens", "refresh", "x")).rejects.toMatchObject({ kind: "failed" });
  });

  it("deletes with clear and reports whether something was there, and probes for a Secret Service without leaving anything", async () => {
    const { run, calls } = scriptedRunner([
      { when: (_c, a) => a[0] === "lookup", reply: { code: 0, stdout: Buffer.from(`v1:${Buffer.from("x").toString("base64")}`) } },
      { when: (_c, a) => a[0] === "clear", reply: { code: 0 } },
    ]);
    expect(await new SecretServiceStore({ run }).delete("vivahlens", "refresh")).toBe(true);
    expect(calls.map((c) => c.args[0])).toEqual(["lookup", "clear"]);

    expect(await new SecretServiceStore({ run: scriptedRunner([{ when: () => true, reply: { code: 1, stderr: "" } }]).run }).probe()).toBe(true);
    expect(await new SecretServiceStore({ run: scriptedRunner([{ when: () => true, reply: { code: 1, stderr: "no daemon" } }]).run }).probe()).toBe(false);
    expect(await new SecretServiceStore({ run: scriptedRunner([{ when: () => true, reply: { code: null, startError: "ENOENT" } }]).run }).probe()).toBe(false);
  });
});

describe("choosing a store", () => {
  const dir = () => path.join(temp(), "s");

  it("uses the system's own store on Windows and macOS, and the Secret Service on Linux when there is one", async () => {
    expect((await createSecretStore({ platform: "win32", dir: dir() }))?.backend).toBe("windows-dpapi");
    expect((await createSecretStore({ platform: "darwin", dir: dir() }))?.backend).toBe("macos-keychain");
    const present = scriptedRunner([{ when: () => true, reply: { code: 1, stderr: "" } }]);
    expect((await createSecretStore({ platform: "linux", dir: dir(), run: present.run }))?.backend).toBe("secret-service");
  });

  it("keeps nothing at all on a Linux machine without a keyring, unless a private file was asked for", async () => {
    const none = scriptedRunner([{ when: () => true, reply: { code: 1, stderr: "secret-tool: no D-Bus" } }]);
    expect(await createSecretStore({ platform: "linux", dir: dir(), run: none.run })).toBeUndefined();
    expect((await createSecretStore({ platform: "linux", dir: dir(), run: none.run, allowFileFallback: true }))?.backend).toBe("private-file");
    const missing = scriptedRunner([{ when: () => true, reply: { code: null, startError: "ENOENT" } }]);
    expect(await createSecretStore({ platform: "linux", dir: dir(), run: missing.run })).toBeUndefined();
  });
});
