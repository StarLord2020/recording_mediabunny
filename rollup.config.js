import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';

export default {
  input: 'src/index.js',
  output: {
    file: 'dist/mediabunny.umd.js',
    format: 'umd',
    name: 'Mediabunny',
    sourcemap: true,
  },
  plugins: [
    resolve({ browser: true }),
    commonjs()
  ],
};

