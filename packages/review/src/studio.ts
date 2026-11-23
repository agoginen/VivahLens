import { VivahError } from "@vivahlens/core";
import { ReviewSession, type ReviewDeps } from "./session.js";

/** What the person chose on the setup page. */
export interface StartRequest {
  /** The folder with the photos to edit. */
  input: string;
  /** Where edited photos are saved. Not needed for an editor route that only writes sidecar files. */
  output?: string;
  /** A folder of finished photos that show the look wanted. */
  profile: string;
  /** The AI model's provider and name; the offline demo needs no name. */
  provider?: string;
  model?: string;
}

export type StartField = "input" | "output" | "profile" | "provider" | "model";

/** What the setup page offers and starts with. */
export interface StudioSetup {
  defaults: Partial<StartRequest>;
  providers: { id: string; /** It needs a model name. */ needsModel: boolean; /** It runs here, so nothing is sent anywhere. */ local: boolean }[];
  /** False when the editor route only writes sidecar files, so an output folder would do nothing. */
  outputUsed: boolean;
  /** How many of the style photos are used to learn the look. */
  maxReferences: number;
}

export interface RunHooks {
  /** Aborts when the person presses Stop or the server closes. */
  signal: AbortSignal;
  progress(update: { stage: string; done: number; total: number }): void;
  /** One line of what is happening, for the details under the progress bar. */
  log(line: string): void;
}

/** Turns the three folders into photos ready for review. The command-line program supplies it. */
export interface StudioWorkflow {
  setup: StudioSetup;
  /** How many photos are directly inside a folder (0 when it cannot be read). */
  countPhotos(folder: string): Promise<number>;
  /** Refuses a request that cannot work, with a `FieldError` that names what to fix. Runs before anything starts. */
  validate(request: StartRequest): Promise<void>;
  /** Learns the style, edits the photos and opens the result. Resolves when the photos are ready to review. */
  start(request: StartRequest, hooks: RunHooks): Promise<ReviewDeps>;
}

/** A request refused because of one thing the person entered. */
export class FieldError extends Error {
  constructor(
    readonly field: StartField,
    message: string,
  ) {
    super(message);
    this.name = "FieldError";
  }
}

/** The request does not fit what the page is doing now (an edit is running, or no folders can be chosen here). */
export class StudioConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StudioConflict";
  }
}

export interface Failure {
  message: string;
  code?: string;
}

export interface Workspace {
  phase: "setup" | "running" | "review";
  /** Folders can be chosen and an edit started from this page. */
  canStart: boolean;
  setup?: StudioSetup;
  run?: { stage: string; done: number; total: number; startedAt: number; log: string[]; stopping: boolean };
  /** The last edit did not finish; shown on the setup page. */
  failure?: Failure;
  /** The last edit was stopped by the person. */
  stopped?: boolean;
}

interface ActiveRun {
  abort: AbortController;
  stage: string;
  done: number;
  total: number;
  startedAt: number;
  log: string[];
  stopping: boolean;
  settled: Promise<void>;
}

const LOG_LINES = 40;
const LOG_LINE_CHARS = 400;
const CLOSE_WAIT_MS = 5000;

const isAbort = (err: unknown): boolean => err instanceof Error && err.name === "AbortError";

/**
 * What the page is doing: choosing folders, editing, or reviewing. One edit runs at a time. The job being reviewed is replaced
 * when the person starts another shoot, and what the old one held is freed.
 */
export class Studio {
  private session: ReviewSession | undefined;
  private run: ActiveRun | undefined;
  private failure: Failure | undefined;
  private stopped = false;
  private last: StartRequest | undefined;

  constructor(
    private readonly workflow: StudioWorkflow | undefined,
    initial?: ReviewDeps,
  ) {
    if (initial) this.session = new ReviewSession(initial);
  }

  /** The job open for review, if there is one. */
  get current(): ReviewSession | undefined {
    return this.session;
  }

  get phase(): Workspace["phase"] {
    return this.run ? "running" : this.session ? "review" : "setup";
  }

  async countPhotos(folder: string): Promise<number> {
    return this.workflow ? this.workflow.countPhotos(folder).catch(() => 0) : 0;
  }

  snapshot(): Workspace {
    const run = this.run;
    return {
      phase: this.phase,
      canStart: this.workflow !== undefined,
      ...(this.workflow && { setup: { ...this.workflow.setup, defaults: { ...this.workflow.setup.defaults, ...this.last } } }),
      ...(run && { run: { stage: run.stage, done: run.done, total: run.total, startedAt: run.startedAt, log: [...run.log], stopping: run.stopping } }),
      ...(this.failure && { failure: this.failure }),
      ...(this.stopped && { stopped: true }),
    };
  }

  /** Checks the request, then starts editing in the background; it returns as soon as the work has begun. */
  async start(request: StartRequest): Promise<void> {
    if (!this.workflow) throw new StudioConflict("This page was opened on a finished job. Start VivahLens without a folder to choose one here.");
    if (this.run || this.session) throw new StudioConflict(this.run ? "An edit is already running." : "Photos are open for review. Start a new shoot first.");
    await this.workflow.validate(request);
    // Another request may have started while the folders were being checked.
    if (this.run || this.session) throw new StudioConflict("An edit is already running.");
    this.failure = undefined;
    this.stopped = false;
    this.last = request;
    const run: ActiveRun = { abort: new AbortController(), stage: "starting", done: 0, total: 0, startedAt: Date.now(), log: [], stopping: false, settled: Promise.resolve() };
    this.run = run;
    run.settled = this.execute(run, request, this.workflow);
  }

  private async execute(run: ActiveRun, request: StartRequest, workflow: StudioWorkflow): Promise<void> {
    try {
      const deps = await workflow.start(request, {
        signal: run.abort.signal,
        progress: (update) => {
          run.stage = update.stage;
          run.done = update.done;
          run.total = update.total;
        },
        log: (line) => {
          run.log.push(line.length > LOG_LINE_CHARS ? `${line.slice(0, LOG_LINE_CHARS)}…` : line);
          if (run.log.length > LOG_LINES) run.log.shift();
        },
      });
      if (run.abort.signal.aborted) {
        await deps.dispose?.().catch(() => undefined);
        this.stopped = true;
        return;
      }
      this.session = new ReviewSession(deps);
    } catch (err) {
      if (run.abort.signal.aborted || isAbort(err)) this.stopped = true;
      else this.failure = { message: err instanceof Error ? err.message : String(err), ...(err instanceof VivahError && { code: err.code }) };
    } finally {
      this.run = undefined;
    }
  }

  /** Asks the running edit to stop. What it has finished is saved, so starting again carries on. */
  cancel(): boolean {
    if (!this.run) return false;
    this.run.stopping = true;
    this.run.abort.abort();
    return true;
  }

  /** Closes the job under review and goes back to choosing folders. */
  async reset(): Promise<void> {
    if (!this.workflow) throw new StudioConflict("This page was opened on a finished job, so there is nothing to start again.");
    if (this.run) throw new StudioConflict("Stop the running edit first.");
    const session = this.session;
    this.session = undefined;
    this.failure = undefined;
    this.stopped = false;
    await session?.dispose();
  }

  /** Stops a running edit and frees the open job. Waits a few seconds for the edit to wind down, no longer. */
  async close(): Promise<void> {
    const run = this.run;
    if (run) {
      run.stopping = true;
      run.abort.abort();
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([run.settled, new Promise<void>((resolve) => (timer = setTimeout(resolve, CLOSE_WAIT_MS)))]);
      clearTimeout(timer);
    }
    const session = this.session;
    this.session = undefined;
    await session?.dispose();
  }
}
