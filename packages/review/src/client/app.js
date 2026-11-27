// @ts-check
import { $, h } from "./dom.js";
import { FIELDS, formatValue, getValue, setValue } from "./fields.js";
import { FILTERS, countByFilter, defaultFilter, filterItems } from "./filters.js";
import { createI18n, formatBytes, pickLocale } from "./i18n.js";
import { columnsFor, gridMove, settleFocus } from "./nav.js";
import { coverage, keepKnown, selectRange, toggle, toggleAll } from "./selection.js";
import { createSetup } from "./setup.js";

const token = /** @type {HTMLMetaElement} */ (document.querySelector('meta[name="vivah-token"]')).content;
const LANGUAGE_NAMES = { en: "English", hi: "हिन्दी" };
const CARD_MIN_WIDTH = 260;
const GRID_GAP = 12;
const RENDER_DELAY_MS = 220;
const POLL_MS = 700;
const STEPS = ["setup", "running", "review"];

/** @param {string} path @param {RequestInit} [init] */
const api = (path, init) => fetch(`${path}${path.includes("?") ? "&" : "?"}t=${encodeURIComponent(token)}`, init);
const postJson = (/** @type {string} */ path, /** @type {unknown} */ body, /** @type {AbortSignal} */ signal) =>
  api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), ...(signal && { signal }) });

/**
 * @typedef {{ id: string, state: string, edit?: string, recipe?: { adjustments: Record<string, any>, sourceStyleProfileId?: string }, unsupported: string[], warnings: string[],
 *   rejectReason?: string, restoredFrom?: string, errorMessage?: string, outlierFields: string[], seenBefore?: string, retouch?: boolean, retouchNote?: string, recipeSource?: string }} Item
 */

const state = {
  /** @type {"setup" | "running" | "review"} */ phase: "setup",
  /** @type {any} */ workspace: null,
  /** @type {Item[]} */ items: [],
  /** @type {any} */ meta: null,
  filter: "review",
  focus: 0,
  /** @type {Set<string>} */ approved: new Set(),
  /** @type {Set<string>} */ selected: new Set(),
  /** @type {string | undefined} */ anchor: undefined,
  /** @type {Map<string, any>} */ edited: new Map(),
  /** @type {string | null} */ open: null,
  rendering: false,
  /** @type {any} */ privacy: null,
  poll: 0,
};

/** @type {ReturnType<typeof createI18n>} */
let i18n;
/** @type {ReturnType<typeof createSetup>} */
let setup;
const t = (/** @type {string} */ key, /** @type {Record<string, unknown>} */ params) => i18n.t(key, params);

/** Speaks a message to screen readers without moving focus. Unless `quiet`, it also stays on the page as the latest status. */
function announce(/** @type {string} */ message, quiet = false) {
  const live = $("live");
  live.textContent = "";
  requestAnimationFrame(() => (live.textContent = message));
  if (!quiet) $("status").textContent = message;
}

const itemById = (/** @type {string} */ id) => state.items.find((i) => i.id === id);
const shown = () => filterItems(state.items, state.filter);
const shownIds = () => shown().map((i) => i.id);
const selectedShown = () => shown().filter((i) => state.selected.has(i.id));
const recipeFor = (/** @type {Item} */ item) => state.edited.get(item.id) ?? item.recipe;
const sizeText = (/** @type {number} */ bytes) => formatBytes(bytes, i18n.locale);

// ---------------------------------------------------------------- data

async function loadItems(keepFilter = true) {
  const res = await api("/api/items");
  if (!res.ok) throw new Error((await res.json()).error ?? res.statusText);
  const data = await res.json();
  state.meta = data;
  state.items = data.items;
  if (!keepFilter || !FILTERS.some((f) => f.id === state.filter)) state.filter = defaultFilter(state.items);
  state.focus = settleFocus(state.focus, shown().length);
}

async function loadPrivacy() {
  try {
    const res = await api("/api/privacy");
    state.privacy = res.ok ? await res.json() : null;
  } catch {
    state.privacy = null;
  }
}

// ---------------------------------------------------------------- the three screens

/** Shows the screen for the phase the server is in, and starts or stops watching an edit that is running. */
async function applyWorkspace(/** @type {any} */ workspace, initial = false) {
  const before = state.phase;
  state.workspace = workspace;
  state.phase = workspace.phase;
  clearTimeout(state.poll);
  $("setup").hidden = workspace.phase !== "setup";
  $("progress").hidden = workspace.phase !== "running";
  $("review").hidden = workspace.phase !== "review";
  const changed = before !== workspace.phase && !initial;

  if (workspace.phase === "review") {
    if (before !== "review" || initial) await openReview(changed);
    else renderAll();
    return;
  }
  renderHeader();
  if (workspace.phase === "setup") setup.showSetup(workspace);
  else {
    setup.showProgress(workspace);
    state.poll = window.setTimeout(poll, POLL_MS);
  }
  if (changed) {
    setup.focusHeading();
    announce(t(`phase.${workspace.phase}`), true);
  }
}

