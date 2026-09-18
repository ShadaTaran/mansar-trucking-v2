# Security and Data Policy (repository level)

This document covers only what may and may not enter this Git repository.
Runtime security (authentication, authorization, transport) is specified with
the applications in later stages.

## Never commit

- Real Mansar business data (trips, expenses, vehicles, customers, rates)
- Driver or employee personally identifiable information
- Real receipt images or documents
- Credentials of any kind
- API keys, access tokens, refresh tokens, session tokens
- `.env` files or any file containing environment secrets (`.env.example`
  with placeholder values is the only permitted variant)
- Release keystores, signing certificates, or private keys
  (`*.keystore`, `*.jks`, `*.p12`, `*.pem`)
- Signing passwords or store passwords
- Customer or client private data of any kind

The root `.gitignore` excludes the common file patterns above, but the
`.gitignore` is a convenience, not the policy. A file that slips past it is
still a violation.

## Synthetic data only

Everything that is checked in or published from this repository must use
synthetic data:

- automated tests and fixtures
- database seeds
- screenshots, recordings, and demo content
- documentation examples

"Synthetic" means invented names, plate numbers, routes, amounts, and images
that do not correspond to any real person, vehicle, or transaction.

## Machine-specific configuration

Project configuration must not contain absolute paths from a developer's
machine (for example a Windows user profile directory). Anything
machine-specific belongs in an ignored local file.

## If something is committed by mistake

Treat the material as compromised: rotate the credential or key, then remove
the content from history before the branch is shared.
