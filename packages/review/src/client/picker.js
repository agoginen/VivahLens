// @ts-check
// A folder chooser. A web page cannot open the system's folder window and learn the full path from it, so the server lists
// the folders (names only) and this walks through them.
import { h } from "./dom.js";

/**
 * @typedef {{ name: string, path: string }} Folder
 * @typedef {Folder & { kind: string }} Place
 * @typedef {{ path: string, parent: string | null, folders: Folder[], truncated: boolean, photos: number }} Listing
 * @typedef {{
 *   t: (key: string, params?: Record<string, unknown>) => string,
 *   get: (path: string) => Promise<Response>,
 *   post: (path: string, body: unknown) => Promise<Response>,
 *   title: string,
 *   start: string | undefined,
 *   canCreate: boolean,
 *   onPick: (folder: string) => void,
 * }} PickerOptions
 */

const PLACE_KINDS = ["home", "desktop", "documents", "downloads", "pictures", "onedrive"];

/**
 * Why a folder request failed, in the person's language when there are words for the server's code, else in the server's own.
 * @param {(key: string) => string} t
 * @param {{ code?: string, error?: string }} body
 */
export function reasonText(t, body) {
  const key = `picker.error.${body.code}`;
  const text = t(key);
  return text === key ? (body.error ?? t("picker.error.FAILED")) : text;
}

/**
 * Opens the chooser in a dialog. `onPick` gets the full path of the folder the person confirms; closing it any other way picks nothing.
 * @param {PickerOptions} options
 */
export function openFolderPicker(options) {
  const { t, get, post, canCreate } = options;
  /** @type {Listing | undefined} */
  let listing;
  /** @type {{ roots: Place[], shortcuts: Place[] }} */
  let places = { roots: [], shortcuts: [] };
  let problem = "";
  let naming = false;
  let loading = true;

  const dialog = /** @type {HTMLDialogElement} */ (h("dialog", { class: "picker", "aria-labelledby": "picker-title" }));
  dialog.addEventListener("close", () => dialog.remove());

  /** @param {string | undefined} target @param {boolean} [retry] */
  async function go(target, retry = true) {
    loading = true;
    problem = "";
    draw();
    try {
      const res = await get(`/api/browse${target ? `?path=${encodeURIComponent(target)}` : ""}`);
      const body = await res.json();
      if (res.ok) listing = body;
      else {
        problem = reasonText(t, body);
        // The folder it was meant to open is gone or unreadable: open where the server suggests rather than show nothing.
        if (!listing && retry) return go(undefined, false);
      }
    } catch {
      problem = t("picker.error.FAILED");
    }
    loading = false;
    draw();
    const pathElement = dialog.querySelector("#picker-path");
    if (pathElement instanceof HTMLElement) pathElement.focus();
  }

  async function createFolder(/** @type {string} */ name) {
    if (!listing) return;
    try {
      const res = await post("/api/folders", { parent: listing.path, name });
      const body = await res.json();
      if (!res.ok) {
        problem = reasonText(t, body);
        return draw();
      }
      naming = false;
      await go(body.path);
    } catch {
      problem = t("picker.error.FAILED");
      draw();
    }
  }

  function placeButton(/** @type {Place} */ place) {
    const label = PLACE_KINDS.includes(place.kind) ? t(`picker.place.${place.kind}`) : place.name;
    return h("button", { type: "button", "aria-current": listing?.path === place.path ? "true" : undefined, onclick: () => go(place.path) }, label);
  }

  function moveFocus(/** @type {KeyboardEvent} */ event) {
    const buttons = [...dialog.querySelectorAll(".folders button")];
    const at = buttons.indexOf(/** @type {Element} */ (document.activeElement));
    const next = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: buttons.length - 1 }[/** @type {"ArrowDown"} */ (event.key)];
    if (next === undefined || at < 0) return;
    event.preventDefault();
    /** @type {HTMLElement | undefined} */ (buttons[Math.min(Math.max(next, 0), buttons.length - 1)])?.focus();
  }

  function newFolderForm() {
    const input = h("input", { type: "text", id: "picker-new-name", maxlength: 100, autocomplete: "off" });
    const submit = () => createFolder(/** @type {HTMLInputElement} */ (input).value);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        submit();
      }
    });
    queueMicrotask(() => input.focus());
    return h(
      "div",
      { class: "new-folder" },
      h("label", { for: "picker-new-name" }, t("picker.newFolderName")),
      input,
      h("button", { type: "button", class: "primary", onclick: submit }, t("picker.create")),
      h("button", { type: "button", onclick: () => ((naming = false), (problem = ""), draw()) }, t("picker.cancel")),
    );
  }

  function draw() {
    const here = listing;
    const folders = here?.folders ?? [];
    dialog.replaceChildren(
      h("div", { class: "head" }, h("h2", { id: "picker-title" }, options.title), h("button", { type: "button", onclick: () => dialog.close() }, t("action.close"))),
      h(
        "div",
        { class: "picker-body" },
        h(
          "nav",
          { class: "places", "aria-label": t("picker.places") },
          places.shortcuts.map(placeButton),
          places.roots.map(placeButton),
        ),
        h(
          "div",
          { class: "here" },
          h("button", { type: "button", disabled: !here?.parent, onclick: () => here?.parent && go(here.parent) }, t("picker.up")),
          h("span", { class: "path", id: "picker-path", tabindex: -1 }, h("span", { class: "sr-only" }, t("picker.currentLabel")), here?.path ?? ""),
        ),
        problem ? h("p", { class: "problem", role: "alert" }, problem) : null,
        loading && !here ? h("p", { class: "note" }, t("picker.loading")) : null,
        folders.length > 0
          ? h(
              "ul",
              { class: "folders", onkeydown: moveFocus },
              folders.map((folder) =>
                h(
                  "li",
                  {},
                  h("button", { type: "button", class: "folder", "aria-label": t("picker.open", { name: folder.name }), onclick: () => go(folder.path) }, h("span", { class: "folder-icon", "aria-hidden": "true" }), folder.name),
                ),
              ),
            )
          : here && !loading
            ? h("p", { class: "note" }, t("picker.empty"))
            : null,
        here?.truncated ? h("p", { class: "note" }, t("picker.truncated", { count: folders.length })) : null,
        here ? h("p", { class: "note photos" }, t("picker.photosHere", { count: here.photos })) : null,
        naming ? newFolderForm() : null,
      ),
      h(
        "div",
        { class: "foot" },
        canCreate ? h("button", { type: "button", disabled: !here || naming, onclick: () => ((naming = true), (problem = ""), draw()) }, t("picker.newFolder")) : null,
        h("span", { class: "spacer" }),
        h("button", { type: "button", onclick: () => dialog.close() }, t("picker.cancel")),
        h(
          "button",
          {
            type: "button",
            class: "primary",
            disabled: !here,
            onclick: () => {
              if (!here) return;
              options.onPick(here.path);
              dialog.close();
            },
          },
          t("picker.use"),
        ),
      ),
    );
  }

  document.body.append(dialog);
  draw();
  dialog.showModal();
  get("/api/places")
    .then((res) => (res.ok ? res.json() : undefined))
    .then((found) => {
      if (found) places = found;
      draw();
    })
    .catch(() => undefined);
  go(options.start);
  return dialog;
}
