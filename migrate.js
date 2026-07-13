// Прогоняет schema.sql против DATABASE_URL. Идемпотентно (create if not exists).
import postgres from 'postgres'
import { readFileSync } from 'node:fs'

const DB = process.env.DATABASE_URL
if (!DB) { console.error('НЕТ DATABASE_URL'); process.exit(1) }
const sql = postgres(DB, { ssl: 'require', max: 1 })
const ddl = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8')
await sql.unsafe(ddl)
const tables = await sql`select table_name from information_schema.tables where table_schema='public' order by table_name`
console.log('таблицы:', tables.map((t) => t.table_name).join(', '))
await sql.end()
