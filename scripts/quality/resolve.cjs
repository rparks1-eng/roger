// Dependency analysis aliases for URLs served by http.mjs; no bundler is used.
const path = require('node:path');
module.exports = {
  resolve: {
    alias: { '/client': path.resolve('src/client'), '/vendor': path.resolve('public/vendor') },
  },
};
