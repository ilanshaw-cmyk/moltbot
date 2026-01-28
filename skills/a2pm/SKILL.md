---
name: a2pm
description: Manage A2PM personal productivity data including Runners, emails, RAID logs, and project information via MCP database access.
homepage: https://a2pm.scribasound.com
metadata: {"moltbot":{"emoji":"📋","requires":{"mcp":["postgres-projects","postgres-emails","postgres-raid","postgres-browser","postgres-project_plans"]}}}
---

# A2PM Integration

A2PM is a multi-tenant personal productivity application. This skill enables you to manage the user's A2PM data including **Runners** (scheduled tasks), emails, RAID logs, and project information.

## Key Concept: Runners

When the user mentions "runner", "runners", "scheduled task", or "set up a reminder", they are referring to **A2PM Runners** - scheduled tasks that appear on the user's Runners page in A2PM.

**IMPORTANT**: When creating a runner, it will be stored in A2PM's `runners` table and synced with MoltBot's cron system. The user manages runners from the A2PM Runners page, and MoltBot executes them.

## Database Access

Use the `mcporter` tool to access A2PM databases:

| Database | MCP Server | Key Tables |
|----------|------------|------------|
| Projects | `postgres-projects` | `runners`, `project_settings`, `users`, `user_companies`, `project_dna` |
| Emails | `postgres-emails` | `emails`, `user_email_accounts` |
| RAID | `postgres-raid` | `actions`, `risks`, `issues`, `decisions`, `thought_streams` |
| Plans | `postgres-project_plans` | `tasks`, `resources`, `assignments` |
| AI | `postgres-browser` | `conversations`, `messages` |

## Runners Management

### Listing Runners

```sql
-- List all active runners for a user
SELECT id, name, description, frequency, frequency_time, is_active, scope, client, project
FROM runners
WHERE user_id = '<user_id>' AND company_id = <company_id>
ORDER BY name;
```

### Creating a Runner

When creating a runner, populate these fields:

| Field | Required | Description |
|-------|----------|-------------|
| `company_id` | Yes | User's account ID |
| `user_id` | Yes | User's UUID |
| `name` | Yes | Short name for the runner |
| `description` | No | Longer description |
| `scope` | Yes | `'global'`, `'account'`, or `'project'` |
| `client` | If project | Category name (e.g., "Job Search") |
| `project` | If project | Project name (e.g., "Project Management") |
| `frequency` | Yes | `'daily'`, `'weekly'`, `'monthly'`, `'custom'` |
| `frequency_time` | Yes | Time to run (e.g., `'09:00:00'`) |
| `frequency_day_of_week` | If weekly | 0=Sunday, 1=Monday, ..., 6=Saturday |
| `frequency_day_of_month` | If monthly | 1-31 |
| `instructions` | Yes | The prompt/instructions for what the runner should do |
| `example_output` | No | Example of expected output |
| `is_active` | Yes | `true` to enable |
| `context_sources` | No | JSON array of data sources to include |

```sql
-- Example: Create a daily runner
INSERT INTO runners (
  company_id, user_id, name, description, scope, client, project,
  frequency, frequency_time, instructions, is_active, configuration, context_sources
) VALUES (
  2, '00000000-0000-0000-0000-000000000001',
  'Daily Job Search Summary',
  'Summarise new job postings matching my CV',
  'project', 'Job Search', 'Project Management',
  'daily', '08:00:00',
  'Search my emails for new job postings received in the last 24 hours. Summarise each posting with: job title, company, salary if mentioned, and a match score against my CV.',
  true,
  '{}',
  '[]'
) RETURNING id, name;
```

### Updating a Runner

```sql
UPDATE runners
SET name = 'Updated Name',
    instructions = 'New instructions...',
    updated_at = NOW()
WHERE id = <runner_id> AND company_id = <company_id>;
```

### Disabling/Enabling a Runner

```sql
UPDATE runners SET is_active = false WHERE id = <runner_id>;
UPDATE runners SET is_active = true WHERE id = <runner_id>;
```

### Deleting a Runner

```sql
DELETE FROM runners WHERE id = <runner_id> AND company_id = <company_id>;
```

## Frequency Options

| Frequency | Additional Fields |
|-----------|-------------------|
| `daily` | Just `frequency_time` |
| `weekly` | `frequency_time` + `frequency_day_of_week` (0-6) |
| `monthly` | `frequency_time` + `frequency_day_of_month` (1-31) |
| `custom` | `frequency_time` + `frequency_custom_value` + `frequency_custom_unit` (hours/days/weeks) |

## Context Sources

Runners can include context from various data sources. The `context_sources` field is a JSON array:

```json
[
  {
    "id": "ctx_emails",
    "dataType": "emails",
    "selectionMode": "all",
    "dateRangeMode": "custom",
    "customDateStart": "2026-01-01",
    "customDateEnd": "2026-01-31",
    "filter": {
      "contains": "job",
      "fromDomain": "linkedin"
    }
  }
]
```

Available data types: `emails`, `calendar_events`, `thoughts`, `transcriptions`, `actions`, `risks`, `issues`, `decisions`.

## Project Filtering

When the user is working in a specific project context, filter all queries:

```sql
-- For project-scoped data:
WHERE company_id = <company_id> AND client = '<client>' AND project = '<project>'

-- For account-wide data:
WHERE company_id = <company_id>
```

## Runner ↔ MoltBot Cron Sync

A2PM Runners automatically sync with MoltBot's cron system. When you create or update a runner:

1. **A2PM → MoltBot**: When a runner is created/updated in A2PM, it automatically creates/updates a corresponding MoltBot cron job
2. **MoltBot → A2PM**: When you create a runner via MoltBot (using SQL), it appears on the A2PM Runners page

### Sync Status Columns

The `runners` table has sync tracking columns:

| Column | Description |
|--------|-------------|
| `moltbot_cron_id` | ID of the linked MoltBot cron job |
| `moltbot_sync_status` | Status: `synced`, `pending`, `error`, `disabled` |
| `moltbot_synced_at` | Timestamp of last successful sync |
| `moltbot_sync_error` | Error message if sync failed |

### Creating Runners via MoltBot

When creating a runner via SQL, also create the MoltBot cron job for execution:

```sql
-- 1. Insert into A2PM runners table
INSERT INTO runners (
  company_id, user_id, name, description, scope, client, project,
  frequency, frequency_time, instructions, is_active
) VALUES (
  2, '00000000-0000-0000-0000-000000000001',
  'Daily Job Summary', 'Summarise new job postings',
  'project', 'Job Search', 'Project Management',
  'daily', '08:00:00',
  'Search emails for new job postings and summarise them.',
  true
) RETURNING id;
```

Then use the `cron` tool to create the MoltBot scheduled job:

```
cron add --name "a2pm-runner-<id>" --schedule "0 8 * * *" --message "Execute A2PM Runner: Daily Job Summary..."
```

The A2PM Runners page will show the sync status for each runner.

## Related References

- See `references/database-schemas.md` for full table schemas
- See `references/runners.md` for runner configuration examples
- See `references/api-endpoints.md` for A2PM API endpoints
