// @ts-check
// The two screens before the photos: choosing the folders and starting, and watching the edit run.
import { h } from "./dom.js";
import { openFolderPicker, reasonText } from "./picker.js";

/**
 * @typedef {"input" | "output" | "profile"} FolderField
 * @typedef {{ state: "idle" | "checking" | "ok" | "warn" | "error", text?: () => string }} Check
 * @typedef {{ defaults: Record<string, string | undefined>, providers: { id: string, needsModel: boolean, local: boolean }[], outputUsed: boolean, maxReferences: number }} SetupInfo
 * @typedef {{ stage: string, done: number, total: number, log: string[], stopping: boolean }} RunInfo
 * @typedef {{ phase: string, setup?: SetupInfo, run?: RunInfo, failure?: { message: string, code?: string }, stopped?: boolean }} Workspace
 */

/** The steps of an edit, in order. "learning" is the style; the rest are the pipeline's own stages. */
export const STAGES = ["learning", "queued", "culled", "style-matched", "recipe-generated", "review"];
const FIELDS = /** @type {FolderField[]} */ (["input", "output", "profile"]);
const CHECK_DELAY_MS = 400;

/**
 * The folder above a path, the way a person would see it: `C:\Photos\Shoot` gives `C:\Photos`, and a folder at the top of a
 * drive gives the drive.
 * @param {string} folder
 */
export function parentOf(folder) {
  const trimmed = folder.replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  if (cut < 0) return folder;
  const head = trimmed.slice(0, cut);
  if (/^[A-Za-z]:$/.test(head)) return `${head}\\`;
  return head === "" ? "/" : head;
}

/**
 * Where the stage the edit is in sits in the list of steps, and how each step stands.
 * @param {string} stage
 * @returns {{ index: number, states: ("done" | "active" | "pending")[] }}
 */
export function stageStates(stage) {
  const index = STAGES.indexOf(stage);
  return { index, states: STAGES.map((_, i) => (index < 0 ? "pending" : i < index ? "done" : i === index ? "active" : "pending")) };
}

/**
 * @param {{
 *   t: (key: string, params?: Record<string, unknown>) => string,
 *   get: (path: string) => Promise<Response>,
 *   post: (path: string, body: unknown) => Promise<Response>,
 *   announce: (message: string, quiet?: boolean) => void,
 *   setupRoot: HTMLElement,
 *   progressRoot: HTMLElement,
 *   onWorkspace: (workspace: Workspace) => void,
 *   refresh: () => void,
 * }} deps
 */
