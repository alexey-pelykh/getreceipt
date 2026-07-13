// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Reduce one identity component to a filesystem-safe directory segment: any char outside `[A-Za-z0-9._-]`
 * (a path separator, whitespace, or a `:` key separator) becomes `-`, so the joined segment can never
 * traverse out of its parent dir or be Windows-illegal. Returns `null` for a component that is empty or
 * reduces to nothing meaningful (`.`, `..`, all-separators) — which would collapse the path onto the parent.
 *
 * The single source of truth for the safe-segment rule, shared by the getreceipt-OWNED browser-profile dirs
 * ({@link @getreceipt/auth!ownedProfileDir}, #253) and the opt-in output `label` namespace (#266). Each caller
 * maps `null` onto its own error type (an {@link @getreceipt/auth!OwnedProfileError} vs a value-free
 * {@link @getreceipt/auth!ConfigError}), so this stays a pure predicate with no domain-specific throw. Lives in
 * its own module so `config.ts` can reuse it without importing `owned-profile.ts` (which imports `config.ts`).
 */
export function sanitizePathSegment(value: string): string | null {
    const safe = value.replace(/[^a-zA-Z0-9._-]/g, '-');
    if (safe === '' || safe === '.' || safe === '..' || /^-+$/.test(safe)) {
        return null;
    }
    return safe;
}
