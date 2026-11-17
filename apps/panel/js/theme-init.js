// Apply the stored/system theme before CSS paints. This lives in its own file
// (instead of an inline <script>) so the panel can enforce a strict CSP with
// script-src 'self'.
(function () {
  try {
    var key = 'newsroom-panel-theme-v1';
    var stored = localStorage.getItem(key);
    var theme = stored === 'light' || stored === 'dark'
      ? stored
      : (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    document.documentElement.dataset.theme = theme;
  } catch (error) {
    document.documentElement.dataset.theme = 'dark';
  }
})();
