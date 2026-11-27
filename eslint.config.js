import js from '@eslint/js';
import globals from 'globals';

export default [
  js.configs.recommended,
  { files: ['server.js', 'lib/**/*.js', 'test/**/*.js'], languageOptions: { globals: globals.node } },
  { files: ['public/**/*.js'], languageOptions: { sourceType: 'script', globals: globals.browser } },
  { rules: { 'no-unused-vars': ['error', { caughtErrors: 'none' }] } },
];
