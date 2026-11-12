import { buildFutureProjectCard, buildProjectCard } from './project-list-markup.js';
import { hydrateProjectListCards } from '../events/project-list-events.js';
import { renderEmptyState, renderErrorState, renderLoadingState } from '../../../core/ui/screen-state.js';

export function renderVideoProjectsListView({ state, el, openVideoProject, prefetchProjectDetail, disableVideoProject, confirmDelete }) {
  if (!el.videoProjectsList) return;

  const projects = Array.isArray(state.videoProjects) ? state.videoProjects : [];
  const loading = Boolean(state.videoProjectsLoading);

  if (el.videoProjectsMeta) {
    el.videoProjectsMeta.textContent = loading
      ? 'Actualizando proyectos…'
      : `${projects.length} proyecto${projects.length === 1 ? '' : 's'}`;
  }
  if (loading && !projects.length) {
    el.videoProjectsList.innerHTML = renderLoadingState({ rows: 3, variant: 'cards' });
    return;
  }
  if (state.videoProjectsError && !projects.length) {
    el.videoProjectsList.innerHTML = renderErrorState({
      error: state.videoProjectsError,
      fallbackKey: 'scripts.emptyTitle',
      retryAttribute: 'data-video-projects-action="refresh"',
    });
    return;
  }
  if (!projects.length) {
    el.videoProjectsList.innerHTML = renderEmptyState({
      icon: 'video',
      titleKey: 'scripts.emptyTitle',
      messageKey: 'scripts.emptyMessage',
    });
    return;
  }

  el.videoProjectsList.innerHTML = [...projects.map((project) => buildProjectCard(project)), buildFutureProjectCard()].join('');
  hydrateProjectListCards({ root: el.videoProjectsList, openVideoProject, prefetchProjectDetail, disableVideoProject, confirmDelete });
}
