# vendor/

Bundled third-party dependencies so the skill works without an `npm install` step. Each subdir keeps the original LICENSE alongside the code.

| Package | Files | License |
|---------|-------|---------|
| `rhwp/` | rhwp.js (~150KB), rhwp_bg.wasm (~5MB), LICENSE | MIT (© Edward Kim) |
| `fflate/` | index.mjs (~80KB), LICENSE | MIT (© Arjun Barrett) |
| `cfb/` | cfb.js (~62KB, CommonJS — crc32/adler32 inlined), LICENSE | Apache-2.0 (© SheetJS) |

All committed verbatim. To update, copy fresh files from the matching `node_modules/` after a clean `npm install` against the latest version.

`cfb/` is CommonJS — load it from ESM via `createRequire`:

```js
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const CFB = require('./vendor/cfb/cfb.js');
```
