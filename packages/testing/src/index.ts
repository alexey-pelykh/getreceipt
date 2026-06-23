// SPDX-License-Identifier: AGPL-3.0-only
import { setupServer } from 'msw/node';

/**
 * Shared MSW server instance. Tests register per-test handlers via `server.use(...)`;
 * the lifecycle in `./setup.ts` resets them between tests.
 */
export const server = setupServer();

export { http, HttpResponse } from 'msw';
export { findHandAuthoredEndpointLiterals, wireFixture, WireFixtureError } from './wire-contract.js';
