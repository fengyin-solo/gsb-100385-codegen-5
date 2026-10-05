// 用 esbuild 的 JS API 打包并执行行为验证，避开 node_modules/.bin 里平台相关的可执行文件。
// 用法：cd frontend && npm run test:exchange
import { buildSync } from 'esbuild'

buildSync({
  entryPoints: ['tests/exchange-verify.mts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  alias: { '@': './src' },
  outfile: 'node_modules/.cache/exchange-verify.mjs',
})

await import('../node_modules/.cache/exchange-verify.mjs')
