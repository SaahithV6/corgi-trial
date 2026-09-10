import postgres from "postgres";
const sql = postgres(process.env.DIRECT_URL, { max: 1, onnotice: () => {} });
const t = await sql`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY 1`;
console.log(t.map((r) => r.table_name).join(", "));
for (const n of ["book_entity","business","actor","account","approval_policy","funds_availability_policy","rail_event_semantics","journal_entry","webhook_inbox"]) {
  try { const [c] = await sql.unsafe(`SELECT count(*)::int n FROM ${n}`); console.log(n, c.n); }
  catch (e) { console.log(n, "ERR", e.message); }
}
const cols = await sql`SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name='business' ORDER BY ordinal_position`;
console.log("business cols:", cols.map(c=>`${c.column_name}:${c.data_type}`).join(", "));
await sql.end();