async function openReview(focusHeading = false) {
  state.approved.clear();
  state.edited.clear();
  state.selected = new Set();
  state.anchor = undefined;
  state.focus = 0;
  $("status").textContent = t("app.loading");
  try {
    await Promise.all([loadItems(false), loadPrivacy()]);
    renderAll();
    const setAside = state.items.filter((i) => i.state === "rejected").length;
    $("status").textContent = setAside > 0 ? t("app.setAside", { count: setAside }) : "";
    if (focusHeading) {
      $("review-title").focus();
      announce(t("phase.review"), true);
    }
  } catch (error) {
    $("status").textContent = t("app.failed", { message: /** @type {Error} */ (error).message });
  }
}

async function poll() {
  try {
    const res = await api("/api/workspace");
    if (res.ok) return await applyWorkspace(await res.json());
  } catch {
    // The program may be starting up its next step; try again below.
  }
  $("status").textContent = t("app.lost");
  state.poll = window.setTimeout(poll, POLL_MS * 3);
}

async function refreshWorkspace() {
  try {
    const res = await api("/api/workspace");
    if (res.ok) await applyWorkspace(await res.json());
  } catch {
    $("status").textContent = t("app.lost");
  }
}

const hasPendingDecisions = () => state.approved.size > 0 || state.edited.size > 0;

function askNewShoot() {
  if (!hasPendingDecisions()) return void newShoot();
  const dialog = /** @type {HTMLDialogElement} */ (
    showDialog("confirm-dialog", t("newShoot.title"), [
      h("p", {}, t("newShoot.body")),
      h(
        "div",
        { class: "dialog-actions" },
        h("button", { type: "button", onclick: () => dialog.close() }, t("newShoot.keep")),
        h("button", { type: "button", class: "primary", onclick: () => (dialog.close(), void newShoot()) }, t("newShoot.confirm")),
      ),
    ])
  );
}

async function newShoot() {
  try {
    const res = await postJson("/api/reset", {});
    const body = await res.json();
    if (!res.ok) return announce(t("app.error", { message: body.error ?? res.statusText }));
    await applyWorkspace(body);
  } catch (error) {
    announce(t("app.error", { message: /** @type {Error} */ (error).message }));
  }
}

// ---------------------------------------------------------------- rendering

function renderSteps() {
  const current = STEPS.indexOf(state.phase);
  const nav = $("steps");
  nav.setAttribute("aria-label", t("step.nav"));
  nav.replaceChildren(
    h(
      "ol",
      {},
      STEPS.map((step, index) =>
        h(
          "li",
          { "data-state": index < current ? "done" : index === current ? "active" : "pending", "aria-current": index === current ? "step" : undefined },
          h("span", { class: "num", "aria-hidden": "true" }, index < current ? "✓" : index + 1),
          h("span", {}, t(`step.${step}`)),
        ),
      ),
    ),
  );
}

function renderHeader() {
  const review = state.phase === "review";
  document.documentElement.lang = i18n.locale;
  document.title = t(review ? "app.title" : state.phase === "running" ? "app.titleRunning" : "app.titleSetup");
  $("tagline").textContent = t("app.tagline");
  $("job").textContent = review && state.meta ? t("app.job", { job: state.meta.job, adapter: state.meta.adapter }) : "";
  $("skip").textContent = t(review ? "app.skip" : "app.skipForm");
  $("skip").setAttribute("href", review ? "#grid" : state.phase === "running" ? "#progress" : "#setup");
  $("lang-label").textContent = t("app.language");
  $("approve-all").textContent = t("action.approveAll");
  $("submit").textContent = t("action.submit");
  $("new-shoot").textContent = t("action.newShoot");
  $("help-button").textContent = "?";
  $("help-button").setAttribute("aria-label", t("action.help"));
  $("privacy-button").textContent = privacyLabel();
  $("filters").setAttribute("aria-label", t("filter.nav"));
  $("review-title").textContent = t("review.title");
  $("privacy-button").hidden = !review;
  $("new-shoot").hidden = !state.workspace?.canStart;
  renderSteps();
}

function privacyLabel() {
  const p = state.privacy;
  if (!p?.available) return t("privacy.local");
  const sent = p.job.totals;
  return sent.images > 0 ? t("privacy.sent", { images: sent.images, size: sizeText(sent.imageBytes) }) : t("privacy.local");
}

function renderFilters() {
  const counts = countByFilter(state.items);
  const nav = $("filters");
  nav.replaceChildren(
    ...FILTERS.map((f, index) =>
      h(
        "button",
        {
          type: "button",
          "data-filter": f.id,
          "aria-current": f.id === state.filter ? "true" : undefined,
          "aria-keyshortcuts": String(index + 1),
          onclick: () => setFilter(f.id),
        },
        t(`filter.${f.id}`),
        h("span", { class: "count" }, new Intl.NumberFormat(i18n.locale).format(counts[f.id] ?? 0)),
      ),
    ),
  );
}

