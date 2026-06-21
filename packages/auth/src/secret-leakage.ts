// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A file the scanner inspects: its path (for reporting) and full text content. The
 * content is passed in so {@link scanForSecrets} stays pure — discovery (walking the
 * filesystem) is the caller's job, exactly as the e2e-coverage lint keeps its
 * decision logic independent of HOW adapters are discovered.
 */
export interface ScannableFile {
    readonly path: string;
    readonly content: string;
}

/** One secret-shaped match: WHERE it is and WHICH rule fired — never the matched value itself. */
export interface SecretLeak {
    readonly path: string;
    /** 1-based line number of the match. */
    readonly line: number;
    /** Identifier of the rule that fired, e.g. `aws-access-key-id`. */
    readonly rule: string;
}

interface SecretRule {
    readonly id: string;
    readonly pattern: RegExp;
}

/**
 * High-precision rules for well-known credential formats. Deliberately NOT a generic
 * entropy / keyword heuristic: this repo intentionally commits fake-secret sentinels
 * in fixtures and tests (`hunter2-…`, `TOPSECRET`, `sk-LEAK-SENTINEL-…`), so a fuzzy
 * scanner would false-positive on the clean tree. Each rule matches a shape that does
 * not occur by accident — a genuine leak of that credential class. Extend with new
 * formats as needed; every rule must stay false-positive-free against the committed
 * tree, which the clean-tree test enforces.
 */
const SECRET_RULES: readonly SecretRule[] = [
    // PEM private-key block (RSA / EC / OpenSSH / PKCS#8 all share the "PRIVATE KEY-----" trailer).
    { id: 'pem-private-key', pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/ },
    { id: 'aws-access-key-id', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
    { id: 'github-token', pattern: /\bghp_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{82}\b/ },
    { id: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
    { id: 'slack-token', pattern: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/ },
    { id: 'stripe-secret-key', pattern: /\b(?:sk|rk)_live_[0-9A-Za-z]{24,}\b/ },
];

/**
 * Scan files for committed secret-shaped values, one {@link SecretLeak} per match.
 * Pure (no I/O): pass file contents in. The result names location + rule only —
 * never the matched value, so the scanner's own output cannot become a leak.
 */
export function scanForSecrets(files: readonly ScannableFile[]): readonly SecretLeak[] {
    const leaks: SecretLeak[] = [];
    for (const file of files) {
        file.content.split('\n').forEach((text, index) => {
            for (const rule of SECRET_RULES) {
                if (rule.pattern.test(text)) {
                    leaks.push({ path: file.path, line: index + 1, rule: rule.id });
                }
            }
        });
    }
    return leaks;
}

/**
 * Thrown by {@link assertNoSecretLeaks} when one or more secret-shaped values are
 * found. Its message lists each location and rule — and, by construction, NEVER the
 * matched value: the leak detector must not itself become a leak.
 */
export class SecretLeakDetectedError extends Error {
    override readonly name = 'SecretLeakDetectedError';

    constructor(readonly leaks: readonly SecretLeak[]) {
        super(
            `secret-shaped value(s) detected in ${leaks.length} location(s): ` +
                leaks.map((leak) => `${leak.path}:${leak.line} (${leak.rule})`).join(', '),
        );
    }
}

/**
 * Assert no file carries a secret-shaped value; throw {@link SecretLeakDetectedError}
 * listing every match otherwise. The throwing form a lint / CI gate calls.
 */
export function assertNoSecretLeaks(files: readonly ScannableFile[]): void {
    const leaks = scanForSecrets(files);
    if (leaks.length > 0) {
        throw new SecretLeakDetectedError(leaks);
    }
}
