// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { createSessionStore } from '@getreceipt/auth';
import type { SessionStore } from '@getreceipt/auth';

/** The directory the encrypted-file session store reads from — sibling of the `~/.getreceipt.yaml` config. */
export function defaultSessionsDir(): string {
    return join(homedir(), '.getreceipt', 'sessions');
}

/**
 * The production session store for the verbs that WRITE or CLEAR sessions (`login` / `logout`):
 * the encrypted-file store under {@link defaultSessionsDir}, whose directory is created on first
 * save — so it is usable before any session exists. (Read-only paths keep a null store until the
 * directory exists; they never need to create it — see {@link defaultReadableSessionStore}.)
 */
export function defaultWritableSessionStore(): SessionStore {
    return createSessionStore({ dir: defaultSessionsDir() });
}

/** A session store that holds nothing — every read reports absent. Used before any session has been persisted. */
const NULL_SESSION_STORE: SessionStore = {
    load: () => Promise.resolve(undefined),
    save: () => Promise.resolve(),
    delete: () => Promise.resolve(),
};

/**
 * The production session store for the paths that only READ sessions — `status`, and the opt-in
 * collect-path reuse (#189): the encrypted-file store under {@link defaultSessionsDir} once it exists,
 * else a {@link NULL_SESSION_STORE}. The directory is created by the `login` ceremony (#17), so until a
 * first login there are no sessions: every read honestly reports absent and the collect path imports
 * fresh (the basic per-run path, unchanged). `login` is thus the opt-in trigger for at-rest reuse — and
 * because the store is resolved per CLI invocation, a login in one run is visible to the next.
 */
export function defaultReadableSessionStore(): SessionStore {
    const dir = defaultSessionsDir();
    return existsSync(dir) ? createSessionStore({ dir }) : NULL_SESSION_STORE;
}
