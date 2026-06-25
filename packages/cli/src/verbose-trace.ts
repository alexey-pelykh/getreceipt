// SPDX-License-Identifier: AGPL-3.0-only
import { scanForSecrets } from '@getreceipt/auth';
import { formatChallengeEvent, isAuthChallengeRequired } from '@getreceipt/core';
import type { ChallengeObserver, SourceAdapter } from '@getreceipt/core';

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
            const result = await adapter.authenticate(credentials);
            // authenticate() may return an interactive challenge rather than a session (#133) — "ok" would
            // be a lie there. Report the stage honestly; the challenge lifecycle itself is traced via the
            // observer (#142). The challenge type is a redaction-safe closed enum.
            log(
                isAuthChallengeRequired(result)
                    ? `authenticate: challenge issued (${result.challenge.type})`
                    : 'authenticate: ok',
            );
            return result;
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

/**
 * A {@link ChallengeObserver} that streams each challenge-lifecycle line (emitted / resolved / degraded)
 * to `emit` — the `--verbose` challenge trace (#142), the lifecycle sibling of {@link traceAdapter}'s
 * stage trace. Each line is built only from the event's redaction-safe fields ({@link formatChallengeEvent}:
 * source + type + mode/reason) and routed through the same {@link fence} backstop; the resolved code never
 * reaches it by construction. Newline-terminated, like the adapter trace.
 */
export function traceChallengeObserver(emit: (line: string) => void): ChallengeObserver {
    return (event) => emit(`${fence(`${PREFIX} ${formatChallengeEvent(event)}`)}\n`);
}
