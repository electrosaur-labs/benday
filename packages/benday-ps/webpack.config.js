const path = require('path');
const webpack = require('webpack');
const crypto = require('crypto');

module.exports = (env, argv) => {
  const mode = (argv && argv.mode) || 'development';
  const isProduction = mode === 'production';

  const buildId = crypto.randomUUID();
  const buildTime = new Date().toISOString();

  return {
    mode,
    entry: './src/index.js',
    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: 'index.js',
      clean: false,
    },
    module: {
      rules: [],
    },
    plugins: [
      new webpack.DefinePlugin({
        __BUILD_ID__: JSON.stringify(buildId),
        __BUILD_TIME__: JSON.stringify(buildTime),
      }),
    ],
    resolve: {
      extensions: ['.js', '.json'],
      alias: {
        '@electrosaur-labs/benday-core': path.resolve(__dirname, '../benday-core'),
      },
      fallback: {
        fs: false,
        path: false,
      },
    },
    externals: {
      photoshop: 'commonjs2 photoshop',
      uxp: 'commonjs2 uxp',
    },
    target: 'web',
    devtool: isProduction ? false : 'source-map',
    optimization: {
      minimize: isProduction,
    },
  };
};
