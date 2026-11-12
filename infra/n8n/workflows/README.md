# n8n example workflows

Two small, supported workflows that use n8n only as a trigger/notification
layer. The domain logic stays in `packages/core`; these files contain no
credentials and no Supabase nodes.

| File | Trigger | Action |
|---|---|---|
| `discover-cron.json` | Schedule Trigger (daily 06:00) | `POST $NEWSROOM_API_URL/jobs/discover` with the machine token |
| `job-completed-notification.json` | Webhook `POST /webhook/job-completed` | Sends one email when the API reports a finished job |

## Import

```sh
docker compose --profile n8n up -d
docker compose exec n8n n8n import:workflow --input=/workflows/discover-cron.json
docker compose exec n8n n8n import:workflow --input=/workflows/job-completed-notification.json
```

Then set these n8n environment variables (the Compose `n8n` service reads them
from `.env`):

```dotenv
NEWSROOM_API_URL=http://api:8099
NEWSROOM_JOBS_TOKEN=<same value as JOBS_API_KEY>
```

Open the `job-completed-notification` workflow and attach an SMTP credential
(any provider, including Gmail with an app password) to the "Send completion
email" node, then activate both workflows.

The API's in-process queue remains the only job executor. These workflows add
a cron trigger and a completion notification; they never enqueue domain jobs.

The legacy 16-workflow export is intentionally **not** mounted; it lives under
`examples/legacy-n8n/` as read-only history.
