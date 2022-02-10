// @ts-check

import fs from 'fs'
import { callScript } from './call-script.mjs'

const [filePath] = process.argv.slice(-1)
if (!filePath || !fs.existsSync(filePath)) throw new Error('File not found. Expected a file path like "samples/php/test.php"')

callScript(filePath, 'off').then((rawJSON) => {
  try {
    console.dir({ json: JSON.parse(rawJSON) }, { colors: true, depth: 9 })
    fs.writeFileSync('./results/tmp.json', rawJSON, 'utf-8')
  } catch {
    console.info('could not parse JSON', rawJSON)
  }
})
