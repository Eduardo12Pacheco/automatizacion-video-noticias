export const connectorsViewHTML = `
  <section class="connectors-shell panel-shell">
    <header class="section-heading">
      <div>
        <h2 data-i18n="connectors.title">Conectores</h2>
        <p class="meta" data-i18n="connectors.subtitle">Cada integración es un adaptador detrás de un puerto. Acá ves el adaptador activo y probás su conexión.</p>
      </div>
      <button id="connectorsRefreshBtn" class="secondary" type="button" data-i18n="common.refresh">Refrescar</button>
    </header>

    <p id="connectorsStatus" class="meta" aria-live="polite"></p>
    <section id="connectorsList" class="connectors-grid" aria-label="Conectores" aria-live="polite"></section>
  </section>`;
