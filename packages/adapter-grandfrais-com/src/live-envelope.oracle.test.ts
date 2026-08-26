// SPDX-License-Identifier: AGPL-3.0-only
import { asCredentialContext, Secret } from '@getreceipt/auth';
import { resolveAuthChallenges } from '@getreceipt/core';
import type { AuthHandle, CredentialContext, DateRange } from '@getreceipt/core';
import { http, HttpResponse, server, wireFixture } from '@getreceipt/testing';
import { describe, expect, it } from 'vitest';

import { grandfraisAdapter } from './index.js';
import { ENDPOINTS, listPageSchema, receiptDetailSchema } from './wire.js';
import type { ReceiptDto } from './wire.js';

/**
 * The live-envelope oracle for bff.grandfrais.com's listing (#299, closing #298).
 *
 * Every other grandfrais fixture derives its listing envelope from `listPageSchema` (#88), which is
 * the right anti-circularity rule for the *shape* — and is precisely why #298 stayed invisible for so
 * long on the *cursor name*: the mock emitted the cursor under whatever key the schema declared, so a
 * schema that named the wrong key produced a mock that agreed with it, and the suite was green while
 * the adapter reached 10 of 55 receipts. A test whose fixture follows the contract cannot falsify the
 * contract.
 *
 * So this file deliberately does the opposite for four names, and ONLY these four: the response keys
 * `nextToken` / `cardsId` and the request parameters `paginationToken` / `limit` are hand-pinned
 * string literals, transcribed from an attended live probe of the operator's own account on
 * 2026-08-25 and independent of anything `wire.ts` declares. That is what makes this file capable of
 * FAILING when the contract drifts away from the service. The probe established:
 *
 *  - the listing envelope's top-level keys are `[ cardsId, nextToken, receipts ]` — the cursor is
 *    `nextToken`, and `cardsId` is present and unconsumed;
 *  - the REQUEST parameter that advances the cursor is `paginationToken`, NOT `nextToken` (it advanced
 *    on `?paginationToken=` and did not advance on `?nextToken=`) — the two sides of this contract are
 *    independent facts and the asymmetry is real;
 *  - `limit` is honoured (`100` returned all 55 receipts with no cursor; `500` returned HTTP 400);
 *  - `beginDate` / `endDate` are INERT — a no-parameter control returned the identical page — so the
 *    window is enforced client-side and sending them would state something untrue on the wire.
 *
 * Every value below is synthetic. No capture is committed (CONTRIBUTING § Adding a source: the
 * per-adapter mini-gate → "Captures stay local"); what is transcribed here is the SHAPE the probe
 * observed — field names and parameter names — never anyone's data.
 */

const LOGIN = `${ENDPOINTS.origin}${ENDPOINTS.login}`;
const RECEIPTS = `${ENDPOINTS.origin}${ENDPOINTS.receipts}`;
const DETAIL = `${ENDPOINTS.origin}${ENDPOINTS.receiptDetail}`;

/** Probe-pinned wire names. Hand-authored ON PURPOSE — deriving these from `wire.ts` is the circularity. */
const LIVE_RESPONSE_CURSOR_KEY = 'nextToken';
const LIVE_RESPONSE_UNMODELLED_KEY = 'cardsId';
const LIVE_REQUEST_CURSOR_PARAM = 'paginationToken';
const LIVE_REQUEST_LIMIT_PARAM = 'limit';
/**
 * The page size this adapter must send. Pinned like the names above — read off `COLLECTION` instead and
 * the assertion agrees with whatever the contract says. Probe-confirmed at 100; `500` returned HTTP 400.
 */
const PINNED_LIMIT = '100';

const USERNAME = 'shopper@grandfrais.test';
const PASSWORD = 'gf-oracle-pa55word-LEAK-SENTINEL';
const TOKEN = 'gf-oracle-session-token-LEAK-SENTINEL';
const CARDS_ID = 'gf-oracle-cards-id-LEAK-SENTINEL';

/** The window the walk descends into; the early-stop fixtures sit either side of its `from`. */
const WINDOW: DateRange = { from: new Date('2026-06-01T00:00:00.000Z'), to: new Date('2026-08-31T23:59:59.999Z') };
/** A window wholly in the PAST — every page above it is newer, so reaching it means not stopping early. */
const PAST_WINDOW: DateRange = {
    from: new Date('2020-01-01T00:00:00.000Z'),
    to: new Date('2020-12-31T23:59:59.999Z'),
};

