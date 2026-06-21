// SPDX-License-Identifier: AGPL-3.0-only
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
 * save — so it is usable before any session exists. (`status`, which only READS, keeps a null
 * store until the directory exists; it never needs to create it.)
 */
export function defaultWritableSessionStore(): SessionStore {
    return createSessionStore({ dir: defaultSessionsDir() });
}
