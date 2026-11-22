const escapeAttribute = (value: string): string => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * The page's skeleton: landmarks, the places the script fills in, and the token (in a meta tag, not in script, so the
 * page runs under a policy that allows no inline script). Everything else is in the client files next to this one.
 */
export function reviewPage(token: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="vivah-token" content="${escapeAttribute(token)}">
<title>VivahLens review</title>
<link rel="stylesheet" href="/assets/app.css">
</head><body>
<a class="skip" id="skip" href="#grid">Skip to photos</a>
<header class="bar">
  <h1 id="title">VivahLens review</h1><span class="job" id="job"></span>
  <button type="button" id="privacy-button"></button>
  <label><span id="lang-label">Language</span> <select id="lang"></select></label>
  <button type="button" id="help-button" aria-label="Keyboard shortcuts">?</button>
  <button type="button" id="approve-all"></button>
  <button type="button" class="primary" id="submit"></button>
</header>
<nav class="filters" id="filters"></nav>
<p class="banner" id="banner" hidden></p>
<p class="status" id="summary"></p>
<p class="status" id="status"></p>
<main>
  <p class="empty" id="empty" hidden></p>
  <ul class="grid" id="grid" tabindex="-1"></ul>
</main>
<div id="live" role="status" aria-live="polite"></div>
<dialog id="detail"></dialog>
<script type="module" src="/assets/app.js"></script>
</body></html>`;
}
