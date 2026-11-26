/* =====================================================================
   Backend ของเกมต่อจิ๊กซอว์ (Netlify Function)
   - Token ของ Turso อยู่ใน Environment variables บน Netlify เท่านั้น
   - หน้าเว็บส่ง SQL เองไม่ได้ ทำได้เฉพาะคำสั่ง (action) ที่กำหนดไว้ด้านล่าง
   - ทุกค่าที่รับเข้ามาต้องผ่านการตรวจสอบก่อน
   ===================================================================== */

const PIECES = [9, 16, 25, 36, 49, 64];
const MAX_BODY = 450_000;          // ขนาดคำขอสูงสุด (ตัวอักษร)
const MAX_IMAGE = 400_000;         // ขนาดรูป base64 สูงสุด
const ONE_DAY = 86_400_000;

class ApiError extends Error {
  constructor(message, status = 400){ super(message); this.status = status; }
}

const env = name => (globalThis.Netlify?.env.get(name) ?? process.env[name] ?? '').trim();

/* ---------- เชื่อมต่อ Turso ---------- */
function toArg(v){
  if (v === null || v === undefined) return { type: 'null' };
  if (typeof v === 'number') return { type: 'integer', value: String(v) };
  return { type: 'text', value: String(v) };
}

async function sql(query, params = []){
  const base = env('TURSO_DATABASE_URL'), token = env('TURSO_AUTH_TOKEN');
  if (!base || !token) throw new ApiError('เซิร์ฟเวอร์ยังไม่ได้ตั้งค่าฐานข้อมูล', 503);
  const url = base.replace(/^libsql:\/\//, 'https://').replace(/\/$/, '') + '/v2/pipeline';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests: [
      { type: 'execute', stmt: { sql: query, args: params.map(toArg) } },
      { type: 'close' }
    ]})
  });
  if (!res.ok) throw new Error('Turso HTTP ' + res.status);
  const r = (await res.json()).results[0];
  if (r.type === 'error') throw new Error(r.error.message);
  const { cols, rows, affected_row_count } = r.response.result;
  const out = rows.map(row => Object.fromEntries(row.map((cell, i) =>
    [cols[i].name, cell.type === 'null' ? null : cell.type === 'integer' ? Number(cell.value) : cell.value])));
  out.affected = affected_row_count;
  return out;
}

/* ---------- สร้างตาราง (ทำครั้งเดียวต่อการเปิดเซิร์ฟเวอร์) ---------- */
let tablesReady = null;

async function initTables(){
  await sql(`CREATE TABLE IF NOT EXISTS results (
      id INTEGER PRIMARY KEY AUTOINCREMENT, player_name TEXT NOT NULL,
      pieces INTEGER NOT NULL, time_ms INTEGER NOT NULL, moves INTEGER NOT NULL,
      mode TEXT NOT NULL, room_code TEXT, created_at TEXT NOT NULL)`);
  await sql(`CREATE TABLE IF NOT EXISTS rooms (
      code TEXT PRIMARY KEY, pieces INTEGER NOT NULL, image TEXT NOT NULL,
      order_json TEXT NOT NULL, host_name TEXT NOT NULL, guest_name TEXT,
      status TEXT NOT NULL DEFAULT 'waiting', started_at INTEGER,
      host_progress INTEGER DEFAULT 0, guest_progress INTEGER DEFAULT 0,
      host_time INTEGER, guest_time INTEGER, created_at INTEGER NOT NULL,
      host_key TEXT, guest_key TEXT)`);
  // ตาราง rooms จากเวอร์ชันเดิมยังไม่มีคอลัมน์กุญแจ จึงเพิ่มให้
  const have = (await sql(`SELECT name FROM pragma_table_info('rooms')`)).map(c => c.name);
  for (const col of ['host_key', 'guest_key']){
    if (!have.includes(col)){
      try { await sql(`ALTER TABLE rooms ADD COLUMN ${col} TEXT`); }
      catch (e){ if (!/duplicate column/i.test(e.message)) throw e; }
    }
  }
}

function ensureTables(){
  tablesReady ??= initTables().catch(e => { tablesReady = null; throw e; });
  return tablesReady;
}

