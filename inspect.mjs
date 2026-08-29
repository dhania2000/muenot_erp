import { read, utils } from 'xlsx'
import { readFileSync } from 'node:fs'

const buf = readFileSync('data/Sales-CRM-d06da5.xlsx')
const wb = read(buf, { cellDates: true })
for (const name of wb.SheetNames) {
  const rows = utils.sheet_to_json(wb.Sheets[name], { defval: null, header: 1 })
  console.log('\n===== SHEET:', name, '| rows:', rows.length, '=====')
  // print first 3 non-empty rows to capture headers/labels
  let shown = 0
  for (const r of rows) {
    if (r && r.some((c) => c !== null && c !== '')) {
      console.log(JSON.stringify(r))
      if (++shown >= 4) break
    }
  }
}
