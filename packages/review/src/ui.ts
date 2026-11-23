const escapeAttribute = (value: string): string => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * The page's skeleton: landmarks, the places the script fills in, and the token (in a meta tag, not in script, so the
 * page runs under a policy that allows no inline script). Everything else is in the client files next to this one.
 * One of three sections shows at a time: choosing folders (`setup`), the edit running (`progress`), or the photos (`review`).
 */
export function reviewPage(token: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="vivah-token" content="${escapeAttribute(token)}">
<title>VivahLens</title>
<link rel="stylesheet" href="/assets/app.css">
</head><body>
<a class="skip" id="skip" href="#grid">Skip to photos</a>
<header class="bar">
  <div class="brand"><span class="brand-mark" aria-hidden="true"></span><div class="brand-text"><h1 id="title">VivahLens</h1><span class="tagline" id="tagline"></span></div></div>
  <nav class="steps" id="steps"></nav>
  <div class="tools">
    <button type="button" id="privacy-button"></button>
    <label><span id="lang-label">Language</span> <select id="lang"></select></label>
    <button type="button" id="help-button" aria-label="Keyboard shortcuts">?</button>
  </div>
</header>
<p class="status" id="status"></p>
<main>
  <section class="stage" id="setup" tabindex="-1" hidden></section>
  <section class="stage" id="progress" tabindex="-1" hidden></section>
  <section id="review" hidden>
    <div class="page-head">
      <div><h2 class="page-title" id="review-title" tabindex="-1"></h2><span class="job" id="job"></span></div>
      <div class="review-actions" id="review-actions">
        <button type="button" id="new-shoot"></button>
        <button type="button" id="approve-all"></button>
        <button type="button" class="primary" id="submit"></button>
      </div>
    </div>
    <nav class="filters" id="filters"></nav>
    <div class="toolbar" id="toolbar" role="toolbar"></div>
    <p class="banner" id="banner" hidden></p>
    <p class="status" id="summary"></p>
    <p class="empty" id="empty" hidden></p>
    <ul class="grid" id="grid" tabindex="-1"></ul>
  </section>
</main>
<div id="live" role="status" aria-live="polite"></div>
<dialog id="detail"></dialog>
<script type="module" src="/assets/app.js"></script>
</body></html>`;
}
