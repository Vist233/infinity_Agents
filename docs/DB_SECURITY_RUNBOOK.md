# Local PostgreSQL security profile

`scripts/rls_roles.sql` is the explicit database-security step for a clean
local acceptance database. It creates non-superuser, `NOBYPASSRLS` API and
Worker roles, adds project/Task composite references, and forces RLS on the
project, resource, provider, Task, Attempt, Outbox, and Artifact tables.

The application must set `SET LOCAL app.user_id = '...'` inside an API request
transaction. A Worker must set `SET LOCAL app.worker_id = '...'`. An unset
context intentionally returns no rows and cannot satisfy a policy. The script
is not run automatically against the existing development database because
legacy rows need an explicit constraint-repair review first.

The acceptance Compose stack already verifies the application-level equivalent
with user-owned Projects, opaque Resource IDs, and cross-user 404 responses.
The SQL profile is the database-level gate required before treating that
application test as a release-level RLS result.
