// SPDX-License-Identifier: AGPL-3.0-only
import { parseAtBoundary } from '@getreceipt/core';
import { z } from 'zod';

/**
 * The wire shapes particuliers.alpiq.fr (Alpiq residential, the Nuxt BFF over OpenCell) returns, plus the
 * Zod schemas that validate them at the trust boundary. These schemas ARE the in-repo contract (#84): they
 * carry the real field names reverse-engineered from the live service (live-validated end-to-end), and are
 * deliberately validated so any drift between this contract and the live service surfaces as a
 * {@link @getreceipt/core!TrustBoundaryError} (the shape mismatch IS the drift detector) rather than a
 * silent mis-parse. The automated e2e harness (#89) is what flips the machine `verificationState`; until it
 * runs against the live service, the source stays `unverified`.
 *
 * No raw capture is committed — fixtures derive from these schemas with synthetic, leak-sentinel values
 * (CONTRIBUTING § captures-stay-local). The adapter REQUESTS the endpoints below and the adapter test MOCKS
 * them from this single {@link ENDPOINTS}/{@link OIDC}/{@link DEFAULT_SEGMENTS} source (anti-circularity,
 * #88): neither side re-types an endpoint.
 */

/**
 * Delimiter that packs an invoice number and its invoice-type code into one
 * {@link @getreceipt/core!ReceiptRef.id} — `list` mints one ref per invoice and `fetch` needs BOTH the
 * invoiceNumber and the invoiceType.code to address the OpenCell download.
 */
export const REF_ID_DELIMITER = '__';

const API_ORIGIN = 'https://particuliers.alpiq.fr';

/**
 * The particuliers.alpiq.fr endpoints — part of the in-repo contract. A single origin serves the whole flow
 * (live-confirmed): the Keycloak realm hosts the OIDC code-flow login, and the Nuxt BFF (`/proxy/dev/*`)
 * proxies the OpenCell calls. `particuliers.alpiq.fr` is a baked public constant (no runtime discovery), so
 * the host-publication gate (#103) treats it as publishable — the source declares `discoveryOnly: true`.
 * The OpenCell billing backend (oc-i.eu) is reached only BEHIND the BFF, never by the client, so it is not
 * a host literal here.
 */
export const ENDPOINTS = {
    apiOrigin: API_ORIGIN,
    /** Keycloak OIDC stage 1: GET the authorization-code login page (seeds the auth cookies; carries the form action). */
    authorize: '/auth/realms/alpiq/protocol/openid-connect/auth',
    /** BFF: POST → `{ customer: { customerAccounts: [{ id }] } }`. The list path is keyed on `customerAccount.id`. */
    user: '/proxy/dev/opencell/user',
} as const;

/**
 * Public OIDC parameters (not secrets) — part of the contract the test asserts. The flow is the Keycloak
 * Authorization-Code variant driven headlessly: `response_type=code`, the code lands on `redirectUri`, and
 * the BFF exchanges it server-side to establish the session cookies. ROPC (`grant_type=password`) is
 * enabled upstream but the BFF ignores the bearer it mints — the code-flow cookie session is the only path.
 */
export const OIDC = {
    clientId: 'alpiq',
    scope: 'openid',
    responseType: 'code',
    /** Where Keycloak bounces the `?code=`; the BFF handles this callback and sets the session cookies. */
    redirectUri: `${API_ORIGIN}/tcm-front/keycloak?role=clients`,
} as const;

/**
 * The opaque OpenCell-BFF route SEGMENTS. They re-validated identically (stable) ⇒ baked as defaults, but
 * the adapter keeps them constructor-overridable ({@link ../adapter!ParticuliersAlpiqFrAdapterOptions}) —
 * a redeploy could rotate them, and a rotated set is re-discoverable from the Nuxt bundle, so an operator
 * can override without a code change.
 */