function setFilter(/** @type {string} */ id) {
  state.filter = id;
  state.focus = 0;
  state.selected = new Set();
  state.anchor = undefined;
  renderAll();
  announce(t("status.filter", { label: t(`filter.${id}`), count: shown().length }));
}

function noteList(/** @type {Item} */ item) {
  const notes = [];
  if (item.state === "rejected" && item.rejectReason) notes.push(h("li", { class: "info" }, t("note.reason", { reason: reasonText(item.rejectReason) })));
  if (item.restoredFrom) notes.push(h("li", { class: "info" }, t("note.restored", { reason: reasonText(item.restoredFrom) })));
  if (item.unsupported?.length) notes.push(h("li", {}, t("note.unsupported", { fields: item.unsupported.join(", ") })));
  if (item.outlierFields?.length) notes.push(h("li", {}, t("note.outlier", { fields: item.outlierFields.join(", ") })));
  if (item.seenBefore) notes.push(h("li", {}, t("note.seenBefore", { job: item.seenBefore })));
  for (const warning of item.warnings ?? []) notes.push(h("li", {}, warning));
  if (item.errorMessage) notes.push(h("li", {}, item.errorMessage));
  if (item.retouch) notes.push(h("li", { class: "info" }, item.retouchNote ? t("note.retouch", { note: item.retouchNote }) : t("filter.retouch")));
  return notes.length ? h("ul", { class: "notes" }, notes) : null;
}

function reasonText(/** @type {string} */ code) {
  const key = `reason.${code}`;
  const text = t(key);
  return text === key ? code : text;
}

function stateText(/** @type {string} */ value) {
  const key = `state.${value}`;
  const text = t(key);
  return text === key ? value : text;
}

function card(/** @type {Item} */ item, /** @type {boolean} */ focused) {
  const tab = focused ? 0 : -1;
  const approvedNow = state.approved.has(item.id);
  const picked = state.selected.has(item.id);
  const actions = [];
  if (item.state === "review") {
    actions.push(
      h("button", { type: "button", class: "approve", tabindex: tab, "aria-pressed": String(approvedNow), "aria-keyshortcuts": "a", onclick: () => toggleApprove(item.id) }, approvedNow ? t("action.unapprove") : t("action.approve")),
    );
  }
  if (item.state === "rejected") {
    actions.push(h("button", { type: "button", class: "restore", tabindex: tab, "aria-keyshortcuts": "b", onclick: () => restore([item.id]) }, t("action.restore")));
  }
  actions.push(
    h("button", { type: "button", class: "retouch", tabindex: tab, "aria-pressed": String(item.retouch === true), "aria-keyshortcuts": "r", onclick: () => toggleRetouch(item.id) }, item.retouch ? t("action.unretouch") : t("action.retouch")),
  );
  const pick = h("input", { type: "checkbox", class: "pick-input", tabindex: tab, "aria-keyshortcuts": "x", "aria-label": t("select.photo", { name: item.id }), onclick: (/** @type {MouseEvent} */ event) => toggleSelect(item.id, event.shiftKey) });
  /** @type {HTMLInputElement} */ (pick).checked = picked;
  return h(
    "li",
    { class: `card${focused ? " focused" : ""}${picked ? " selected" : ""}`, "data-id": item.id, "data-state": item.state },
    h("label", { class: "pick" }, pick, h("span", { class: "box", "aria-hidden": "true" })),
    h(
      "button",
      { type: "button", class: "thumb", tabindex: tab, "aria-label": t("action.open", { name: item.id }), onclick: () => openDetail(item.id) },
      // The photo with its edit drawn on, when the server can draw it; the address changes when the edit does.
      h("img", { src: item.edit ? `/api/edited/${encodeURIComponent(item.id)}?t=${encodeURIComponent(token)}&v=${encodeURIComponent(item.edit)}` : `/api/preview/${encodeURIComponent(item.id)}?t=${encodeURIComponent(token)}`, alt: "", loading: "lazy", decoding: "async" }),
    ),
    h("div", { class: "meta" }, h("span", { class: "name" }, item.id), h("span", { class: `badge s-${item.state}` }, stateText(item.state))),
    noteList(item),
    h("div", { class: "actions" }, actions),
  );
}

function renderGrid() {
  const list = shown();
  const grid = $("grid");
  if (list.length === 0) {
    grid.replaceChildren();
    $("empty").hidden = false;
    $("empty").textContent = t("app.empty");
    return;
  }
  $("empty").hidden = true;
  state.focus = settleFocus(state.focus, list.length);
  grid.replaceChildren(...list.map((item, index) => card(item, index === state.focus)));
}

