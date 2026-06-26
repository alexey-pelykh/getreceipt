// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';

import { renderStatusJson, renderStatusText, type SourceSessionView, type StatusReport } from './status-render.js';

function view(overrides: Partial<SourceSessionView> = {}): SourceSessionView {
    return {
        source: 'shop.example',
        requested: 'shop.example',
        authKind: 'password',
        registered: true,
        session: 'none',
        ...overrides,
    };
}

describe('renderStatusText', () => {
    it('renders a header and one row per source with its session state', () => {
        const text = renderStatusText({ profile: 'default', sources: [view({ session: 'none' })] });
        expect(text).toContain('status (profile: default)');
        expect(text).toMatch(/shop\.example.*password.*session: none/);
    });

    it('renders the expiry for a session that declares one', () => {
        const text = renderStatusText({
            profile: 'default',
            sources: [view({ session: 'valid', expiresAt: '2024-12-01T00:00:00.000Z' })],
        });
        expect(text).toContain('session: valid');
        expect(text).toContain('expires: 2024-12-01');
    });

    it('marks an unregistered source [unregistered]', () => {
        const text = renderStatusText({
            profile: 'default',
            sources: [view({ source: 'ghost.example', requested: 'ghost.example', registered: false })],
        });
        expect(text).toContain('[unregistered]');
    });

    it('renders a non-secret reason on a sub-line', () => {
        const text = renderStatusText({
            profile: 'default',
            sources: [view({ session: 'expired', reason: 'stored session expired at 2024-01-01T00:00:00.000Z' })],
        });
        expect(text).toContain('session: expired');
        expect(text).toContain('    stored session expired at 2024-01-01T00:00:00.000Z');
    });

    it('renders the `session` auth kind for a browser-session source (#174)', () => {
        const text = renderStatusText({
            profile: 'default',
            sources: [view({ source: 'amazon.fr', requested: 'amazon.fr', authKind: 'session' })],
        });
        expect(text).toMatch(/amazon\.fr\s+session\s+session: none/);
    });

    it('renders "(no sources configured)" for an empty profile', () => {
        expect(renderStatusText({ profile: 'default', sources: [] })).toContain('(no sources configured)');
    });
});

describe('renderStatusJson', () => {
    it('round-trips a structured status report', () => {
        const report: StatusReport = {
            profile: 'default',
            sources: [
                view({ session: 'valid', expiresAt: '2024-12-01T00:00:00.000Z' }),
                view({ source: 'ghost.example', requested: 'ghost.example', registered: false, session: 'none' }),
            ],
        };
        expect(JSON.parse(renderStatusJson(report))).toEqual(report);
    });
});
