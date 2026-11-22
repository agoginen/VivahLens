import { promises as fs } from "node:fs";
import path from "node:path";
import { dataDir } from "./paths.js";

export interface Settings {
  telemetry?: { usage: boolean };
}

/** The few choices a person makes about how VivahLens behaves, kept in `settings.json` in the data folder. Nothing in it is secret. */
export class SettingsStore {
  constructor(readonly dir: string) {}

  static fromEnv(env: Record<string, string | undefined>): SettingsStore {
    return new SettingsStore(dataDir(env));
  }

  get file(): string {
    return path.join(this.dir, "settings.json");
  }

  /** What is saved. A missing, unreadable or hand-damaged file means defaults: nothing the settings guard is switched on by accident. */
  async read(): Promise<Settings> {
    try {
      const raw = JSON.parse(await fs.readFile(this.file, "utf8")) as { telemetry?: { usage?: unknown } };
      return raw.telemetry && typeof raw.telemetry.usage === "boolean" ? { telemetry: { usage: raw.telemetry.usage } } : {};
    } catch {
      return {};
    }
  }

  async update(patch: Settings): Promise<Settings> {
    const next: Settings = { ...(await this.read()), ...patch };
    await fs.mkdir(this.dir, { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(temp, JSON.stringify(next, null, 2), "utf8");
    await fs.rename(temp, this.file);
    return next;
  }

  /** Usage reporting is off unless the person turned it on. */
  async usageReporting(): Promise<boolean> {
    return (await this.read()).telemetry?.usage === true;
  }
}
