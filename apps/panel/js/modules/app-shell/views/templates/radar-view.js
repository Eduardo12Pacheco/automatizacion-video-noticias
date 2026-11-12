/**
 * Radar / Investigación view template.
 * 1:1 parity — exact DOM structure from original index.html.
 */
export const radarViewHTML = `\
          <section class="radar-layout">
            <section class="panel-shell radar-monitor-panel">
              <header class="audio-queue-header">
                <div>
                  <h3 data-i18n="radar.title">Buscador de Prensa.</h3>
                  <p id="radarMonitorStatus" class="meta word-count" data-i18n="radar.loadingVideos">Cargando videos monitoreados.</p>
                </div>
                <div class="radar-monitor-toolbar" aria-label="Acciones Radar Monitor">
                  <button id="radarBasuraBtn" class="ghost" type="button" data-i18n="radar.trash">Basura <span id="radarBasuraCount">0</span></button>
                  <button id="radarMonitorRefreshBtn" class="secondary" type="button" data-i18n="radar.update">Actualizar</button>
                </div>
              </header>
              <nav id="radarCountryBar" class="radar-country-bar" aria-label="Pa\u00edses monitoreados">
                <button class="radar-country-card" type="button" data-radar-country-option="" aria-pressed="true"><span>00 / Todos</span></button>
                <button class="radar-country-card" type="button" data-radar-country-option="aurenia" aria-pressed="false"><span>01 / Aurenia</span></button>
                <button class="radar-country-card" type="button" data-radar-country-option="montelia" aria-pressed="false"><span>02 / Montelia</span></button>
                <button class="radar-country-card" type="button" data-radar-country-option="valdoria" aria-pressed="false"><span>03 / Valdoria</span></button>
                <button class="radar-country-card" type="button" data-radar-country-option="rivamar" aria-pressed="false"><span>04 / Rivamar</span></button>
                <button class="radar-country-card" type="button" data-radar-country-option="bosquemar" aria-pressed="false"><span>05 / Bosquemar</span></button>
                <button class="radar-country-card" type="button" data-radar-country-option="terramar" aria-pressed="false"><span>06 / Terramar</span></button>
                <button class="radar-country-card" type="button" data-radar-country-option="important" aria-pressed="false"><span>07 / IMPORTANTES</span></button>
              </nav>
              <div class="radar-monitor-controls" aria-label="Filtros del Buscador de Prensa">
                <label class="editor-label audio-field audio-field--grow">
                  <span data-i18n="radar.search">Buscar</span>
                  <input id="radarMonitorSearchInput" placeholder="T\u00edtulo, tema o canal" autocomplete="off" />
                </label>
                <label class="editor-label audio-field">
                  <span data-i18n="radar.order">Orden</span>
                  <select id="radarMonitorSortSelect">
                    <option value="relevance" selected data-i18n="radar.relevance">Relevancia</option>
                    <option value="recent" data-i18n="radar.recent">Recientes</option>
                  </select>
                </label>
              </div>
              <section id="radarMonitorList" class="radar-monitor-list is-empty">Cargando videos monitoreados.</section>
            </section>
          </section>

          <dialog id="radarBasuraDialog">
            <article>
              <header class="dialog-header">
                <h2 data-i18n="radar.trash">Basura</h2>
                <button id="radarBasuraCloseBtn" class="dialog-close" type="button" aria-label="Cerrar">×</button>
              </header>
              <div id="radarBasuraList" class="radar-basura-list"></div>
            </article>
          </dialog>

          <dialog id="radarNewJobDialog">
            <article>
              <header class="dialog-header">
                <h2 data-i18n="radar.new">Nueva investigaci\u00f3n</h2>
                <button id="radarNewJobCancelBtn" class="dialog-close" type="button" aria-label="Cerrar">×</button>
              </header>
              <label class="editor-label audio-field audio-field--grow">
                <span data-i18n="radar.link">Link del video</span>
                <input id="radarUrlInput" placeholder="https://youtu.be/..." />
              </label>
              <fieldset class="settings-section">
                <legend>Pa\u00edses</legend>
                <label><input id="radarCountryColombia" type="checkbox" value="montelia" /> Montelia</label>
                <label><input id="radarCountryEcuador" type="checkbox" value="aurenia" /> Aurenia</label>
                <label><input id="radarCountryValdoria" type="checkbox" value="valdoria" /> Valdoria</label>
                <label><input id="radarCountryParaguay" type="checkbox" value="bosquemar" /> Bosquemar</label>
                <label><input id="radarCountryUruguay" type="checkbox" value="rivamar" /> Rivamar</label>
                <label><input id="radarCountryMexico" type="checkbox" value="terramar" /> Terramar</label>
              </fieldset>
              <label class="editor-label audio-field">
                <span data-i18n="radar.keywords">Keywords extra</span>
                <textarea id="radarExtraKeywordsInput" class="script-area" placeholder="Márquez, Miranda, Entrenador Demo"></textarea>
              </label>
              <p id="radarValidationMessage" class="meta" aria-live="polite"></p>
              <footer class="dialog-actions">
                <button id="radarSubmitBtn" class="primary" type="button" data-i18n="radar.createJob">Crear job</button>
              </footer>
            </article>
          </dialog>

          <dialog id="radarSummaryDialog">
            <article>
              <header class="dialog-header">
                <h2 data-i18n="radar.summary">Resumen</h2>
                <button id="radarSummaryCloseBtn" class="dialog-close" type="button" aria-label="Cerrar">×</button>
              </header>
              <div id="radarSummaryBody" class="topic-dialog-body"></div>
            </article>
          </dialog>

          <dialog id="radarConfirmDialog" aria-labelledby="radarConfirmTitle" aria-describedby="radarConfirmMessage">
            <article>
              <header class="dialog-header"><h2 id="radarConfirmTitle">Confirmar acci\u00f3n</h2></header>
              <p id="radarConfirmMessage" data-i18n="radar.confirmMeta">Esta acci\u00f3n modifica el job seleccionado.</p>
              <footer class="dialog-actions">
                <button id="radarConfirmCancelBtn" class="secondary" type="button" data-i18n="radar.cancel">Cancelar</button>
                <button id="radarConfirmAcceptBtn" class="primary" type="button" data-i18n="radar.confirm">Confirmar</button>
              </footer>
            </article>
          </dialog>`;