export const DEFAULT_SEGMENTS = {
    /** Anti-replay mint: GET `/{mint}` → `{ token }`; the single-use `x-rmvcvjakyw` value for ONE protected call. */
    mint: 'lMpfXHCFMA',
    /** GenericAPI list: POST `/proxy/dev/opencell/{list}/{customerAccountId}`. */
    list: 'emp73dd2M48GsCQ',
    /** PDF download: POST `/proxy/dev/opencell/{download}/download`. */
    download: 'qyjNiNlylvHGeQQ',
} as const;

/** The three rotatable OpenCell-BFF route segments (see {@link DEFAULT_SEGMENTS}). */
export interface OpenCellSegments {
    readonly mint: string;
    readonly list: string;
    readonly download: string;
}

/** Anti-replay mint path `/{mint}` (root-level, unauthenticated). */
export function mintPath(segments: OpenCellSegments = DEFAULT_SEGMENTS): string {
    return `/${segments.mint}`;
}

/** GenericAPI list path `/proxy/dev/opencell/{list}/{customerAccountId}` — keyed on `customerAccount.id` (not `customer.id`). */
export function listPath(customerAccountId: string, segments: OpenCellSegments = DEFAULT_SEGMENTS): string {
    return `/proxy/dev/opencell/${segments.list}/${customerAccountId}`;
}

/** PDF download path `/proxy/dev/opencell/{download}/download`. */
export function downloadPath(segments: OpenCellSegments = DEFAULT_SEGMENTS): string {
    return `/proxy/dev/opencell/${segments.download}/download`;
}

/**
 * The GenericAPI nested-entity selector the list POST sends so OpenCell expands invoices (and each invoice's
 * type) under every billing account. Part of the contract — the test sends the same body the adapter does.
 */
export const LIST_REQUEST_BODY = {
    genericFields: [] as readonly string[],
    nestedEntities: ['billingAccounts.invoices', 'billingAccounts.invoices.invoiceType'] as readonly string[],
} as const;

/**
 * A source-supplied token packed into a ref id, constrained so that `invoiceNumber__code` round-trips by
 * splitting on the FIRST delimiter. That requires no embedded `__` AND no edge underscore: an underscore at
 * the edge would merge with the delimiter (e.g. `A_`+`B` and `A`+`_B` both pack to `A___B`), shifting the
 * split and silently colliding distinct pairs. Any value that violates this is treated as drift.
 */
const packableTokenSchema = z
    .string()
    .min(1)
    .refine((value) => !value.includes(REF_ID_DELIMITER) && !value.startsWith('_') && !value.endsWith('_'));

/**
 * A `customerAccount.id` interpolated into the GenericAPI list path. OpenCell ids arrive as a string OR a
 * number, so it is coerced to string, then constrained URL-path-safe (it equals its own
 * `encodeURIComponent`): an id that would reshape the addressed path — drift or injection — is rejected at
 * the boundary rather than silently changing the request.
 */
const customerAccountIdSchema = z
    .union([z.string(), z.number()])
    .transform((value) => String(value))
    .refine((value) => value.length > 0 && value === encodeURIComponent(value));

/**
 * An `invoiceDate` as OpenCell serializes it — epoch **milliseconds** (a number; Jackson's default Date
 * form, live-confirmed end-to-end), which becomes {@link @getreceipt/core!ReceiptRef.issuedAt} via
 * `new Date(ms)`. The refine rejects a value that can't form a real instant (NaN / beyond the Date range),
 * so a shape that is not a usable timestamp surfaces as drift rather than a silent `Invalid Date`.
 */
const invoiceDateSchema = z.number().refine((ms) => !Number.isNaN(new Date(ms).getTime()));

/**
 * The `POST /proxy/dev/opencell/user` response. Only the customer's `customerAccounts[].id` is load-bearing
 * (the list path is keyed on it); other customer fields are intentionally not modeled (Zod ignores unknown
 * keys). At least one customerAccount is expected, but an empty array is not drift — the source simply has
 * no accounts to list.
 */
