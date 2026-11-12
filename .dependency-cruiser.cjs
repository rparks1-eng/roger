module.exports = {
  forbidden: [
    { name: 'no-cycles', severity: 'error', from: {}, to: { circular: true } },
    { name: 'no-unresolved-imports', severity: 'error', from: {}, to: { couldNotResolve: true } },
    {
      name: 'browser-stays-in-browser',
      severity: 'error',
      from: { path: '^src/client/' },
      to: { pathNot: '^(src/client/|public/vendor/)' },
    },
    {
      name: 'server-does-not-import-browser',
      severity: 'error',
      from: { path: '^src/(server|core)/' },
      to: { path: '^src/client/' },
    },
    {
      name: 'core-is-independent',
      severity: 'error',
      from: { path: '^src/core/' },
      to: { path: '^src/(client|server)/' },
    },
    {
      name: 'runtime-does-not-import-tools-or-tests',
      severity: 'error',
      from: { path: '^src/' },
      to: { path: '^(scripts|tests|engineering|migration)/' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules|public/vendor' },
    exclude: { path: 'node_modules|public/vendor' },
    webpackConfig: { fileName: 'scripts/quality/resolve.cjs' },
    enhancedResolveOptions: {
      extensions: ['.mjs', '.js', '.ts', '.json'],
      conditionNames: ['import', 'node', 'default'],
    },
  },
};
