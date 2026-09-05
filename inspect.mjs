import { read, utils } from 'xlsx'
import { readFileSync } from 'node:fs'

const buf = readFileSync('data/Recruitment-Master-cd39e8.xlsx')
const wb = read(buf, { cellDates: true })
console.log('SHEETS:', wb.SheetNames)
for (const name of wb.SheetNames) {
  const rows = utils.sheet_to_json(wb.Sheets[name], { defval: null })
  console.log('\n===== SHEET:', name, '| rows:', rows.length, '=====')
  if (rows.length) {
    console.log('HEADERS:', Object.keys(rows[0]))
    console.log('SAMPLE:', JSON.stringify(rows.slice(0, 3), null, 2))
  }
}
