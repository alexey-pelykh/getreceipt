// SPDX-License-Identifier: AGPL-3.0-only
import type { GetReceiptConfig } from '@getreceipt/auth';
import { describe, expect, it } from 'vitest';

import {
    buildValidateVerdict,
    DEFAULT_PROFILE,
    ProfileNotFoundError,
    renderConfigPathText,
    renderConfigShow,
    renderValidateJson,
    renderValidateText,
    resolveActiveProfile,
} from './config-render.js';

// A non-secret-shaped literal (matches the repo's committed fake-sentinel style, so the
// clean-tree leakage scan never flags this file) — used to prove inline literals are masked.
const INLINE_LITERAL = 'hunter2-do-not-leak';

function configWith(profiles: GetReceiptConfig['profiles']): GetReceiptConfig {
    return { profiles };
}

describe('resolveActiveProfile', () => {
    it('defaults to the default profile', () => {
        expect(resolveActiveProfile(undefined)).toBe(DEFAULT_PROFILE);
    });

    it('honors an explicit profile', () => {
        expect(resolveActiveProfile('work')).toBe('work');
    });
});

describe('renderConfigShow', () => {
    const config = configWith({
        default: {
            sources: {
                'free.fr': {
                    kind: 'password',
                    username: 'alice@free.fr',
                    secret: { ref: 'op://Personal/free.fr/password' },
                },
                'amazon.fr': { kind: 'api-token', secret: INLINE_LITERAL },
            },
        },
        work: {
            sources: { 'corp.example': { kind: 'password', secret: { ref: 'WORK_PW' } } },
        },
    });

    it('masks inline literals and shows references unresolved', () => {
        const output = renderConfigShow(config, 'default');

        // The literal never reaches output; the masked placeholder does.
        expect(output).not.toContain(INLINE_LITERAL);
        expect(output).toContain('[redacted]');
        // The op:// reference is shown verbatim and UNRESOLVED (the ref string, not a fetched value).
        expect(output).toContain('op://Personal/free.fr/password');
        // Non-secret structure is preserved.
        expect(output).toContain('free.fr');
        expect(output).toContain('username: alice@free.fr');
        expect(output).toContain('kind: password');
    });

    it('selects the requested profile', () => {
        const output = renderConfigShow(config, 'work');
        expect(output).toContain('corp.example');
        expect(output).toContain('WORK_PW');
        // The default profile's sources are not present.
        expect(output).not.toContain('free.fr');
    });

    it('throws ProfileNotFoundError (naming available profiles, no secrets) for an unknown profile', () => {
        let caught: unknown;
        try {
            renderConfigShow(config, 'missing');
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(ProfileNotFoundError);
        expect((caught as ProfileNotFoundError).message).toContain('missing');
        expect((caught as ProfileNotFoundError).message).toContain('default');
        expect((caught as ProfileNotFoundError).message).toContain('work');
        expect((caught as ProfileNotFoundError).message).not.toContain(INLINE_LITERAL);
    });
});

describe('buildValidateVerdict', () => {
    it('marks a successful load valid and maps warnings', () => {
        const verdict = buildValidateVerdict('/cfg.yaml', {
            ok: true,
            warnings: [
                { code: 'inline-credential', path: 'profiles.default.sources.x.auth.secret', message: 'use a ref' },
            ],
        });
        expect(verdict.valid).toBe(true);
        expect(verdict.error).toBeNull();
        expect(verdict.warnings).toEqual([
            { code: 'inline-credential', path: 'profiles.default.sources.x.auth.secret', message: 'use a ref' },
        ]);
    });

    it('marks a failed load invalid with the error message', () => {
        const verdict = buildValidateVerdict('/cfg.yaml', { ok: false, message: 'unknown auth kind' });
        expect(verdict.valid).toBe(false);
        expect(verdict.warnings).toEqual([]);
        expect(verdict.error).toEqual({ message: 'unknown auth kind' });
    });
});

describe('renderValidateText', () => {
    it('reports success on out and warnings on err for a valid file', () => {
        const { out, err } = renderValidateText(
            buildValidateVerdict('/cfg.yaml', {
                ok: true,
                warnings: [{ code: 'inline-credential', path: 'p', message: 'inline credential at p' }],
            }),
        );
        expect(out).toContain('valid');
        expect(out).toContain('/cfg.yaml');
        expect(err).toContain('inline credential at p');
    });

    it('reports the error on err and nothing on out for an invalid file', () => {
        const { out, err } = renderValidateText(buildValidateVerdict('/cfg.yaml', { ok: false, message: 'bad yaml' }));
        expect(out).toBe('');
        expect(err).toContain('bad yaml');
    });
});

describe('renderValidateJson', () => {
    it('round-trips the verdict to JSON', () => {
        const verdict = buildValidateVerdict('/cfg.yaml', { ok: false, message: 'bad yaml' });
        expect(JSON.parse(renderValidateJson(verdict))).toEqual(verdict);
    });
});

describe('renderConfigPathText', () => {
    it('reports path, profile, and existence', () => {
        const text = renderConfigPathText({ path: '/home/.getreceipt.yaml', profile: 'work', exists: true });
        expect(text).toContain('/home/.getreceipt.yaml');
        expect(text).toContain('work');
        expect(text).toContain('yes');
    });

    it('renders existence as no when the file is absent', () => {
        expect(renderConfigPathText({ path: '/x.yaml', profile: 'default', exists: false })).toContain('no');
    });
});