function creds(): CredentialContext {
    return asCredentialContext({ kind: 'password', username: USERNAME, secret: new Secret(PASSWORD) });
}

async function authenticate(): Promise<AuthHandle> {
    return resolveAuthChallenges(await grandfraisAdapter.authenticate(creds()));
}

function loginOk() {
    return http.post(LOGIN, () => HttpResponse.json({ customerId: 'gf-oracle-1', token: TOKEN }, { status: 201 }));
}

function detailsAllSales() {
    return http.get(DETAIL, () =>
        HttpResponse.json(
            wireFixture(receiptDetailSchema, {
                isDownloadablePDFSales: true,
                isDownloadablePDFCreditCard: false,
                items: [],
            }),
        ),
    );
}

function receipt(receiptId: string, checkOutDate: string): ReceiptDto {
    return { receiptId, checkOutDate, shopCode: 'GF-ORACLE-01', shopName: 'Grand Frais Oracle', amount: '12.34' };
}

/** One live-shaped listing page: the receipts array derives from the contract; the two envelope keys around it do not. */
function livePage(receipts: readonly ReceiptDto[], nextToken?: string): Record<string, unknown> {
    return {
        ...wireFixture(listPageSchema, { receipts: [...receipts] }),
        [LIVE_RESPONSE_UNMODELLED_KEY]: CARDS_ID,
        ...(nextToken === undefined ? {} : { [LIVE_RESPONSE_CURSOR_KEY]: nextToken }),
    };
}

/**
 * Serve `pages` in order, recording every listing URL. The cursor the handler HANDS OUT rides under the
 * live response key; the cursor it READS BACK comes off the live request parameter — the asymmetry the
 * probe established, so a fix that renames both sides in step fails here.
 */
function liveListing(pages: readonly Record<string, unknown>[], urls: URL[]) {
    return http.get(RECEIPTS, ({ request }) => {
        const url = new URL(request.url);
        urls.push(url);
        const cursor = url.searchParams.get(LIVE_REQUEST_CURSOR_PARAM);
        const index = cursor === null ? 0 : Number(cursor);
        return HttpResponse.json(pages[index] ?? { receipts: [] });
    });
}

