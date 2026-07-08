# fixtures/

Test fixtures. Each file documents its contract here.

## risk-classifier.fixture.json

The versioned contract for the file-path risk classifier
(`packages/cli/src/lib/classifier.ts`). The classifier maps a repository file
path to one of nine coarse risk categories:

`schema_or_migration`, `auth_or_permission`, `external_integration`,
`llm_prompt`, `outbox_or_handler`, `api_contract`, `cli_or_tooling`, `docs`,
`unknown`.

The fixture is a single JSON object:

- `version` (integer): bump on any taxonomy change.
- `categories` (string[]): the declared taxonomy; must equal `ALL_CATEGORIES`
  exported from the classifier.
- `cases` (`{ path, category }[]`): each path and the category the default
  ruleset must assign it. Cases use GENERIC paths (common conventions), not any
  one repo's internal layout.

`packages/cli/test/lib/classifier.spec.ts` is the drift guard. It asserts:

1. every `case` classifies to its declared `category`,
2. the fixture is versioned,
3. `categories` equals the code-side `ALL_CATEGORIES`,
4. every non-`unknown` category is exercised by at least one case.

If any of these fail, the ruleset and the fixture have drifted. The fix is to
bring them back into sync (update the ruleset or the fixture together), not to
relax the test.

To add a path: add a `{ "path": ..., "category": ... }` case and confirm the
default rules already match. If it needs a new rule, add the rule to
`DEFAULT_RULES`, add the case, and (if it introduces a new category) extend the
`RiskCategory` union + `ALL_CATEGORIES` and bump `version`.
