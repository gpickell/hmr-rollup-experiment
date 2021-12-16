
### Steps to compile tools:
- yarn install
- yarn rollup -c rollup.config.mjs

### Steps to compile hmr-browser:
- yarn --cwd experiments install
- yarn rollup -c experiments/hmr-browser/rollup.config.mjs --watch
- node experiments/devServer.mjs
- edit App.tsx to see live hcnages
