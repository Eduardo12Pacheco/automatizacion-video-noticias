-- 0002_seed_roles.sql
-- Role names are part of the S9 contract; descriptions are UI/documentation only.

insert into roles (role, description) values
  ('admin', 'Full access, including user administration and audit views'),
  ('editor', 'Can discover, approve, draft, publish and edit projects'),
  ('viewer', 'Read-only access to the panel')
on conflict (role) do update set description = excluded.description;
