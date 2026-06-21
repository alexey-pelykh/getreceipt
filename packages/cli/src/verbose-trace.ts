// SPDX-License-Identifier: AGPL-3.0-only
import { scanForSecrets } from '@getreceipt/auth';
import type { SourceAdapter } from '@getreceipt/core';

const PREFIX = '[getreceipt]';
const SUPPRESSED = `${PREFIX} <diagnostic line suppressed: secret-shaped value>`;

/**
 * Route a diagnostic line through the #7 secret fence: drop the whole line if it carries
 * a secret-shaped value. Lines are already built only from non-credential data, so this is
 * a backstop against an unexpected leak path (e.g. a receipt id that happens to match a
 * credential format) — never the first line of defense.
 */
function fence(line: string): string {
    return scanForSecrets([{ path: 'verbose', content: line }]).length > 0 ? SUPPRESSED : line;
}

/**
 * Wrap an adapter so each pipeline stage (authenticate → list → fetch) emits a fenced
 * diagnostic line via `emit` — the `--verbose`/`--debug` trace that makes a broken source
 * debuggable. The credential is never read here: lines carry only stage names, the window,
 * receipt counts, and receipt ids, so no secret can reach the output by construction (the
 * {@link fence} is the backstop). Each emitted line is newline-terminated.
 */
export function traceAdapter(adapter: SourceAdapter, emit: (line: string) => void): SourceAdapter {
    const domain = adapter.descriptor.canonicalDomain;
    const log = (line: string): void => emit(`${fence(`${PREFIX} ${line}`)}\n`);
    return {
        descriptor: adapter.descriptor,
        async authenticate(credentials) {
            log(`authenticate: start (${domain}, kind=${adapter.descriptor.authKind})`);
            const handle = await adapter.authenticate(credentials);
            log('authenticate: ok');
            return handle;
        },
        async list(auth, range) {
            log(`list: window ${range.from.toISOString()} .. ${range.to.toISOString()}`);
            const refs = await adapter.list(auth, range);
            log(`list: ${refs.length} receipt(s)`);
            return refs;
        },
        async fetch(auth, ref) {
            log(`fetch: ${ref.id}`);
            const artifact = await adapter.fetch(auth, ref);
            log(`fetch: ${ref.id} ok`);
            return artifact;
        },
    };
}