/** "Select all", how many are ticked, and what can be done with them. */
function renderToolbar() {
  const ids = shownIds();
  const chosen = selectedShown();
  const mode = coverage(state.selected, ids);
  const all = h("input", { type: "checkbox", id: "select-all", disabled: ids.length === 0, "aria-keyshortcuts": "Control+A", onchange: toggleSelectAll });
  /** @type {HTMLInputElement} */ (all).checked = mode === "all";
  /** @type {HTMLInputElement} */ (all).indeterminate = mode === "some";
  const canApprove = chosen.some((i) => i.state === "review" && !state.approved.has(i.id));
  const canFlag = chosen.some((i) => !i.retouch);
  const canUnflag = chosen.some((i) => i.retouch);
  const toolbar = $("toolbar");
  toolbar.setAttribute("aria-label", t("select.toolbar"));
  toolbar.replaceChildren(
    h("label", { class: "select-all" }, all, h("span", {}, t("select.all"))),
    h("span", { class: "selected-count" }, chosen.length ? t("select.count", { count: chosen.length }) : t("select.hint")),
    h(
      "div",
      { class: "bulk-actions" },
      h("button", { type: "button", id: "bulk-approve", class: "approve", disabled: !canApprove, onclick: approveSelected }, t("select.approve")),
      h("button", { type: "button", id: "bulk-flag", class: "retouch", disabled: !canFlag, onclick: () => flagSelected(true) }, t("select.flag")),
      h("button", { type: "button", id: "bulk-unflag", disabled: !canUnflag, onclick: () => flagSelected(false) }, t("select.unflag")),
      h("button", { type: "button", id: "bulk-clear", disabled: chosen.length === 0, onclick: clearSelection }, t("select.clear")),
    ),
  );
}

function renderAll() {
  state.selected = keepKnown(state.selected, shownIds());
  renderHeader();
  renderBanner();
  renderFilters();
  renderToolbar();
  renderGrid();
  const waiting = state.items.filter((i) => i.state === "review").length;
  $("summary").textContent = `${t("app.awaiting", { count: waiting })} · ${t("app.shown", { count: shown().length })}`;
}

/** Why editing is paused, in the reviewer's language; undefined while editing works. */
function pausedText() {
  const editing = state.meta?.editing;
  return editing?.allowed === false ? t(`editing.paused.${editing.reason}`) : undefined;
}

function renderBanner() {
  const text = pausedText();
  $("banner").hidden = text === undefined;
  $("banner").textContent = text ?? "";
}

function focusCard(/** @type {number} */ index) {
  state.focus = index;
  renderGrid();
  const target = $("grid").children[index]?.querySelector(".thumb");
  /** @type {HTMLElement | null} */ (target)?.focus();
  target?.scrollIntoView({ block: "nearest" });
}

// ---------------------------------------------------------------- actions

function toggleApprove(/** @type {string} */ id) {
  const item = itemById(id);
  if (!item || item.state !== "review") return;
  if (state.approved.has(id)) state.approved.delete(id);
  else state.approved.add(id);
  announce(t(state.approved.has(id) ? "status.approved" : "status.unapproved", { name: id }));
  rerenderKeepingFocus();
}

function approveAllShown() {
  const ids = shown().filter((i) => i.state === "review").map((i) => i.id);
  for (const id of ids) state.approved.add(id);
  announce(t("status.approvedAll", { count: ids.length }));
  rerenderKeepingFocus();
}

function toggleSelect(/** @type {string} */ id, shift = false) {
  state.selected = shift ? selectRange(state.selected, shownIds(), state.anchor, id) : toggle(state.selected, id);
  state.anchor = id;
  const index = shown().findIndex((i) => i.id === id);
  if (index >= 0) state.focus = index;
  announce(t("select.count", { count: selectedShown().length }));
  rerenderKeepingFocus();
}

function toggleSelectAll() {
  state.selected = toggleAll(state.selected, shownIds());
  state.anchor = undefined;
  announce(selectedShown().length ? t("select.count", { count: selectedShown().length }) : t("status.selectionCleared"));
  rerenderKeepingFocus();
}

function clearSelection() {
  if (state.selected.size === 0) return;
  state.selected = new Set();
  state.anchor = undefined;
  announce(t("status.selectionCleared"));
  rerenderKeepingFocus();
}

function approveSelected() {
  const ids = selectedShown().filter((i) => i.state === "review" && !state.approved.has(i.id)).map((i) => i.id);
  for (const id of ids) state.approved.add(id);
  announce(t("status.approvedAll", { count: ids.length }));
  rerenderKeepingFocus();
}

/** Flags (or unflags) every ticked photo that is not already so; a photo already flagged keeps its note. */
async function flagSelected(/** @type {boolean} */ on) {
  const ids = selectedShown().filter((i) => (i.retouch === true) !== on).map((i) => i.id);
  if (ids.length === 0) return;
  try {
    const res = await postJson("/api/retouch", { ids, on });
    const body = await res.json();
    if (!res.ok) return announce(t("app.error", { message: body.error ?? res.statusText }));
    for (const id of body.done) {
      const item = itemById(id);
      if (!item) continue;
      item.retouch = on;
      if (!on) delete item.retouchNote;
    }
    announce(t(on ? "status.flaggedMany" : "status.unflaggedMany", { count: body.done.length }));
  } catch (error) {
    announce(t("app.error", { message: /** @type {Error} */ (error).message }));
  }
  rerenderKeepingFocus();
}

