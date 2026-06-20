// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Normalize a domain for case-insensitive registration, lookup, and resolution.
 * Domains are case-insensitive and must not depend on surrounding whitespace, so
 * the registry and resolver funnel every domain through here before keying on it.
 */
export function normalizeDomain(domain: string): string {
    return domain.trim().toLowerCase();
}