/* ---------- ตัวตรวจสอบข้อมูลที่รับเข้ามา ---------- */
function int(v, min, max, label){
  if (!Number.isInteger(v) || v < min || v > max) throw new ApiError(label + 'ไม่ถูกต้อง');
  return v;
}
function playerName(v){
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s || s.length > 30) throw new ApiError('ชื่อผู้เล่นต้องยาว 1–30 ตัวอักษร');
  return s;
}
function pieceCount(v){
  if (!PIECES.includes(v)) throw new ApiError('จำนวนชิ้นไม่ถูกต้อง');
  return v;
}
function roomCode(v){
  if (typeof v !== 'string' || !/^\d{4}$/.test(v)) throw new ApiError('รหัสห้องต้องเป็นตัวเลข 4 หลัก');
  return v;
}
function imageData(v){
  if (typeof v !== 'string' || v.length > MAX_IMAGE ||
      !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(v))
    throw new ApiError('รูปภาพไม่ถูกต้องหรือใหญ่เกินไป');
  return v;
}

function shuffle(total){
  const a = [...Array(total).keys()];
  do {
    for (let i = a.length - 1; i > 0; i--){
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
  } while (a.every((v, i) => v === i));
  return a;
}

// ตรวจว่าผู้เรียกเป็นผู้เล่นของห้องนี้จริง และบอกว่าเป็น host หรือ guest
async function member(body){
  const code = roomCode(body.code);
  if (typeof body.key !== 'string' || body.key.length !== 36) throw new ApiError('ไม่มีสิทธิ์ในห้องนี้', 403);
  const [r] = await sql(`SELECT pieces, host_name, guest_name, host_key, guest_key, status, started_at,
      host_progress, guest_progress, host_time, guest_time, created_at FROM rooms WHERE code = ?`, [code]);
  const role = r?.host_key === body.key ? 'host' : r?.guest_key === body.key ? 'guest' : null;
  if (!role) throw new ApiError('ไม่มีสิทธิ์ในห้องนี้', 403);
  return { code, room: r, role };
}

const insertResult = (name, pieces, time, moves, mode, code) => sql(
  `INSERT INTO results (player_name, pieces, time_ms, moves, mode, room_code, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?)`,
  [name, pieces, time, moves, mode, code, new Date().toISOString()]);

/* ---------- คำสั่งทั้งหมดที่หน้าเว็บเรียกได้ ---------- */
const actions = {
  async status(){ return {}; },

  // บันทึกผลโหมดคนเดียว / ผลัดกันเล่น
  async saveResult(b){
    if (!['solo', 'turn'].includes(b.mode)) throw new ApiError('โหมดไม่ถูกต้อง');
    await insertResult(playerName(b.player_name), pieceCount(b.pieces),
      int(b.time_ms, 500, ONE_DAY, 'เวลา'), int(b.moves, 1, 100_000, 'จำนวนครั้ง'), b.mode, null);
    return {};
  },

  async board(b){
    const p = b.pieces == null ? null : pieceCount(b.pieces);
    const rows = await sql(
      `SELECT player_name, pieces, time_ms, moves, mode, created_at
         FROM results ${p ? 'WHERE pieces = ?' : ''} ORDER BY time_ms ASC LIMIT 20`, p ? [p] : []);
    return { rows: [...rows] };
  },

  async createRoom(b){
    const name = playerName(b.name), pieces = pieceCount(b.pieces), image = imageData(b.image);
    await sql('DELETE FROM rooms WHERE created_at < ?', [Date.now() - ONE_DAY]);   // ล้างห้องเก่า
    const order = shuffle(pieces), key = crypto.randomUUID();
    for (let i = 0; i < 5; i++){
      const code = String(Math.floor(1000 + Math.random() * 9000));
      try {
        await sql(`INSERT INTO rooms (code, pieces, image, order_json, host_name, status, created_at, host_key)
                   VALUES (?, ?, ?, ?, ?, 'waiting', ?, ?)`,
          [code, pieces, image, JSON.stringify(order), name, Date.now(), key]);
        return { code, order, key };
      } catch (e){ if (!/UNIQUE|constraint/i.test(e.message)) throw e; }
    }
    throw new ApiError('สร้างห้องไม่สำเร็จ กรุณาลองใหม่', 503);
  },

  async joinRoom(b){
    const name = playerName(b.name), code = roomCode(b.code), key = crypto.randomUUID();
    // UPDATE คำสั่งเดียว จึงมีผู้เข้าห้องสำเร็จได้แค่คนเดียว
    const upd = await sql(`UPDATE rooms SET guest_name = ?, guest_key = ?
        WHERE code = ? AND guest_name IS NULL AND status = 'waiting' AND host_key IS NOT NULL AND created_at >= ?`,
      [name, key, code, Date.now() - ONE_DAY]);
    if (!upd.affected) throw new ApiError('ไม่พบห้องนี้ หรือห้องเต็ม/เริ่มแข่งไปแล้ว');
    const [r] = await sql('SELECT pieces, image, order_json, host_name FROM rooms WHERE code = ?', [code]);
    return { key, pieces: r.pieces, image: r.image, order: JSON.parse(r.order_json), host_name: r.host_name };
  },

  async startRoom(b){
    const { code, room, role } = await member(b);
    if (role !== 'host') throw new ApiError('เฉพาะเจ้าของห้องที่กดเริ่มได้', 403);
    if (!room.guest_name || room.status !== 'waiting') throw new ApiError('ยังเริ่มแข่งไม่ได้');
    await sql(`UPDATE rooms SET status = 'playing', started_at = ? WHERE code = ? AND status = 'waiting'`,
      [Date.now() + 4000, code]);
    return { starts_in: 4000 };
  },

  // อ่านสถานะห้อง (ไม่ส่งกุญแจของใครกลับไป)
  async roomState(b){
    const { room, role } = await member(b);
    const opp = role === 'host' ? 'guest' : 'host';
    return {
      status: room.status,
      // ส่งเป็น "อีกกี่มิลลิวินาที" เครื่องที่ตั้งนาฬิกาไม่ตรงจึงยังเริ่มพร้อมกัน
      starts_in: room.started_at === null ? null : room.started_at - Date.now(),
      opp_name: room[opp + '_name'],
      opp_progress: room[opp + '_progress'],
      opp_time: room[opp + '_time']
    };
  },

  async progress(b){
    const { code, role } = await member(b);          // role เป็นได้แค่ host หรือ guest
    await sql(`UPDATE rooms SET ${role}_progress = ? WHERE code = ?`, [int(b.progress, 0, 100, 'ความคืบหน้า'), code]);
    return {};
  },

  // จบเกมออนไลน์: time_ms = -1 คือยอมแพ้ ส่งได้ครั้งเดียว
  async finish(b){
    const { code, room, role } = await member(b);
    if (room.status !== 'playing') throw new ApiError('ห้องนี้ยังไม่เริ่มแข่ง');
    const gaveUp = b.time_ms === -1;
    let time = -1, moves = 0;
    if (!gaveUp){
      time = int(b.time_ms, 500, ONE_DAY, 'เวลา');
      moves = int(b.moves, 1, 100_000, 'จำนวนครั้ง');
      // เวลาที่ส่งมาต้องไม่นานกว่าเวลาที่ผ่านไปจริงบนเซิร์ฟเวอร์ (เผื่อคลาดเคลื่อน 5 วินาที)
      if (time > Date.now() - room.started_at + 5000) throw new ApiError('เวลาไม่ถูกต้อง');
    }
    const upd = await sql(`UPDATE rooms SET ${role}_time = ?${gaveUp ? '' : `, ${role}_progress = 100`}
        WHERE code = ? AND ${role}_time IS NULL`, [time, code]);
    // ใช้ชื่อและจำนวนชิ้นจากฐานข้อมูล ไม่เชื่อค่าที่หน้าเว็บส่งมา
    if (upd.affected && !gaveUp)
      await insertResult(room[role + '_name'], room.pieces, time, moves, 'online', code);
    return {};
  }
};

const reply = (data, status = 200) =>
  Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });

export default async req => {
  try {
    if (req.method !== 'POST') throw new ApiError('ใช้ได้เฉพาะ POST', 405);
    // บังคับ JSON และไม่เปิด CORS เว็บอื่นจึงเรียก API นี้ผ่านเบราว์เซอร์ไม่ได้
    if (!(req.headers.get('content-type') || '').startsWith('application/json'))
      throw new ApiError('รูปแบบคำขอไม่ถูกต้อง', 415);
    const text = await req.text();
    if (text.length > MAX_BODY) throw new ApiError('ข้อมูลใหญ่เกินไป', 413);
    let body;
    try { body = JSON.parse(text); } catch { throw new ApiError('รูปแบบคำขอไม่ถูกต้อง'); }
    if (!body || typeof body.action !== 'string' || !Object.hasOwn(actions, body.action))
      throw new ApiError('ไม่รู้จักคำสั่งนี้');
    await ensureTables();
    return reply(await actions[body.action](body));
  } catch (e){
    if (e instanceof ApiError) return reply({ error: e.message }, e.status);
    console.error(e);                       // รายละเอียดดูได้ใน Function logs ไม่ส่งให้ผู้เล่น
    return reply({ error: 'เซิร์ฟเวอร์ขัดข้อง กรุณาลองใหม่' }, 500);
  }
};

export const config = {
  path: '/api',
  // จำกัดต่อ 1 IP : ตั้งไว้สูงเพราะคอมในโรงเรียนมักใช้ IP เดียวกันทั้งห้อง
  rateLimit: { windowLimit: 1000, windowSize: 60, aggregateBy: ['ip', 'domain'] }
};
