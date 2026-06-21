// SPDX-License-Identifier: AGPL-3.0-only

/** Where a command writes; injectable so output is captured in tests instead of hitting the process streams. */
export interface CliIO {
    readonly writeOut: (text: string) => void;
    readonly writeErr: (text: string) => void;
}

/** The production {@link CliIO}: writes straight to the process streams. */
export function processStreamsIO(): CliIO {
    return {
        writeOut: (text) => void process.stdout.write(text),
        writeErr: (text) => void process.stderr.write(text),
    };
}