export function createSetup(deps) {
  const { t, get, post, announce, setupRoot, progressRoot, onWorkspace, refresh } = deps;

  const form = { input: "", output: "", profile: "", provider: "mock", model: "" };
  /** @type {Record<FolderField, Check>} */
  const checks = { input: { state: "idle" }, output: { state: "idle" }, profile: { state: "idle" } };
  const sequence = { input: 0, output: 0, profile: 0 };
  /** @type {Record<string, number>} */
  const timers = {};
  /** @type {Workspace | undefined} */
  let latest;
  let seeded = false;
  let busy = false;
  let advancedOpen = false;
  let lastPicked = "";
  /** @type {{ build: () => void, update: (run: RunInfo) => void } | undefined} */
  let progressView;
  let lastStage = "";

  const info = () => /** @type {SetupInfo} */ (latest?.setup);
  const provider = () => info().providers.find((p) => p.id === form.provider);
  const needsModel = () => provider()?.needsModel === true;
  const outputUsed = () => info().outputUsed;
  const modelLabel = (/** @type {string} */ id) => {
    const key = `setup.model.${id}`;
    const text = t(key);
    return text === key ? id : text;
  };

  // ------------------------------------------------------------ checking what was typed

  /** @param {FolderField} field */
  async function runCheck(field) {
    const value = form[field].trim();
    const mine = ++sequence[field];
    if (!value) {
      checks[field] = { state: "idle" };
      paintCheck(field);
      return updateStart();
    }
    checks[field] = { state: "checking", text: () => t("setup.check.checking") };
    paintCheck(field);
    try {
      const res = await get(`/api/folder?path=${encodeURIComponent(value)}`);
      const body = await res.json();
      if (mine !== sequence[field]) return;
      checks[field] = interpret(field, body.ok === true, body);
    } catch {
      if (mine !== sequence[field]) return;
      checks[field] = { state: "error", text: () => t("picker.error.FAILED") };
    }
    paintCheck(field);
    updateStart();
  }

  /**
   * What the server said about a folder, as a message that is worded again whenever it is shown, so a change of language
   * reaches it.
   * @param {FolderField} field @param {boolean} ok @param {any} body @returns {Check}
   */
  function interpret(field, ok, body) {
    if (field === "output") {
      if (ok) return body.photos > 0 ? { state: "warn", text: () => t("setup.check.outputHasPhotos", { count: body.photos }) } : { state: "ok", text: () => t("setup.check.exists") };
      return body.code === "MISSING" ? { state: "ok", text: () => t("setup.check.willCreate") } : { state: "error", text: () => reasonText(t, body) };
    }
    if (!ok) return { state: "error", text: () => reasonText(t, body) };
    if (body.photos === 0) return { state: "error", text: () => t("setup.check.noPhotos") };
    return { state: "ok", text: () => (field === "profile" ? t("setup.check.styleCount", { count: body.photos, max: info().maxReferences }) : t("setup.check.photos", { count: body.photos })) };
  }

  /** @param {FolderField} field */
  function scheduleCheck(field) {
    clearTimeout(timers[field]);
    checks[field] = form[field].trim() ? { state: "checking", text: () => t("setup.check.checking") } : { state: "idle" };
    paintCheck(field);
    updateStart();
    timers[field] = window.setTimeout(() => runCheck(field), CHECK_DELAY_MS);
  }

  /** @param {FolderField} field */
  function paintCheck(field) {
    const el = setupRoot.querySelector(`#f-${field}-status`);
    if (!el) return;
    el.className = `check ${checks[field].state}`;
    el.textContent = checks[field].text?.() ?? "";
    setupRoot.querySelector(`#f-${field}`)?.setAttribute("aria-invalid", String(checks[field].state === "error"));
  }

  function canStart() {
    const usable = (/** @type {FolderField} */ f) => checks[f].state === "ok" || checks[f].state === "warn";
    if (busy || !usable("input") || !usable("profile")) return false;
    if (outputUsed() && (!form.output.trim() || !usable("output"))) return false;
    return !needsModel() || form.model.trim() !== "";
  }

  function updateStart() {
    const button = setupRoot.querySelector("#start");
    if (button instanceof HTMLButtonElement) {
      button.disabled = !canStart();
      button.textContent = busy ? t("setup.starting") : t("setup.start");
    }
    const hint = setupRoot.querySelector("#start-hint");
    if (hint) hint.textContent = canStart() || busy ? "" : t("setup.fixFields");
  }

  // ------------------------------------------------------------ choosing folders

  /** @param {FolderField} field */
  function choose(field) {
    openFolderPicker({
      t,
      get,
      post,
      title: t(`picker.title.${field}`),
      start: form[field].trim() || (lastPicked ? parentOf(lastPicked) : undefined),
      canCreate: field === "output",
      onPick: (folder) => {
        form[field] = folder;
        lastPicked = folder;
        const input = setupRoot.querySelector(`#f-${field}`);
        if (input instanceof HTMLInputElement) input.value = folder;
        runCheck(field);
        setupRoot.querySelector(`#f-${field}`)?.parentElement?.querySelector("button")?.focus();
      },
    });
  }

  // ------------------------------------------------------------ the setup screen

  /** @param {FolderField} field @param {number} number */
  function folderRow(field, number) {
    const id = `f-${field}`;
    const unused = field === "output" && !outputUsed();
    const input = h("input", {
      type: "text",
      id,
      value: form[field],
      placeholder: t("setup.path.placeholder"),
      autocomplete: "off",
      spellcheck: "false",
      disabled: unused,
      "aria-describedby": `${id}-help ${id}-status`,
      "aria-invalid": String(checks[field].state === "error"),
    });
    input.addEventListener("input", () => {
      form[field] = /** @type {HTMLInputElement} */ (input).value;
      scheduleCheck(field);
    });
    return h(
      "div",
      { class: `folder-row${unused ? " unused" : ""}` },
      h("span", { class: "step-number", "aria-hidden": "true" }, number),
      h(
        "div",
        { class: "folder-fields" },
        h("label", { for: id }, t(`setup.${field}.label`)),
        h("p", { class: "help", id: `${id}-help` }, unused ? t("setup.output.unused") : t(`setup.${field}.help`, { max: info().maxReferences })),
        h("div", { class: "path-row" }, input, h("button", { type: "button", disabled: unused, onclick: () => choose(field) }, t("setup.browse"))),
        h("p", { class: `check ${checks[field].state}`, id: `${id}-status`, "aria-live": "polite" }, checks[field].text?.() ?? ""),
      ),
    );
  }

  function advanced() {
    const select = h(
      "select",
      { id: "f-provider" },
      info().providers.map((p) => h("option", { value: p.id, selected: p.id === form.provider }, modelLabel(p.id))),
    );
    select.addEventListener("change", () => {
      form.provider = /** @type {HTMLSelectElement} */ (select).value;
      render("f-provider");
    });
    const model = h("input", { type: "text", id: "f-model", value: form.model, autocomplete: "off", spellcheck: "false", "aria-describedby": "f-model-help" });
    model.addEventListener("input", () => {
      form.model = /** @type {HTMLInputElement} */ (model).value;
      updateStart();
    });
    const chosen = provider();
    const details = h(
      "details",
      { class: "advanced", open: advancedOpen || (chosen !== undefined && !chosen.local) },
      h("summary", {}, t("setup.advanced")),
      h(
        "div",
        { class: "advanced-body" },
        h("label", { for: "f-provider" }, t("setup.model.label")),
        select,
        needsModel() ? h("label", { for: "f-model" }, t("setup.modelName.label")) : null,
        needsModel() ? model : null,
        needsModel() ? h("p", { class: "help", id: "f-model-help" }, t("setup.modelName.help")) : null,
        chosen && !chosen.local ? h("p", { class: "help" }, t("setup.model.cloudNote", { provider: modelLabel(chosen.id) })) : null,
      ),
    );
    details.addEventListener("toggle", () => (advancedOpen = /** @type {HTMLDetailsElement} */ (details).open));
    return details;
  }

  function notice() {
    const failure = latest?.failure;
    if (failure) return h("p", { class: "notice error", role: "alert" }, t("setup.failed", { message: failure.message }));
    if (latest?.stopped) return h("p", { class: "notice", role: "status" }, t("setup.stopped"));
    return null;
  }

  /** @param {string} [focus] id of the element to put the keyboard back on after the page is redrawn */
  function render(focus) {
    if (!latest?.setup) return;
    const start = h("button", { type: "button", class: "primary", id: "start", onclick: start_ }, t("setup.start"));
    setupRoot.replaceChildren(
      h(
        "div",
        { class: "panel" },
        h("h2", { id: "setup-title", tabindex: -1 }, t("setup.title")),
        h("p", { class: "lead" }, t("setup.intro")),
        notice(),
        FIELDS.map((field, i) => folderRow(field, i + 1)),
        advanced(),
        h("div", { class: "start-row" }, start, h("span", { class: "hint", id: "start-hint" })),
        provider()?.local && form.provider === "mock" ? h("p", { class: "note demo" }, t("setup.model.demoNote")) : null,
        h("p", { class: "fineprint" }, t("setup.privacy")),
      ),
    );
    for (const field of FIELDS) paintCheck(field);
    updateStart();
    if (focus) document.getElementById(focus)?.focus();
  }

  async function start_() {
    if (!canStart()) return;
    busy = true;
    updateStart();
    const body = {
      input: form.input.trim(),
      profile: form.profile.trim(),
      provider: form.provider,
      ...(outputUsed() && { output: form.output.trim() }),
      ...(needsModel() && { model: form.model.trim() }),
    };
    try {
      const res = await post("/api/start", body);
      const data = await res.json();
      busy = false;
      if (res.status === 202) return onWorkspace(data);
      if (res.status === 400 && FIELDS.includes(data.field)) {
        checks[/** @type {FolderField} */ (data.field)] = { state: "error", text: () => data.error };
        paintCheck(data.field);
        document.getElementById(`f-${data.field}`)?.focus();
      } else if (res.status === 400 && (data.field === "model" || data.field === "provider")) {
        advancedOpen = true;
        announce(t("app.error", { message: data.error }));
        render("f-model");
      } else {
        announce(t("app.error", { message: data.error }));
        if (res.status === 409) refresh();
      }
    } catch (error) {
      busy = false;
      announce(t("app.error", { message: /** @type {Error} */ (error).message }));
    }
    updateStart();
  }

  // ------------------------------------------------------------ the progress screen

  const stageText = (/** @type {string} */ stage) => t(`progress.stage.${stage}`);

  function buildProgress() {
    const items = STAGES.map((stage) => h("li", { "data-stage": stage, "data-state": "pending" }, h("span", { class: "marker", "aria-hidden": "true" }), stageText(stage)));
    const meter = h("progress", { max: 100, "aria-label": t("progress.title") });
    const count = h("span", { class: "count-text" });
    const stop = h("button", { type: "button", onclick: stopEdit }, t("progress.cancel"));
    const log = h("pre", { class: "run-log" });
    progressRoot.replaceChildren(
      h(
        "div",
        { class: "panel" },
        h("h2", { id: "progress-title", tabindex: -1 }, t("progress.title")),
        h("p", { class: "lead" }, t("progress.intro")),
        h("ol", { class: "stages" }, items),
        h("div", { class: "meter" }, meter, count),
        h("div", { class: "run-actions" }, stop),
        h("details", { class: "details" }, h("summary", {}, t("progress.details")), log),
      ),
    );
    progressView = {
      build: buildProgress,
      update(run) {
        const { index, states } = stageStates(run.stage);
        items.forEach((item, i) => {
          item.setAttribute("data-state", /** @type {string} */ (states[i]));
          if (states[i] === "active") item.setAttribute("aria-current", "step");
          else item.removeAttribute("aria-current");
        });
        if (run.total > 0 && index >= 0) {
          /** @type {HTMLProgressElement} */ (meter).value = Math.round((run.done / run.total) * 100);
          count.textContent = t("progress.count", { done: run.done, total: run.total });
        } else {
          meter.removeAttribute("value");
          count.textContent = run.stage === "starting" ? t("progress.stage.starting") : "";
        }
        /** @type {HTMLButtonElement} */ (stop).disabled = run.stopping;
        stop.textContent = run.stopping ? t("progress.stopping") : t("progress.cancel");
        log.textContent = run.log.join("\n");
        if (run.stage !== lastStage) {
          lastStage = run.stage;
          if (index >= 0) announce(t("progress.step", { step: index + 1, total: STAGES.length, stage: stageText(run.stage) }), true);
        }
      },
    };
  }

  async function stopEdit() {
    try {
      const res = await post("/api/cancel", {});
      if (res.ok) onWorkspace(await res.json());
    } catch {
      refresh();
    }
  }

  return {
    /** @param {Workspace} workspace */
    showSetup(workspace) {
      latest = workspace;
      progressView = undefined;
      lastStage = "";
      if (!seeded && workspace.setup) {
        seeded = true;
        const d = workspace.setup.defaults;
        form.input = d.input ?? "";
        form.output = d.output ?? "";
        form.profile = d.profile ?? "";
        form.provider = d.provider ?? workspace.setup.providers[0]?.id ?? "mock";
        form.model = d.model ?? "";
        render();
        for (const field of FIELDS) if (form[field]) runCheck(field);
        return;
      }
      render();
    },
    /** @param {Workspace} workspace */
    showProgress(workspace) {
      latest = workspace;
      if (!progressView) buildProgress();
      if (workspace.run) progressView?.update(workspace.run);
    },
    /** Redraws what is showing, after the language changed. */
    relabel() {
      if (!latest) return;
      if (latest.phase === "setup") render();
      else if (latest.phase === "running" && progressView) {
        buildProgress();
        if (latest.run) progressView?.update(latest.run);
      }
    },
    /** Moves the keyboard to the heading of what is showing, so a screen reader starts reading there. */
    focusHeading() {
      const heading = (latest?.phase === "running" ? progressRoot : setupRoot).querySelector("h2");
      if (heading instanceof HTMLElement) heading.focus();
    },
  };
}
