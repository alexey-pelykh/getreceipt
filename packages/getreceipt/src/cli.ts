#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
import { runCli } from '@getreceipt/cli';

// Thin shim: assemble + run the program (testable as `runCli`), then exit with its code.
// `--version` carries the unofficial-use disclaimer; `--help` carries it as a footer.
process.exit(await runCli(process.argv.slice(2)));
