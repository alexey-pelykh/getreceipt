// SPDX-License-Identifier: AGPL-3.0-only
import type { AdapterVerificationState } from '@getreceipt/core';
import { describe, expect, it } from 'vitest';

import { renderSourcesJson, renderSourcesText, type SourcesReport, type SourceView } from './sources-render.js';

function view(
    canonicalDomain: string,
    configured: boolean,
    verificationState: AdapterVerificationState = 'unverified',
    aliasDomains: readonly string[] = [],
    lastVerifiedAt?: string,
): SourceView {
    return {
        canonicalDomain,
        aliasDomains,
        authKind: 'password',
        transportTier: 'http-api',
        artifactMode: 'pdf-download',
        verificationState,
        configured,
        ...(lastVerifiedAt === undefined ? {} : { lastVerifiedAt }),
    };
}

describe('renderSourcesText', () => {
    it('renders a header, capability row, and configured-state per source', () => {
        const text = renderSourcesText({
            profile: 'default',
            sources: [view('shop.example', true), view('store.example', false)],
        });
        expect(text).toContain('sources (profile: default)');
        expect(text).toMatch(/shop\.example.*http-api.*configured/);
        expect(text).toMatch(/store\.example.*not-configured/);
    });

    it('renders declared aliases on a sub-line', () => {
        const text = renderSourcesText({
            profile: 'default',
            sources: [view('shop.example', true, 'unverified', ['www.shop.example'])],
        });
        expect(text).toContain('aliases: www.shop.example');
    });

    it('renders the last-verified date on a sub-line when shipped, and omits it otherwise (#90)', () => {
        const dated = renderSourcesText({
            profile: 'default',
            sources: [view('shop.example', true, 'stale', [], '2026-01-01T00:00:00.000Z')],
        });
        expect(dated).toContain('last verified: 2026-01-01T00:00:00.000Z');

        const undated = renderSourcesText({ profile: 'default', sources: [view('store.example', false)] });
        expect(undated).not.toContain('last verified:');
    });

    it('surfaces ONE advisory line per distinct not-ok verification state', () => {
        const text = renderSourcesText({
            profile: 'default',
            sources: [view('a', true, 'unverified'), view('b', false, 'unverified'), view('c', true, 'stale')],
        });
        // two `unverified` collapse to one advisory; `stale` adds a second, distinct one.
        const advisoryLines = text.split('\n').filter((line) => line.startsWith('⚠'));
        expect(advisoryLines).toHaveLength(2);
    });

    it('emits no advisory when every source is e2e-verified', () => {
        const text = renderSourcesText({ profile: 'default', sources: [view('a', true, 'e2e-verified')] });
        expect(text).not.toContain('⚠');
    });

    it('renders the `session` auth kind for a browser-session source (#174)', () => {
        const text = renderSourcesText({
            profile: 'default',
            sources: [{ ...view('amazon.fr', true), authKind: 'session' }],
        });
        expect(text).toMatch(/amazon\.fr\s+session\s+http-api/);
    });

    it('renders "(no sources registered)" for an empty registry', () => {
        expect(renderSourcesText({ profile: 'default', sources: [] })).toContain('(no sources registered)');
    });
});

describe('renderSourcesJson', () => {
    it('round-trips a structured sources report', () => {
        const report: SourcesReport = {
            profile: 'work',
            sources: [view('shop.example', true, 'unverified', ['www.shop.example'])],
        };
        expect(JSON.parse(renderSourcesJson(report))).toEqual(report);
    });
});
