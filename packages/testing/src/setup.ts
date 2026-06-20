// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, afterEach, beforeAll } from 'vitest';

import { server } from './index.js';

// Registered once per package test run via Vitest `setupFiles`.
beforeAll(() => {
    server.listen({ onUnhandledRequest: 'error' });
});

afterEach(() => {
    server.resetHandlers();
});

afterAll(() => {
    server.close();
});
