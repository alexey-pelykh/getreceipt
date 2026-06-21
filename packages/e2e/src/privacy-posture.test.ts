// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Privacy posture invariant (issue #29).
 *
 * PRIVACY.md commits getreceipt to a no-telemetry / local-only / data-controller posture. This suite
 * makes that posture ship as enforced text rather than as a promise:
 *
 *  - PRIVACY.md exists and carries the load-bearing claims (AC #1).
 *  - The README surfaces a Privacy section that links PRIVACY.md (AC #2).
 *  - No workspace package depends on a telemetry / analytics / tracking / crash-reporting library
 *    (AC #3 — "the no-telemetry claims match the code") and the Future-telemetry design rule's
 *    gate: a PR that adds such a dependency fails this suite.
 *
 * Sibling to disclaimer-posture.test.ts (issue #10), which enforces the unofficial/personal-use
 * posture the same way.
 */

// READMEs wrap prose and prefix blockquote lines with `> `, so a clause can straddle a `\n> `
// boundary. Strip blockquote markers and collapse all whitespace before substring assertions.
// (Bold `**` markers are left intact — asserted substrings sit inside or across them.)
function flatten(markdown: string): string {
    return markdown.replace(/^\s*>\s?/gm, '').replace(/\s+/g, ' ');
}

function findWorkspaceRoot(): string {
    let dir = fileURLToPath(new URL('.', import.meta.url));
    while (!existsSync(join(dir, 'pnpm-workspace.yaml'))) {
        const parent = dirname(dir);
        if (parent === dir) {
            throw new Error('workspace root (pnpm-workspace.yaml) not found above the test file');
        }
        dir = parent;
    }
    return dir;
}

const workspaceRoot = findWorkspaceRoot();

describe('PRIVACY.md carries the load-bearing privacy claims (AC #1)', () => {
    const path = join(workspaceRoot, 'PRIVACY.md');

    it('exists at the repository root', () => {
        expect(existsSync(path)).toBe(true);
    });

    const privacy = existsSync(path) ? flatten(readFileSync(path, 'utf8')) : '';

    // Each claim from the issue's "In scope" list, asserted as a distinctive substring.
    it.each([
        ['no-telemetry', 'phones home to no one'],
        ['local-only', 'on your machine'],
        ['maintainer holds nothing', 'maintainer never receives, sees, or stores your data'],
        ['network scope', 'Network scope'],
        ['credentials stay local', "never leave your machine except to the target service's own login"],
        ['data controller', 'You are the data controller'],
        ['maintainer not controller/processor', 'neither a controller nor a processor'],
        ['future-telemetry rule: opt-in', 'opt-in'],
        ['future-telemetry rule: gating', 'gating rule on any future change'],
        ['out of scope: per-service practices', 'Per-service privacy practices'],
    ])('states the "%s" posture', (_label, claim) => {
        expect(privacy).toContain(claim);
    });
});

describe('the README surfaces a Privacy section that links PRIVACY.md (AC #2)', () => {
    const raw = readFileSync(join(workspaceRoot, 'README.md'), 'utf8');
    const flat = flatten(raw);

    it('has a "## Privacy" heading', () => {
        expect(raw).toMatch(/^##\s+Privacy\s*$/m);
    });

    it('links to PRIVACY.md', () => {
        expect(raw).toContain('](PRIVACY.md)');
    });

    it('summarizes the collects-nothing / data-controller posture', () => {
        expect(flat).toContain('collects nothing');
        expect(flat).toContain('data controller');
    });
});

/**
 * The no-telemetry claim, enforced against the dependency graph (AC #3 + Future-telemetry gate).
 *
 * Distinctive markers of phone-home SDKs (product analytics, crash/error reporting, APM, session
 * replay). A dependency whose name contains any marker has no legitimate place in a local-only tool.
 *
 * Deliberately a curated tripwire, not an exhaustive firewall: the real guarantee is the local-only
 * architecture (no central service exists) plus code review and the "watch the network" check in
 * PRIVACY.md. This list forces a conscious decision if a well-known telemetry SDK is ever added.
 *
 * NOTE: general-purpose HTTP clients (axios, undici, got, …) are intentionally NOT listed — the
 * fetch path legitimately needs one to reach the *target service*. The claim is "no phone-home to
 * the maintainer or any aggregator", not "no HTTP".
 */
const TELEMETRY_MARKERS = [
    'telemetry',
    'analytics',
    'posthog',
    'mixpanel',
    'amplitude',
    'sentry',
    'bugsnag',
    'rollbar',
    'datadog',
    'dd-trace',
    'newrelic',
    'new-relic',
    'elastic-apm',
    'appinsights',
    'applicationinsights',
    'logrocket',
    'fullstory',
    'hotjar',
    'countly',
    'matomo',
    'plausible',
    'mparticle',
    'snowplow',
    'rudderstack',
    'rudder-sdk',
    'keen-tracking',
] as const;

function telemetryMarker(depName: string): string | null {
    const name = depName.toLowerCase();
    return TELEMETRY_MARKERS.find((marker) => name.includes(marker)) ?? null;
}

interface Manifest {
    name?: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
}

function allDependencyNames(manifest: Manifest): string[] {
    return [
        ...Object.keys(manifest.dependencies ?? {}),
        ...Object.keys(manifest.devDependencies ?? {}),
        ...Object.keys(manifest.peerDependencies ?? {}),
        ...Object.keys(manifest.optionalDependencies ?? {}),
    ];
}

const manifests = [
    { label: 'root', path: join(workspaceRoot, 'package.json') },
    ...readdirSync(join(workspaceRoot, 'packages'), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => ({ label: entry.name, path: join(workspaceRoot, 'packages', entry.name, 'package.json') }))
        .filter((entry) => existsSync(entry.path)),
].sort((a, b) => a.label.localeCompare(b.label));

describe('no workspace package depends on a telemetry library (AC #3 + Future-telemetry gate)', () => {
    it('discovered the full manifest set (not a vacuous pass)', () => {
        // root + the eight packages/ manifests. A floor, so adding a package keeps the gate honest;
        // a glob failure that returned 0–1 manifests would trip this instead of passing silently.
        expect(manifests.length).toBeGreaterThanOrEqual(8);
    });

    describe.each(manifests)('$label', ({ path }) => {
        it('has no telemetry / analytics / crash-reporting dependency', () => {
            const manifest = JSON.parse(readFileSync(path, 'utf8')) as Manifest;
            const offenders = allDependencyNames(manifest)
                .map((dep) => ({ dep, marker: telemetryMarker(dep) }))
                .filter((hit): hit is { dep: string; marker: string } => hit.marker !== null);
            expect(offenders, `telemetry-shaped dependencies in ${path}: ${JSON.stringify(offenders)}`).toEqual([]);
        });
    });
});
