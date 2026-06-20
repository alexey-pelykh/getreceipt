// SPDX-License-Identifier: AGPL-3.0-only
import type { AuthKind } from '@getreceipt/core';

import { UnsupportedAuthKindError } from './errors.js';

/**
 * An auth driver satisfies ONE {@link AuthKind}. Concrete drivers (password,
 * oauth2, …) land in later issues; this interface is the seam the orchestrator
 * selects against, so those drivers slot in without changing the orchestrator.
 */
export interface AuthDriver {
    readonly kind: AuthKind;
}

/**
 * Selects the auth driver matching a source's declared {@link AuthKind}. Drivers
 * are registered up front (constructor) or later via {@link AuthOrchestrator.register};
 * selection is purely by kind.
 */
export class AuthOrchestrator {
    readonly #byKind = new Map<AuthKind, AuthDriver>();

    constructor(drivers: readonly AuthDriver[] = []) {
        for (const driver of drivers) {
            this.register(driver);
        }
    }

    /** Register (or replace) the driver for a given auth kind. */
    register(driver: AuthDriver): void {
        this.#byKind.set(driver.kind, driver);
    }

    /** Whether a driver is registered for the given auth kind. */
    supports(kind: AuthKind): boolean {
        return this.#byKind.has(kind);
    }

    /**
     * Select the driver for an auth kind.
     * @throws {@link UnsupportedAuthKindError} if no driver is registered for it.
     */
    selectDriver(kind: AuthKind): AuthDriver {
        const driver = this.#byKind.get(kind);
        if (driver === undefined) {
            throw new UnsupportedAuthKindError(kind);
        }
        return driver;
    }
}