async function toggleRetouch(/** @type {string} */ id, /** @type {string | undefined} */ note) {
  const item = itemById(id);
  if (!item) return;
  const on = note === undefined ? !item.retouch : true;
  const res = await postJson("/api/retouch", { ids: [id], on, ...(note !== undefined && { note }) });
  if (!res.ok) return announce(t("app.error", { message: (await res.json()).error ?? res.statusText }));
  item.retouch = on;
  if (on) item.retouchNote = note ?? item.retouchNote;
  else delete item.retouchNote;
  announce(t(on ? "status.retouchOn" : "status.retouchOff", { name: id }));
  rerenderKeepingFocus();
}

async function restore(/** @type {string[]} */ ids) {
  const res = await postJson("/api/restore", { ids });
  const body = await res.json();
  if (!res.ok) return announce(t("app.error", { message: body.error ?? res.statusText }));
  await loadItems();
  renderAll();
  announce(t("status.restored", { count: body.done.length }));
}

async function submit() {
  announce(t("status.submitting"));
  const overrides = Object.fromEntries([...state.edited].filter(([id]) => state.approved.has(id)));
  const res = await postJson("/api/decide", { approve: [...state.approved], overrides });
  const body = await res.json();
  if (!res.ok) return announce(t("app.error", { message: body.error ?? res.statusText }));
  state.approved.clear();
  state.edited.clear();
  await Promise.all([loadItems(), loadPrivacy()]);
  renderAll();
  const done = t("app.done", { exported: body.exported, approved: body.approved, failed: body.failed });
  announce(body.exported > 0 && state.meta?.exportDir ? `${done} ${t("app.savedTo", { folder: state.meta.exportDir })}` : done);
}

/** Redraws the page after a change and puts the keyboard back where it was, on the same photo's checkbox, button or toolbar control. */
function rerenderKeepingFocus() {
  const active = document.activeElement;
  const inToolbar = active instanceof HTMLElement && $("toolbar").contains(active) ? active.id : "";
  const onCard = active instanceof HTMLElement && active.classList.contains("pick-input") ? active.closest("li")?.getAttribute("data-id") : undefined;
  const hadFocusInGrid = $("grid").contains(active);
  renderAll();
  if (state.open) refreshDetailButtons();
  if (inToolbar) {
    const again = document.getElementById(inToolbar);
    /** @type {HTMLElement | null} */ (again instanceof HTMLButtonElement && again.disabled ? document.getElementById("select-all") : again)?.focus();
  } else if (onCard) {
    /** @type {HTMLElement | null} */ ($("grid").querySelector(`li[data-id="${CSS.escape(onCard)}"] .pick-input`))?.focus();
  } else if (hadFocusInGrid) /** @type {HTMLElement | null} */ ($("grid").children[state.focus]?.querySelector(".thumb"))?.focus();
}

// ---------------------------------------------------------------- detail view

/** @type {HTMLDialogElement} */
let detail;
let renderTimer = 0;
/** @type {AbortController | undefined} */
let renderAbort;
let afterUrl = "";

function openDetail(/** @type {string} */ id) {
  const index = shown().findIndex((i) => i.id === id);
  if (index >= 0) state.focus = index;
  state.open = id;
  buildDetail();
  if (!detail.open) detail.showModal();
  announce(t("status.opened", { name: id }));
}

function closeDetail() {
  if (detail.open) detail.close();
}

function stepDetail(/** @type {number} */ by) {
  const list = shown();
  const next = list[state.focus + by];
  if (!next) return;
  state.focus += by;
  state.open = next.id;
  buildDetail();
  renderGrid();
}

function refreshDetailButtons() {
  const item = state.open ? itemById(state.open) : undefined;
  if (!item) return;
  const approve = detail.querySelector(".approve");
  if (approve) {
    approve.setAttribute("aria-pressed", String(state.approved.has(item.id)));
    approve.textContent = state.approved.has(item.id) ? t("action.unapprove") : t("action.approve");
  }
  const retouch = detail.querySelector(".retouch");
  if (retouch) {
    retouch.setAttribute("aria-pressed", String(item.retouch === true));
    retouch.textContent = item.retouch ? t("action.unretouch") : t("action.retouch");
  }
}

