// SPDX-License-Identifier: AGPL-3.0-only
import { PACKAGE_NAME as CORE } from '@getreceipt/core';

/** Placeholder CLI surface. Real commands (from/all/sources/status/login/logout) land in later issues. */
export function describeCli(): string {
    return `@getreceipt/cli (backed by ${CORE})`;
}
