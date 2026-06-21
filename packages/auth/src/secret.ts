// SPDX-License-Identifier: AGPL-3.0-only

/** What every implicit serialization of a {@link Secret} yields instead of the value. */
const REDACTED = '[redacted]';

/**
 * A resolved secret value, wrapped so it cannot be accidentally serialized into
 * logs, errors, JSON, or manifests. The raw value is reachable ONLY via
 * {@link Secret.expose}: `String(secret)`, `` `${secret}` ``, `JSON.stringify`,
 * and `console.log` / `util.inspect` each yield a fixed redaction placeholder.
 *
 * The value lives in a true `#private` field, so spreading (`{ ...secret }`) and
 * `Object.keys` cannot reach it either — there is no enumerable property to leak.
 */
export class Secret {
    readonly #value: string;

    constructor(value: string) {
        this.#value = value;
    }

    /**
     * Reveal the underlying secret. Call this ONLY at the point of use (handing
     * the value to an auth driver) — never to log, serialize, or store it.
     */
    expose(): string {
        return this.#value;
    }

    /** Redacted — `String(secret)` and template literals never reveal the value. */
    toString(): string {
        return REDACTED;
    }

    /** Redacted — `JSON.stringify(secret)` never reveals the value. */
    toJSON(): string {
        return REDACTED;
    }

    /** Redacted — `console.log` / `util.inspect` never reveal the value. */
    [Symbol.for('nodejs.util.inspect.custom')](): string {
        return REDACTED;
    }
}