function buildDetail() {
  const item = state.open ? itemById(state.open) : undefined;
  if (!item) return;
  // Rebuilding removes the control that had focus; without this the keyboard would fall out of the dialog.
  const focusWasInside = detail.open && detail.contains(document.activeElement);
  const editable = item.state === "review" && item.recipe !== undefined && pausedText() === undefined;
  const preview = `/api/preview/${encodeURIComponent(item.id)}?t=${encodeURIComponent(token)}`;
  const before = h("img", { class: "before", src: preview, alt: t("view.photo", { name: item.id }) });
  const after = h("img", { class: "after", alt: "", "aria-hidden": "true" });
  const compare = h("div", { class: "compare" }, before, after);
  const splitValue = h("input", { type: "range", min: 0, max: 100, step: 1, value: 50, "aria-label": t("view.split"), id: "split", "aria-keyshortcuts": "c" });
  const applySplit = () => {
    after.style.clipPath = `inset(0 0 0 ${splitValue.value}%)`;
  };
  splitValue.addEventListener("input", applySplit);
  applySplit();

  const adjustments = recipeFor(item)?.adjustments ?? {};
  const sliders = h("div", { class: "sliders", role: "group", "aria-label": t("detail.sliders") });
  for (const field of FIELDS) {
    const current = getValue(adjustments, field);
    const value = current ?? field.fallback;
    const id = `f-${field.id}`;
    const out = h("output", { for: id }, current === undefined ? "–" : formatValue(value, field, i18n.locale));
    const input = h("input", { type: "range", id, min: field.min, max: field.max, step: field.step, value, disabled: !editable, "aria-valuetext": `${t(`field.${field.id}`)}: ${formatValue(value, field, i18n.locale)}` });
    input.addEventListener("input", () => {
      const next = Number(/** @type {HTMLInputElement} */ (input).value);
      const base = recipeFor(item);
      if (!base) return;
      const edited = { ...base, adjustments: setValue(base.adjustments, field, next) };
      state.edited.set(item.id, edited);
      out.textContent = formatValue(next, field, i18n.locale);
      input.setAttribute("aria-valuetext", `${t(`field.${field.id}`)}: ${formatValue(next, field, i18n.locale)}`);
      scheduleRender(item, after);
    });
    sliders.append(h("label", { for: id }, t(`field.${field.id}`)), out, input);
  }

  const note = h("div", { class: "note-edit" });
  const noteInput = h("input", { type: "text", id: "retouch-note", maxlength: 500, value: item.retouchNote ?? "" });
  noteInput.addEventListener("change", () => {
    const text = /** @type {HTMLInputElement} */ (noteInput).value.trim();
    if (text) toggleRetouch(item.id, text);
  });
  note.append(h("label", { for: "retouch-note" }, t("detail.note")), noteInput);

  const side = h("div", {}, sliders, pausedText() ? h("p", { class: "info" }, pausedText()) : null, item.recipeSource ? h("p", { class: "info" }, t("detail.proposal", { source: sourceText(item.recipeSource) })) : null, note);
  const buttons = [
    h("button", { type: "button", onclick: () => stepDetail(-1), "aria-keyshortcuts": "ArrowLeft" }, t("action.previous")),
    h("button", { type: "button", onclick: () => stepDetail(1), "aria-keyshortcuts": "ArrowRight" }, t("action.next")),
  ];
  if (item.state === "review") buttons.push(h("button", { type: "button", class: "approve", "aria-pressed": String(state.approved.has(item.id)), "aria-keyshortcuts": "a", onclick: () => toggleApprove(item.id) }, state.approved.has(item.id) ? t("action.unapprove") : t("action.approve")));
  if (item.state === "rejected") buttons.push(h("button", { type: "button", "aria-keyshortcuts": "b", onclick: () => restore([item.id]) }, t("action.restore")));
  buttons.push(h("button", { type: "button", class: "retouch", "aria-pressed": String(item.retouch === true), "aria-keyshortcuts": "r", onclick: () => toggleRetouch(item.id) }, item.retouch ? t("action.unretouch") : t("action.retouch")));
  if (editable) {
    buttons.push(
      h("button", { type: "button", onclick: () => { state.edited.delete(item.id); buildDetail(); } }, t("action.reset")),
    );
  }

  detail.replaceChildren(
    h("div", { class: "head" }, h("h2", { id: "detail-title", tabindex: -1 }, t("detail.title", { name: item.id })), h("button", { type: "button", onclick: closeDetail }, t("action.close"))),
    h("div", { class: "body" }, h("div", {}, compare, h("div", { class: "compare-bar" }, h("span", {}, t("view.before")), splitValue, h("span", {}, t("view.after"))), state.meta?.rendering ? null : h("p", { class: "info" }, t("view.noRender"))), side),
    h("div", { class: "foot" }, buttons),
  );
  detail.setAttribute("aria-labelledby", "detail-title");
  if (focusWasInside) $("detail-title").focus();
  scheduleRender(item, after, 0);
}

const sourceText = (/** @type {string} */ source) => {
  const text = t(`source.${source}`);
  return text === `source.${source}` ? source : text;
};

/** Draws the edit onto the photo on the server (or approximates it in the browser when the server cannot), a moment after the last change. */
function scheduleRender(/** @type {Item} */ item, /** @type {HTMLImageElement} */ after, delay = RENDER_DELAY_MS) {
  clearTimeout(renderTimer);
  renderAbort?.abort();
  const recipe = recipeFor(item);
  if (!recipe) return;
  if (!state.meta?.rendering) {
    after.src = `/api/preview/${encodeURIComponent(item.id)}?t=${encodeURIComponent(token)}`;
    after.style.filter = approximateFilter(recipe.adjustments);
    return;
  }
  renderTimer = window.setTimeout(async () => {
    const controller = new AbortController();
    renderAbort = controller;
    announce(t("status.rendering"));
    try {
      const res = await postJson(`/api/render/${encodeURIComponent(item.id)}`, { recipe }, controller.signal);
      if (!res.ok) throw new Error((await res.json()).error ?? res.statusText);
      const url = URL.createObjectURL(await res.blob());
      if (afterUrl) URL.revokeObjectURL(afterUrl);
      afterUrl = url;
      after.src = url;
      $("status").textContent = "";
    } catch (error) {
      if (/** @type {Error} */ (error).name !== "AbortError") announce(t("status.renderFailed", { message: /** @type {Error} */ (error).message }));
    }
  }, delay);
}

