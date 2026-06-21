// SPDX-License-Identifier: AGPL-3.0-only
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Consent state is non-secret, but pinned owner-only to match the `~/.getreceipt/` posture (sessions are 0600/0700). */
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/**
 * A recorded runtime consent acknowledgment (#32): the user affirmed the consent terms once.
 * Non-secret — it records THAT consent was given and to which terms version, never any credential
 * or account detail.
 */
export interface ConsentRecord {
    /** ISO-8601 timestamp of when consent was acknowledged. */
    readonly acceptedAt: string;
    /** The CONSENT_VERSION the user acknowledged; a newer terms version is treated as not-yet-given. */
    readonly version: number;
}

/**
 * Persistence port for the consent record — the seam the consent gate writes through, and the
 * contract a test double satisfies. Sibling of {@link SessionStore}: both persist `~/.getreceipt/`
 * state behind an injectable port.
 */
export interface ConsentStore {
    /**
     * Load the recorded acknowledgment, or `undefined` when none is stored OR the stored bytes are
     * unreadable/malformed/partial — fail-secure: a damaged record is treated as not-yet-given so
     * the gate re-prompts rather than trusting corruption.
     */
    load(): Promise<ConsentRecord | undefined>;
    /** Persist an acknowledgment, creating the parent directory if needed. Written atomically. */
    save(record: ConsentRecord): Promise<void>;
}

/** Resolve the default consent-record path: `~/.getreceipt/consent.json` — sibling of the sessions dir and the `~/.getreceipt.yaml` config. */
export function defaultConsentPath(): string {
    return join(homedir(), '.getreceipt', 'consent.json');
}

function isConsentRecord(value: unknown): value is ConsentRecord {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const candidate = value as Record<string, unknown>;
    return typeof candidate.acceptedAt === 'string' && typeof candidate.version === 'number';
}

/**
 * A {@link ConsentStore} backed by a plain JSON file. The record is non-secret, so it is stored in
 * cleartext (unlike the encrypted session store) — but written `0600` to match the directory posture.
 *
 *  - {@link load} returns `undefined` for ANY unreadable/malformed/partial state (missing file, bad
 *    JSON, wrong shape) so a corrupt or half-written record fails secure: the gate re-prompts.
 *  - {@link save} writes atomically (temp file + `rename`) so a crash or a concurrent run can never
 *    leave a half-written record that {@link load} would then have to reject.
 */
export class FileConsentStore implements ConsentStore {
    readonly #path: string;

    constructor(path: string = defaultConsentPath()) {
        this.#path = path;
    }

    async load(): Promise<ConsentRecord | undefined> {
        let text: string;
        try {
            text = await readFile(this.#path, 'utf8');
        } catch {
            return undefined; // missing or unreadable ⇒ not-yet-given
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(text);
        } catch {
            return undefined; // malformed / partial JSON ⇒ not-yet-given (fail-secure)
        }
        return isConsentRecord(parsed) ? parsed : undefined;
    }

    async save(record: ConsentRecord): Promise<void> {
        await mkdir(dirname(this.#path), { recursive: true, mode: DIR_MODE });
        // Atomic publish: write a per-process sibling temp file, then rename over the target. A crash
        // leaves either the old record or none — never a half-written one the fail-secure reader rejects.
        const tmp = `${this.#path}.${process.pid}.tmp`;
        await writeFile(tmp, `${JSON.stringify(record)}\n`, { mode: FILE_MODE });
        await bestEffortChmod(tmp, FILE_MODE); // pin perms in case umask cleared bits at create time
        await rename(tmp, this.#path);
    }
}

/** chmod that never throws — the record is non-secret and chmod is a no-op on Windows, so a failure here must not abort the run. */
async function bestEffortChmod(path: string, mode: number): Promise<void> {
    try {
        await chmod(path, mode);
    } catch {
        // ignore: perms are defense-in-depth on a non-secret file, not a correctness requirement
    }
}

/** Build the production consent store for a path (defaults to {@link defaultConsentPath}). */
export function createConsentStore(path: string = defaultConsentPath()): ConsentStore {
    return new FileConsentStore(path);
}