describe('grandfrais.com live-envelope oracle (#299) — pinned to the 2026-08-25 probe, not to wire.ts', () => {
    it('reaches every page when the envelope carries its cursor under the live key `nextToken`', async () => {
        const urls: URL[] = [];
        server.use(
            loginOk(),
            liveListing(
                [
                    livePage(
                        [
                            receipt('gf-p0-a', '2026-08-20T10:00:00.000Z'),
                            receipt('gf-p0-b', '2026-08-10T10:00:00.000Z'),
                        ],
                        '1',
                    ),
                    livePage([receipt('gf-p1-c', '2026-07-15T10:00:00.000Z')]),
                ],
                urls,
            ),
            detailsAllSales(),
        );

        const refs = await grandfraisAdapter.list(await authenticate(), WINDOW);

        // The third receipt lives on page 1 and is reachable ONLY by reading the cursor off `nextToken`.
        expect(refs.map((ref) => ref.id)).toEqual(['gf-p0-a__SALE', 'gf-p0-b__SALE', 'gf-p1-c__SALE']);
        expect(urls).toHaveLength(2);
    });

    it('advances the cursor on the request parameter `paginationToken`, never on `nextToken`', async () => {
        const urls: URL[] = [];
        server.use(
            loginOk(),
            liveListing(
                [
                    livePage([receipt('gf-p0-a', '2026-08-20T10:00:00.000Z')], '1'),
                    livePage([receipt('gf-p1-b', '2026-07-15T10:00:00.000Z')]),
                ],
                urls,
            ),
            detailsAllSales(),
        );

        await grandfraisAdapter.list(await authenticate(), WINDOW);

        expect(urls).toHaveLength(2);
        expect(urls[1]?.searchParams.get(LIVE_REQUEST_CURSOR_PARAM)).toBe('1');
        expect(urls[1]?.searchParams.has(LIVE_RESPONSE_CURSOR_KEY)).toBe(false);
    });

    it('sends the probe-confirmed `limit` and none of the probe-confirmed inert date parameters', async () => {
        const urls: URL[] = [];
        server.use(
            loginOk(),
            liveListing([livePage([receipt('gf-only', '2026-08-20T10:00:00.000Z')])], urls),
            detailsAllSales(),
        );

        await grandfraisAdapter.list(await authenticate(), WINDOW);

        expect(urls[0]?.searchParams.get(LIVE_REQUEST_LIMIT_PARAM)).toBe(PINNED_LIMIT);
        // The window is enforced client-side; the probe's no-parameter control proved these are ignored.
        expect(urls[0]?.searchParams.has('beginDate')).toBe(false);
        expect(urls[0]?.searchParams.has('endDate')).toBe(false);
    });

    it('keeps walking while pages are NEWER than the window — a wholly-past window must not stop at page 0', async () => {
        const urls: URL[] = [];
        // `getreceipt from grandfrais.com --since … --until …` with both bounds in the past is a
        // first-class CLI form, and it is the `skip-continue` arm of core's classification: a page whose
        // oldest receipt sits ABOVE the window is not a reason to stop — the window is still below us.
        // Conflating the two directions ("out of window → stop") drops every receipt the user asked for
        // while the run still reports success, which is #298's failure class exactly.
        server.use(
            loginOk(),
            liveListing(
                [
                    livePage([receipt('gf-recent-a', '2026-08-20T10:00:00.000Z')], '1'),
                    livePage([receipt('gf-recent-b', '2023-04-10T10:00:00.000Z')], '2'),
                    livePage([receipt('gf-target', '2020-06-15T10:00:00.000Z')]),
                ],
                urls,
            ),
            detailsAllSales(),
        );

        const refs = await grandfraisAdapter.list(await authenticate(), PAST_WINDOW);

        expect(urls).toHaveLength(3);
        expect(refs.map((ref) => ref.id)).toEqual(['gf-target__SALE']);
    });

    it("decides the stop on the page's OLDEST receipt, not its newest", async () => {
        const urls: URL[] = [];
        // A page that STRADDLES `from` is the only shape that tells min-selection from max-selection:
        // its oldest is below the window (stop after this page) while its newest is inside it (would
        // keep walking). Every other early-stop fixture has all receipts on one side, where the two
        // agree — so without this case the choice of oldest-vs-newest is unheld.
        server.use(
            loginOk(),
            liveListing(
                [
                    livePage(
                        [
                            receipt('gf-straddle-in', '2026-08-20T10:00:00.000Z'),
                            receipt('gf-straddle-below', '2026-05-10T10:00:00.000Z'),
                        ],
                        '1',
                    ),
                    livePage([receipt('gf-unreached', '2026-07-15T10:00:00.000Z')]),
                ],
                urls,
            ),
            detailsAllSales(),
        );

        const refs = await grandfraisAdapter.list(await authenticate(), WINDOW);

        expect(urls).toHaveLength(1);
        expect(refs.map((ref) => ref.id)).toEqual(['gf-straddle-in__SALE']);
    });

    it('stops the newest-first walk at the page that crosses below the window, never requesting the next one', async () => {
        const urls: URL[] = [];
        server.use(
            loginOk(),
            liveListing(
                [
                    // Page 0: inside the window, cursor present.
                    livePage(
                        [
                            receipt('gf-in-a', '2026-08-20T10:00:00.000Z'),
                            receipt('gf-in-b', '2026-08-10T10:00:00.000Z'),
                        ],
                        '1',
                    ),
                    // Page 1: entirely older than `from` — with strictly-descending pages, page 2 is older still.
                    livePage(
                        [
                            receipt('gf-old-a', '2026-05-20T10:00:00.000Z'),
                            receipt('gf-old-b', '2026-05-10T10:00:00.000Z'),
                        ],
                        '2',
                    ),
                    // Page 2 must never be requested; if it is, its receipt surfaces in the refs below.
                    livePage([receipt('gf-never', '2026-08-15T10:00:00.000Z')]),
                ],
                urls,
            ),
            detailsAllSales(),
        );

        const refs = await grandfraisAdapter.list(await authenticate(), WINDOW);

        expect(urls).toHaveLength(2);
        expect(refs.map((ref) => ref.id)).toEqual(['gf-in-a__SALE', 'gf-in-b__SALE']);
    });
});
