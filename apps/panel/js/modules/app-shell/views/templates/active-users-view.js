export const activeUsersViewHTML = `
  <section class="active-users-shell panel-shell">
    <header class="section-heading">
      <div>
        <h2 data-i18n="activeUsers.title">Activos</h2>
        <p class="meta" data-i18n="activeUsers.subtitle">Sesiones activas reportadas por el Gateway.</p>
      </div>
      <button id="activeUsersRefreshBtn" class="secondary" type="button" data-i18n="activeUsers.refresh">Actualizar</button>
    </header>

    <p id="activeUsersStatus" class="meta" aria-live="polite" data-i18n="activeUsers.empty">Sin presencia cargada.</p>
    <section id="activeUsersList" class="active-users-list" aria-label="Usuarios activos"></section>
  </section>`;
