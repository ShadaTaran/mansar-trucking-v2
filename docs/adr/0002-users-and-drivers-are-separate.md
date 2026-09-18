# 0002. Users and drivers are separate

Status: Accepted

## Context

A driver is an operational entity (assigned to trips, associated with vehicles
and expenses). A user is an authentication identity with a role. Conflating
them forces every driver to have a login and every login to be a driver, which
does not match how the business operates.

## Decision

- `User` and `Driver` are distinct entities.
- A user has a role: `ADMIN` or `DRIVER`.
- A driver record may be linked to a user account, but exists independently
  of one.

## Consequences

- Drivers can be recorded and assigned before they have app access.
- Admin accounts are not drivers.
- Authorization checks reason about the user; operational rules reason about
  the driver.