function approximateFilter(/** @type {Record<string, any>} */ a) {
  return `brightness(${(2 ** (a.exposure ?? 0)).toFixed(3)}) contrast(${(1 + (a.contrast ?? 0) / 100).toFixed(2)}) saturate(${(1 + (a.saturation ?? 0) / 100).toFixed(2)})`;
}

// ---------------------------------------------------------------- dialogs

function showPrivacy() {
  const p = state.privacy;
  const body = [h("p", {}, t("privacy.promise"))];
  if (!p?.available) body.push(h("p", {}, t("privacy.unavailable")));
  else if (p.job.providers.length === 0) body.push(h("p", {}, t("privacy.none")));
  else {
    const list = h("ul", { class: "privacy-list" });
    for (const provider of p.job.providers) {
      list.append(h("li", {}, provider.local ? t("privacy.localProvider", { provider: provider.provider }) : t("privacy.provider", { provider: provider.provider, calls: provider.calls, images: provider.images, size: sizeText(provider.imageBytes) })));
      if (!provider.local && provider.fullResolutionCalls) list.append(h("li", {}, t("privacy.fullRes", { count: provider.fullResolutionCalls })));
      if (!provider.local && provider.maxEdgePx) list.append(h("li", {}, t("privacy.largest", { px: new Intl.NumberFormat(i18n.locale).format(provider.maxEdgePx) })));
    }
    body.push(list);
  }
  showDialog("privacy-dialog", t("privacy.title"), body);
}

function showHelp() {
  const rows = [
    ["←  →  ↑  ↓", "help.arrows"], ["Enter", "help.open"], ["Esc", "help.close"], ["A", "help.approve"], ["Shift + A", "help.approveAll"], ["R", "help.retouch"],
    ["X", "help.select"], ["Shift + click", "help.range"], ["Ctrl + A", "help.selectAll"], ["Esc", "help.clear"],
    ["B", "help.restore"], ["C", "help.compare"], ["←  →", "help.prev"], ["1 – 6", "help.filters"], ["?", "help.help"],
  ];
  const list = h("dl", { class: "keys" });
  for (const [keys, label] of rows) list.append(h("dt", {}, h("kbd", {}, keys)), h("dd", {}, t(label)));
  showDialog("help-dialog", t("help.title"), [list]);
}

/** A small modal window. The browser keeps focus inside it and closes it on Escape, and focus returns to where it came from. */
function showDialog(/** @type {string} */ id, /** @type {string} */ title, /** @type {any[]} */ content) {
  document.getElementById(id)?.remove();
  const dialog = /** @type {HTMLDialogElement} */ (
    h("dialog", { id, "aria-labelledby": `${id}-title` }, h("div", { class: "head" }, h("h2", { id: `${id}-title` }, title), h("button", { type: "button", onclick: () => dialog.close() }, t("action.close"))), h("div", { class: "dialog-pad" }, content))
  );
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  return dialog;
}

// ---------------------------------------------------------------- keyboard

function typing(/** @type {EventTarget | null} */ target) {
  const el = /** @type {HTMLElement | null} */ (target);
  return !!el && (el.tagName === "TEXTAREA" || el.tagName === "SELECT" || (el.tagName === "INPUT" && /** @type {HTMLInputElement} */ (el).type !== "range" && /** @type {HTMLInputElement} */ (el).type !== "checkbox"));
}

