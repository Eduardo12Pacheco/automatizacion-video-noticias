export const adminUsersViewHTML = `
  <section class="admin-users-shell panel-shell">
    <header class="section-heading">
      <div>
        <h2 data-i18n="users.title">Usuarios</h2>
        <p class="meta" data-i18n="users.subtitle">Creá cuentas, asigná roles y deshabilitá el acceso sin tocar el servidor.</p>
      </div>
      <button id="adminUsersRefreshBtn" class="secondary" type="button" data-i18n="common.refresh">Refrescar</button>
    </header>

    <p id="adminUsersStatus" class="meta" aria-live="polite"></p>

    <form id="adminUsersForm" class="admin-users-form" autocomplete="off">
      <h3 data-i18n="users.create">Nuevo usuario</h3>
      <label class="settings-field">
        <span data-i18n="users.name">Nombre</span>
        <input id="adminUserName" name="display_name" type="text" required maxlength="120" />
      </label>
      <label class="settings-field">
        <span data-i18n="users.email">Correo</span>
        <input id="adminUserEmail" name="email" type="email" required autocomplete="off" />
      </label>
      <label class="settings-field">
        <span data-i18n="users.password">Contraseña</span>
        <input id="adminUserPassword" name="password" type="password" required minlength="8" autocomplete="new-password" />
      </label>
      <label class="settings-field">
        <span data-i18n="users.roles">Roles</span>
        <select id="adminUserRole" name="role">
          <option value="editor" data-i18n="users.roleEditor">Editor</option>
          <option value="viewer" data-i18n="users.roleViewer">Lector</option>
          <option value="admin" data-i18n="users.roleAdmin">Administrador</option>
        </select>
      </label>
      <button id="adminUsersCreateBtn" class="primary" type="submit" data-i18n="users.createSubmit">Crear usuario</button>
    </form>

    <section id="adminUsersList" class="admin-users-list" aria-label="Usuarios" aria-live="polite"></section>
  </section>`;
