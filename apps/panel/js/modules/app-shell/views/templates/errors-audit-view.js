export const errorsAuditViewHTML = `
  <section class="errors-audit-shell panel-shell">
    <header class="section-heading">
      <div>
        <h2 data-i18n="errors.title">Errors/Audit</h2>
        <p class="meta" data-i18n="errors.subtitle">Eventos Gateway sanitizados para diagnóstico operativo.</p>
      </div>
      <button id="errorsAuditRefreshBtn" class="secondary" type="button" data-i18n="errors.retry">Reintentar</button>
    </header>

    <section class="errors-audit-filters" aria-label="Filtros Errors/Audit">
      <label class="control-group"><span class="control-label" data-i18n="errors.kind">Tipo</span><select id="errorsAuditKindFilter"><option value="" data-i18n="errors.all">Todos</option><option value="error" data-i18n="errors.error">Error</option><option value="audit" data-i18n="errors.audit">Auditoría</option></select></label>
      <label class="control-group"><span class="control-label" data-i18n="errors.status">Estado</span><input id="errorsAuditStatusFilter" placeholder="failure, success, 500" /></label>
      <label class="control-group"><span class="control-label" data-i18n="errors.service">Servicio</span><input id="errorsAuditServiceFilter" placeholder="gateway" /></label>
      <label class="control-group"><span class="control-label" data-i18n="errors.actor">Usuario</span><input id="errorsAuditActorFilter" placeholder="operator" /></label>
      <label class="control-group"><span class="control-label" data-i18n="errors.correlation">Correlation ID</span><input id="errorsAuditCorrelationFilter" placeholder="corr-..." /></label>
      <label class="control-group"><span class="control-label" data-i18n="errors.from">Desde</span><input id="errorsAuditFromFilter" type="date" /></label>
      <label class="control-group"><span class="control-label" data-i18n="errors.to">Hasta</span><input id="errorsAuditToFilter" type="date" /></label>
    </section>

    <p id="errorsAuditStatus" class="meta" aria-live="polite" data-i18n="errors.empty">Sin eventos cargados.</p>
    <div class="errors-audit-layout">
      <section id="errorsAuditList" class="errors-audit-list" aria-label="Eventos Gateway"></section>
      <aside id="errorsAuditDetail" class="errors-audit-detail-panel" aria-label="Detalle de evento"><p class="meta" data-i18n="errors.select">Seleccioná un evento para ver el detalle.</p></aside>
    </div>
  </section>`;
