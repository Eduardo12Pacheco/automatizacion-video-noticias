const { createApprovalPipelineLocalService } = require("./services/approval-pipeline-local-service");

if (require.main === module) {
  const port = Number(process.env.APPROVAL_PIPELINE_LOCAL_SERVICE_PORT || 3041);
  const server = createApprovalPipelineLocalService();
  server.listen(port, "127.0.0.1", () => {
    console.log(`approval-contract-pipeline-local-service listening on http://127.0.0.1:${port}`);
  });
}

module.exports = { createApprovalPipelineLocalService };
