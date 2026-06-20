// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from 'node:child_process';

/** Outcome of probing whether an exact name@version already exists on the registry. */
export interface NpmViewOutcome {
    existed: boolean;
}

/**
 * Decide from `npm view <name>@<version> version`'s exit code + stdout whether that exact version
 * already exists (AC4: a re-run skips it). Non-zero exit (E404) or empty stdout → not published.
 * Querying an EXACT name@version (never @latest) sidesteps npm/cli#6408.
 */
export function parseViewResult(exitCode: number | null, stdout: string): NpmViewOutcome {
    if (exitCode !== 0) {
        return { existed: false };
    }
    return { existed: stdout.trim().length > 0 };
}

/** Convenience predicate over a parsed outcome. */
export function isAlreadyPublished(outcome: NpmViewOutcome): boolean {
    return outcome.existed;
}

/** Impure probe: shell `npm view` and classify via the pure parseViewResult. */
export function queryNpmVersionExists(name: string, version: string): NpmViewOutcome {
    const result = spawnSync('npm', ['view', `${name}@${version}`, 'version'], { encoding: 'utf8' });
    if (result.error) {
        throw new Error(`Failed to run 'npm view ${name}@${version} version': ${result.error.message}`);
    }
    return parseViewResult(result.status, result.stdout ?? '');
}
