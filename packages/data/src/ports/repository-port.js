/**
 * RepositoryPort is the persistence boundary for the newsroom domain.
 *
 * Adapters return snake_case records because that is the wire shape already
 * used by the ported n8n workflows and the panel. Method arguments are
 * camelCase because they are called from JavaScript use cases.
 *
 * This class is documentation plus a runtime guard: every adapter must
 * override every method. Contract tests in `test/repository-contract.test.js`
 * are the real specification.
 */
export class RepositoryPort {
  async migrate() {
    throw new Error('not_implemented: migrate');
  }

  async healthCheck() {
    throw new Error('not_implemented: healthCheck');
  }

  async close() {
    throw new Error('not_implemented: close');
  }

  // Discovery and staging ---------------------------------------------------
  async upsertNews() { throw new Error('not_implemented: upsertNews'); }
  async listNewsForClustering() { throw new Error('not_implemented: listNewsForClustering'); }
  async resetDiscoveryState() { throw new Error('not_implemented: resetDiscoveryState'); }
  async resetStaging() { throw new Error('not_implemented: resetStaging'); }
  async resetDemoStory() { throw new Error('not_implemented: resetDemoStory'); }
  async persistClusters() { throw new Error('not_implemented: persistClusters'); }
  async createNewsSearchRun() { throw new Error('not_implemented: createNewsSearchRun'); }
  async getNewsSearchRun() { throw new Error('not_implemented: getNewsSearchRun'); }
  async updateNewsSearchRun() { throw new Error('not_implemented: updateNewsSearchRun'); }
  async promoteNewsSearchRun() { throw new Error('not_implemented: promoteNewsSearchRun'); }

  // Approval ----------------------------------------------------------------
  async listPendingApprovalClusters() { throw new Error('not_implemented: listPendingApprovalClusters'); }
  async getApprovalTopicDetail() { throw new Error('not_implemented: getApprovalTopicDetail'); }
  async applyApprovalDecision() { throw new Error('not_implemented: applyApprovalDecision'); }
  // Script queue and drafts -------------------------------------------------
  async claimScriptJob() { throw new Error('not_implemented: claimScriptJob'); }
  async updateScriptJobProgress() { throw new Error('not_implemented: updateScriptJobProgress'); }
  async completeScriptJob() { throw new Error('not_implemented: completeScriptJob'); }
  async failScriptJob() { throw new Error('not_implemented: failScriptJob'); }
  async getScriptQueueMonitor() { throw new Error('not_implemented: getScriptQueueMonitor'); }
  async getPendingScriptDrafts() { throw new Error('not_implemented: getPendingScriptDrafts'); }
  async saveScriptDraft() { throw new Error('not_implemented: saveScriptDraft'); }
  async dismissScriptFromPanel() { throw new Error('not_implemented: dismissScriptFromPanel'); }
  async getPublishableScriptDraft() { throw new Error('not_implemented: getPublishableScriptDraft'); }
  async finalizeScriptPublish() { throw new Error('not_implemented: finalizeScriptPublish'); }

  // Publish jobs ------------------------------------------------------------
  async createPublishJob() { throw new Error('not_implemented: createPublishJob'); }
  async updatePublishJob() { throw new Error('not_implemented: updatePublishJob'); }
  async getPublishJob() { throw new Error('not_implemented: getPublishJob'); }

  // Video projects ----------------------------------------------------------
  async upsertVideoProject() { throw new Error('not_implemented: upsertVideoProject'); }
  async getVideoEditProjects() { throw new Error('not_implemented: getVideoEditProjects'); }
  async saveVideoProjectSelections() { throw new Error('not_implemented: saveVideoProjectSelections'); }
  async saveVideoProjectEditorState() { throw new Error('not_implemented: saveVideoProjectEditorState'); }
  async saveVideoProjectAudio() { throw new Error('not_implemented: saveVideoProjectAudio'); }
  async addVideoProjectCustomImages() { throw new Error('not_implemented: addVideoProjectCustomImages'); }
  async disableVideoEditProject() { throw new Error('not_implemented: disableVideoEditProject'); }

  // Users, roles and sessions -----------------------------------------
  async listRoles() { throw new Error('not_implemented: listRoles'); }
  async createUser() { throw new Error('not_implemented: createUser'); }
  async getUserById() { throw new Error('not_implemented: getUserById'); }
  async getUserByEmail() { throw new Error('not_implemented: getUserByEmail'); }
  async listUsers() { throw new Error('not_implemented: listUsers'); }
  async updateUser() { throw new Error('not_implemented: updateUser'); }
  async setUserRoles() { throw new Error('not_implemented: setUserRoles'); }
  async createSession() { throw new Error('not_implemented: createSession'); }
  async getSessionByTokenHash() { throw new Error('not_implemented: getSessionByTokenHash'); }
  async touchSession() { throw new Error('not_implemented: touchSession'); }
  async revokeSession() { throw new Error('not_implemented: revokeSession'); }
  async deleteExpiredSessions() { throw new Error('not_implemented: deleteExpiredSessions'); }
}