export const userResponseSchema = z.object({
    customer: z.object({
        customerAccounts: z.array(z.object({ id: customerAccountIdSchema })),
    }),
});

/**
 * One OpenCell `Invoice` in the GenericAPI list. `invoiceNumber` is the identity + download key (shaped
 * `<TYPE>-<digits>`); `invoiceType.code` is the second download key (packed alongside the number into the
 * ref id). `invoiceDate` is the issued date. `amountWithTax` is the headline (incl.-VAT) total, always
 * present. `amountWithoutTax` / `amountTax` / `status` feed the voluntary receipt metadata (#97) and are
 * `.optional()` — a record missing one is not drift. The full OpenCell record carries more keys
 * (`dueDate`, `netToPay`, `pdfFilename`, `id`, …); they are intentionally unmodeled (schematize what the
 * adapter consumes — the monoprix/pro.free precedent).
 */
export const invoiceSchema = z.object({
    invoiceNumber: packableTokenSchema,
    invoiceType: z.object({ code: packableTokenSchema }),
    invoiceDate: invoiceDateSchema,
    amountWithTax: z.number(),
    amountWithoutTax: z.number().optional(),
    amountTax: z.number().optional(),
    status: z.string().optional(),
});

/**
 * The GenericAPI list response: `{ data: { billingAccounts: [{ invoices: [Invoice] }] } }`. A billing
 * account with no invoices may omit `invoices`, so it is `.optional()` (the adapter treats absent as
 * empty); a malformed invoice inside it is still drift.
 */
export const genericListResponseSchema = z.object({
    data: z.object({
        billingAccounts: z.array(z.object({ invoices: z.array(invoiceSchema).optional() })),
    }),
});

/** The anti-replay mint response: `GET /{mint}` → `{ token }` (a fresh single-use `x-rmvcvjakyw` value). */
export const mintResponseSchema = z.object({
    token: z.string().min(1),
});

/**
 * The download response envelope: `{ pdfContent: <base64 PDF> }` (plus `actionStatus`, unmodeled). The
 * base64 is decoded to PDF bytes inside `fetch()` and verified by the `%PDF-` magic — the declared
 * `pdf-download` artifactMode unwraps the base64-in-JSON envelope internally, not a new mode.
 */
export const downloadResponseSchema = z.object({
    pdfContent: z.string().min(1),
});

export type UserResponseDto = z.infer<typeof userResponseSchema>;
export type InvoiceDto = z.infer<typeof invoiceSchema>;
export type GenericListResponseDto = z.infer<typeof genericListResponseSchema>;
export type MintResponseDto = z.infer<typeof mintResponseSchema>;
export type DownloadResponseDto = z.infer<typeof downloadResponseSchema>;

/** Validate the `user` response at the boundary, returning typed data or throwing a secret-safe `TrustBoundaryError`. */
export function parseUserResponse(raw: unknown, boundary: string): UserResponseDto {
    return parseAtBoundary(userResponseSchema, raw, boundary);
}

/** Validate one GenericAPI list response at the boundary, returning typed data or throwing a secret-safe `TrustBoundaryError`. */
export function parseGenericListResponse(raw: unknown, boundary: string): GenericListResponseDto {
    return parseAtBoundary(genericListResponseSchema, raw, boundary);
}

/** Validate the anti-replay mint response at the boundary, returning the token or throwing a secret-safe `TrustBoundaryError`. */
export function parseMintResponse(raw: unknown, boundary: string): MintResponseDto {
    return parseAtBoundary(mintResponseSchema, raw, boundary);
}

/** Validate the download envelope at the boundary, returning the base64 `pdfContent` or throwing a secret-safe `TrustBoundaryError`. */
export function parseDownloadResponse(raw: unknown, boundary: string): DownloadResponseDto {
    return parseAtBoundary(downloadResponseSchema, raw, boundary);
}