function onKey(/** @type {KeyboardEvent} */ event) {
  if (event.altKey) return;
  if (event.key === "Escape") {
    // Closes the topmost window ourselves: the browser's own handling does not reach a dialog when focus is on the page body.
    const dialogs = document.querySelectorAll("dialog[open]");
    const top = /** @type {HTMLDialogElement | undefined} */ (dialogs[dialogs.length - 1]);
    if (top) {
      event.preventDefault();
      top.close();
      return;
    }
    if (state.phase === "review" && state.selected.size > 0 && !typing(event.target)) {
      event.preventDefault();
      return clearSelection();
    }
  }
  if (typing(event.target)) return;
  const key = event.key;
  const open = detail.open;
  const modalOther = document.querySelector("dialog[open]:not(#detail)");
  if (modalOther) return; // native dialogs handle Escape and keep focus in

  if (key === "?") {
    event.preventDefault();
    return showHelp();
  }
  if (state.phase !== "review") return;
  if ((event.ctrlKey || event.metaKey) && key.toLowerCase() === "a" && !open) {
    event.preventDefault();
    return toggleSelectAll();
  }
  if (event.metaKey) return;
  const list = shown();
  const current = open ? state.open : list[state.focus]?.id;
  if (open) {
    const onSlider = /** @type {HTMLElement} */ (event.target).tagName === "INPUT";
    if ((key === "ArrowLeft" || key === "ArrowRight") && !onSlider) {
      event.preventDefault();
      return stepDetail(key === "ArrowRight" ? 1 : -1);
    }
    if (key.toLowerCase() === "c" && !event.ctrlKey) {
      event.preventDefault();
      const split = /** @type {HTMLInputElement} */ ($("split"));
      split.value = Number(split.value) >= 100 ? "0" : "100";
      split.dispatchEvent(new Event("input"));
      return;
    }
  } else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(key) && $("grid").contains(event.target instanceof Node ? event.target : null)) {
    event.preventDefault();
    const columns = columnsFor($("grid").clientWidth - 32, CARD_MIN_WIDTH, GRID_GAP);
    return focusCard(gridMove(state.focus, key, columns, list.length, { ctrl: event.ctrlKey }));
  } else if (key === "Enter" && current && $("grid").contains(event.target instanceof Node ? event.target : null) && /** @type {HTMLElement} */ (event.target).tagName !== "BUTTON") {
    event.preventDefault();
    return openDetail(current);
  }
  if (/^[1-6]$/.test(key) && !open) return setFilter(FILTERS[Number(key) - 1].id);
  if (!current) return;
  if (key === "A" && event.shiftKey) {
    event.preventDefault();
    return approveAllShown();
  }
  if (key.toLowerCase() === "a" && !event.ctrlKey) {
    event.preventDefault();
    return toggleApprove(current);
  }
  if (key.toLowerCase() === "r" && !event.ctrlKey) {
    event.preventDefault();
    return void toggleRetouch(current);
  }
  if (key.toLowerCase() === "x" && !event.ctrlKey && !open) {
    event.preventDefault();
    return toggleSelect(current);
  }
  if (key.toLowerCase() === "b" && !event.ctrlKey && itemById(current)?.state === "rejected") {
    event.preventDefault();
    return void restore([current]);
  }
}

// ---------------------------------------------------------------- start

async function start() {
  const catalogs = {};
  for (const lang of Object.keys(LANGUAGE_NAMES)) {
    const res = await fetch(`/assets/locales/${lang}.json`);
    /** @type {any} */ (catalogs)[lang] = await res.json();
  }
  const saved = localStorage.getItem("vivah-lang");
  i18n = createI18n({ locale: pickLocale(saved, navigator.languages ?? [navigator.language], Object.keys(catalogs)), catalogs });

  detail = /** @type {HTMLDialogElement} */ ($("detail"));
  detail.addEventListener("close", () => {
    state.open = null;
    renderAll();
    /** @type {HTMLElement | null} */ ($("grid").children[state.focus]?.querySelector(".thumb"))?.focus();
    announce(t("status.closed"));
  });

  setup = createSetup({
    t,
    get: (path) => api(path),
    post: (path, body) => postJson(path, body),
    announce,
    setupRoot: $("setup"),
    progressRoot: $("progress"),
    onWorkspace: (workspace) => void applyWorkspace(workspace),
    refresh: () => void refreshWorkspace(),
  });

  const select = /** @type {HTMLSelectElement} */ ($("lang"));
  select.replaceChildren(...Object.entries(LANGUAGE_NAMES).map(([code, name]) => h("option", { value: code, lang: code, selected: code === i18n.locale }, name)));
  select.addEventListener("change", () => {
    i18n.setLocale(select.value);
    localStorage.setItem("vivah-lang", select.value);
    $("status").textContent = "";
    if (state.phase === "review") renderAll();
    else {
      renderHeader();
      setup.relabel();
    }
    if (state.open) buildDetail();
  });

  $("approve-all").addEventListener("click", approveAllShown);
  $("submit").addEventListener("click", submit);
  $("new-shoot").addEventListener("click", askNewShoot);
  $("help-button").addEventListener("click", showHelp);
  $("privacy-button").addEventListener("click", showPrivacy);
  document.addEventListener("keydown", onKey);
  window.addEventListener("resize", () => state.phase === "review" && renderGrid());
  // The toolbar sticks under the header, which is taller when its controls wrap onto a second line.
  new ResizeObserver(() => document.documentElement.style.setProperty("--bar-height", `${document.querySelector("header.bar")?.getBoundingClientRect().height ?? 0}px`)).observe(/** @type {Element} */ (document.querySelector("header.bar")));

  $("status").textContent = t("app.loading");
  try {
    const res = await api("/api/workspace");
    if (!res.ok) throw new Error((await res.json()).error ?? res.statusText);
    $("status").textContent = "";
    await applyWorkspace(await res.json(), true);
  } catch (error) {
    $("status").textContent = t("app.failed", { message: /** @type {Error} */ (error).message });
  }
}

start();
