# AGENTS (infra)

These instructions apply to files under `infra/`.

## rDNS geo rules
- Keep `rdns_geo_rules.json` as strict JSON (no comments, no trailing commas).
- Prefer delimiter-bounded location tokens (`.`, `-`, `_`) over raw substrings.
- Prefer provider/domain-scoped rules for ambiguous tokens.
- Avoid exact hostname/service rules unless there is no safer alternative.
- Do not map state-only tokens (for example: `ct`, `md`, `ca`, `fl`, `nj`, `nh`) to city values.
- When adding rules, validate JSON parsing after edits.
