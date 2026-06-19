import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

const LICENSE_ID = 'AGPL-3.0-only';
const SPDX_TEXT = `SPDX-License-Identifier: ${LICENSE_ID}`;

// Local, dependency-free rule: every first-party source file must carry an SPDX header.
// Report-only (no autofix) to stay robust on the new ESLint 10 flat-config plugin API.
const localPlugin = {
    rules: {
        'spdx-header': {
            meta: {
                type: 'problem',
                docs: { description: 'require an SPDX license-identifier header' },
                schema: [],
                messages: {
                    missing: `Missing SPDX header. Add a top-of-file comment: // ${SPDX_TEXT}`,
                },
            },
            create(context) {
                return {
                    Program(node) {
                        const hasHeader = context.sourceCode
                            .getAllComments()
                            .some((comment) => comment.value.includes(SPDX_TEXT));
                        if (!hasHeader) {
                            context.report({ node, messageId: 'missing' });
                        }
                    },
                };
            },
        },
    },
};

export default tseslint.config(
    { ignores: ['**/dist/**', '**/node_modules/**', '**/.turbo/**', '**/coverage/**', '.tmp/**'] },
    js.configs.recommended,
    tseslint.configs.recommended,
    prettier,
    {
        files: ['packages/*/src/**/*.ts'],
        plugins: { local: localPlugin },
        rules: { 'local/spdx-header': 'error' },
    },
);
