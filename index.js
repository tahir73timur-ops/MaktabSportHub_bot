/**
 * Maktab sport to'garaklari boti (Node.js)
 * Bo'limlar: To'garaklar | Sport Passport | Open Competition | Young Coach | Digital Report
 * Ishga tushirish:  BOT_TOKEN=... ADMIN_IDS=123,456 node bot.js
 */
const { Telegraf, Markup } = require('telegraf');
const Database = require('better-sqlite3');

// Bo'sh joy va qo'shtirnoqlarni olib tashlaymiz (hostingda tez-tez uchraydigan xato)
const TOKEN = (process.env.BOT_TOKEN || '').trim().replace(/^["']|["']$/g, '');
const ADMIN_IDS = new Set(
  (process.env.ADMIN_IDS || '').split(',').map((x) => x.trim()).filter((x) => /^\d+$/.test(x)).map(Number)
);
if (!TOKEN) {
  console.error("BOT_TOKEN o'rnatilmagan!");
  process.exit(1);
}

// ───────────────────────── Ma'lumotlar bazasi ─────────────────────────
const db = new Database('sport.db');
db.exec(`
CREATE TABLE IF NOT EXISTS districts(id INTEGER PRIMARY KEY, name TEXT UNIQUE);
CREATE TABLE IF NOT EXISTS schools(id INTEGER PRIMARY KEY, district_id INT, name TEXT);
CREATE TABLE IF NOT EXISTS users(
  tg_id INTEGER PRIMARY KEY, full_name TEXT, school_id INT, grade TEXT, role TEXT DEFAULT 'student');
CREATE TABLE IF NOT EXISTS clubs(
  id INTEGER PRIMARY KEY, school_id INT, sport TEXT, days TEXT, coach TEXT, phone TEXT);
CREATE TABLE IF NOT EXISTS members(club_id INT, user_id INT, UNIQUE(club_id, user_id));
CREATE TABLE IF NOT EXISTS attendance(
  id INTEGER PRIMARY KEY, club_id INT, user_id INT, day TEXT, present INT);
CREATE TABLE IF NOT EXISTS results(
  id INTEGER PRIMARY KEY, user_id INT, kind TEXT, title TEXT, place TEXT, day TEXT);
CREATE TABLE IF NOT EXISTS competitions(
  id INTEGER PRIMARY KEY, district_id INT, title TEXT, day TEXT, place TEXT, sport TEXT);
CREATE TABLE IF NOT EXISTS comp_regs(comp_id INT, user_id INT, UNIQUE(comp_id, user_id));
CREATE TABLE IF NOT EXISTS assistants(
  id INTEGER PRIMARY KEY, user_id INT, club_id INT, status TEXT DEFAULT 'pending',
  sessions INT DEFAULT 0, last_day TEXT, UNIQUE(user_id, club_id));
`);

const all = (sql, ...a) => db.prepare(sql).all(...a);
const one = (sql, ...a) => db.prepare(sql).get(...a);
const run = (sql, ...a) => db.prepare(sql).run(...a);

const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tashkent' }); // YYYY-MM-DD
const getUser = (id) => one('SELECT * FROM users WHERE tg_id=?', id);
const isManager = (id) => getUser(id)?.role === 'manager';

// ───────────────────────── Yordamchi funksiyalar ─────────────────────────
const MENU = ["🏫 To'garaklar", '🏅 Sport Passport', '🏆 Open Competition', '🤝 Young Coach'];
const MANAGER_MENU = ['📊 Digital Report', '📝 Natija kiritish', "👥 Young Coach'lar"];
const MENU_TEXTS = new Set([...MENU, ...MANAGER_MENU]);

const menu = (id) =>
  Markup.keyboard(isManager(id) ? [...MENU, ...MANAGER_MENU] : MENU, { columns: 2 }).resize();

const inline = (rows, columns = 1) =>
  Markup.inlineKeyboard(rows.map(([t, d]) => Markup.button.callback(t, d)), { columns });

const districtsKb = (prefix) =>
  inline(all('SELECT * FROM districts').map((d) => [d.name, `${prefix}:${d.id}`]));
const schoolsKb = (prefix, did) =>
  inline(all('SELECT * FROM schools WHERE district_id=?', did).map((s) => [s.name, `${prefix}:${s.id}`]));

const states = new Map(); // tg_id -> { step, ...data }

const safeEdit = async (ctx, text, kb) => {
  try {
    await ctx.editMessageText(text, kb);
  } catch (e) { /* "message is not modified" va h.k. */ }
};
const safeSend = async (id, text, extra) => {
  try {
    await bot.telegram.sendMessage(id, text, extra);
    return true;
  } catch (e) {
    return false;
  }
};
const alert = (ctx, text) => ctx.answerCbQuery(text, { show_alert: true });

const needUser = async (ctx) => {
  const u = getUser(ctx.from.id);
  if (!u) await ctx.reply("Avval /start orqali ro'yxatdan o'ting.");
  return u;
};
const needManager = async (ctx) => {
  if (!isManager(ctx.from.id)) {
    await alert(ctx, "Bu amal faqat maktab mas'ullari uchun.");
    return false;
  }
  return true;
};
const ownClub = (ctx, cid) =>
  one('SELECT 1 x FROM clubs WHERE id=? AND school_id=?', cid, getUser(ctx.from.id).school_id);

const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const argsOf = (ctx) => ctx.message.text.replace(/^\/\S+\s*/, '').trim();
const pipeParts = (ctx, n) => {
  const p = argsOf(ctx).split('|').map((x) => x.trim());
  return p.length === n && p.every(Boolean) ? p : null;
};

const bot = new Telegraf(TOKEN);

// Menyu tugmasi bosilsa, tugallanmagan jarayon bekor qilinadi
bot.use((ctx, next) => {
  const t = ctx.message?.text;
  if (t && (MENU_TEXTS.has(t) || t.startsWith('/'))) states.delete(ctx.from.id);
  return next();
});

bot.command('cancel', (ctx) =>
  ctx.reply('Bekor qilindi.', getUser(ctx.from.id) ? menu(ctx.from.id) : undefined)
);

// ───────────────────────── Ro'yxatdan o'tish ─────────────────────────
bot.start((ctx) => {
  if (getUser(ctx.from.id)) return ctx.reply('Asosiy menyu 👇', menu(ctx.from.id));
  states.set(ctx.from.id, { step: 'reg_name' });
  return ctx.reply("Assalomu alaykum! 🏃 Maktab sport botiga xush kelibsiz.\n\nIsm va familiyangizni kiriting:");
});

bot.action(/^rgd:(\d+)$/, async (ctx) => {
  const st = states.get(ctx.from.id);
  if (!st?.name) return alert(ctx, 'Sessiya tugagan. /start ni bosing.');
  const did = +ctx.match[1];
  if (!one('SELECT 1 x FROM schools WHERE district_id=?', did)) return alert(ctx, 'Bu hududda maktablar kiritilmagan.');
  await safeEdit(ctx, 'Maktabingizni tanlang:', schoolsKb('rgs', did));
});

bot.action(/^rgs:(\d+)$/, async (ctx) => {
  const st = states.get(ctx.from.id);
  if (!st?.name) return alert(ctx, 'Sessiya tugagan. /start ni bosing.');
  st.school_id = +ctx.match[1];
  st.step = 'reg_grade';
  await safeEdit(ctx, 'Sinfingizni kiriting (masalan: 8-A):');
});

// ───────────────────────── 1. To'garaklar ─────────────────────────
function clubsView(schoolId) {
  const school = one('SELECT * FROM schools WHERE id=?', schoolId);
  if (!school) return ['Maktab topilmadi.', undefined];
  const clubs = all('SELECT * FROM clubs WHERE school_id=?', schoolId);
  if (!clubs.length) return [`🏫 ${school.name}\n\nBu maktabda hozircha to'garak kiritilmagan.`, undefined];
  let text = `🏫 ${school.name}\n`;
  for (const c of clubs)
    text += `\n⚽ ${c.sport}\n   📅 Kunlar: ${c.days}\n   👨‍🏫 Murabbiy: ${c.coach} (${c.phone})\n`;
  return [text, inline(clubs.map((c) => [`➕ ${c.sport} ga qo'shilish`, `join:${c.id}`]))];
}

bot.hears("🏫 To'garaklar", async (ctx) => {
  const u = await needUser(ctx);
  if (!u) return;
  ctx.reply("Qaysi to'garaklarni ko'rmoqchisiz?", inline([
    ['🏫 Mening maktabim', `sch:${u.school_id}`],
    ['🗺 Boshqa hudud / maktab', 'dl'],
  ]));
});

bot.action('dl', (ctx) => safeEdit(ctx, 'Hududni tanlang:', districtsKb('dist')));

bot.action(/^dist:(\d+)$/, async (ctx) => {
  const did = +ctx.match[1];
  if (!one('SELECT 1 x FROM schools WHERE district_id=?', did)) return alert(ctx, 'Bu hududda maktablar kiritilmagan.');
  await safeEdit(ctx, 'Maktabni tanlang:', schoolsKb('sch', did));
});

bot.action(/^sch:(\d+)$/, async (ctx) => {
  const [text, kb] = clubsView(+ctx.match[1]);
  await safeEdit(ctx, text, kb);
  ctx.answerCbQuery();
});

bot.action(/^join:(\d+)$/, async (ctx) => {
  if (!getUser(ctx.from.id)) return alert(ctx, "Avval /start orqali ro'yxatdan o'ting.");
  const cid = +ctx.match[1];
  if (!one('SELECT 1 x FROM clubs WHERE id=?', cid)) return alert(ctx, "To'garak topilmadi.");
  const r = run('INSERT OR IGNORE INTO members VALUES(?,?)', cid, ctx.from.id);
  alert(ctx, r.changes ? "✅ Qo'shildingiz!" : "Siz allaqachon a'zosiz.");
});

// ───────────────────────── 2. Sport Passport ─────────────────────────
bot.hears('🏅 Sport Passport', async (ctx) => {
  const u = await needUser(ctx);
  if (!u) return;
  const school = one('SELECT name FROM schools WHERE id=?', u.school_id);
  let text = `🏅 SPORT PASSPORT\n\n👤 ${u.full_name}\n🏫 ${school?.name ?? '-'} | ${u.grade}\n`;

  const sports = all(
    `SELECT c.sport, SUM(a.present) att, COUNT(a.id) total
     FROM members mb JOIN clubs c ON c.id=mb.club_id
     LEFT JOIN attendance a ON a.club_id=c.id AND a.user_id=mb.user_id
     WHERE mb.user_id=? GROUP BY c.id`, u.tg_id);
  text += '\n⚽ Sport turlari va davomat:\n';
  text += sports.map((s) => `  • ${s.sport}: ${s.att || 0}/${s.total} mashg'ulot`).join('\n') || "  Hali to'garakka a'zo emassiz.";

  const res = all("SELECT * FROM results WHERE user_id=? AND kind='result' ORDER BY day DESC", u.tg_id);
  text += '\n\n🏁 Musobaqa natijalari:\n';
  text += res.map((r) => `  • ${r.day} — ${r.title}: ${r.place}`).join('\n') || "  Hali yo'q.";

  const ach = all("SELECT * FROM results WHERE user_id=? AND kind='achievement' ORDER BY day DESC", u.tg_id);
  text += '\n\n🏆 Yutuqlar:\n';
  text += ach.map((r) => `  • ${r.day} — ${r.title} (${r.place})`).join('\n') || "  Hali yo'q.";
  ctx.reply(text);
});

// ───────────────────────── 3. Open Competition ─────────────────────────
bot.hears('🏆 Open Competition', async (ctx) => {
  const u = await needUser(ctx);
  if (!u) return;
  const sch = one('SELECT district_id FROM schools WHERE id=?', u.school_id);
  if (!sch) return ctx.reply("Maktabingiz ma'lumoti topilmadi. Administrator bilan bog'laning.");
  const comps = all('SELECT * FROM competitions WHERE district_id=? AND day>=? ORDER BY day', sch.district_id, today());
  if (!comps.length) return ctx.reply("Hozircha e'lon qilingan musobaqalar yo'q.");
  for (const cp of comps)
    await ctx.reply(`🏆 ${cp.title}\n⚽ ${cp.sport}\n📅 ${cp.day}\n📍 ${cp.place}`,
      inline([['✋ Qatnashmoqchiman', `reg:${cp.id}`]]));
});

bot.action(/^reg:(\d+)$/, (ctx) => {
  if (!getUser(ctx.from.id)) return alert(ctx, "Avval /start orqali ro'yxatdan o'ting.");
  const r = run('INSERT OR IGNORE INTO comp_regs VALUES(?,?)', +ctx.match[1], ctx.from.id);
  alert(ctx, r.changes ? '✅ Ariza qabul qilindi!' : 'Siz allaqachon yozilgansiz.');
});

// ───────────────────────── 4. Young Coach ─────────────────────────
const YC_STATUS = { pending: "⏳ ko'rib chiqilmoqda", approved: '✅ tasdiqlangan', rejected: '❌ rad etilgan' };

bot.hears('🤝 Young Coach', async (ctx) => {
  const u = await needUser(ctx);
  if (!u) return;
  const mine = all(
    'SELECT a.*, c.sport FROM assistants a JOIN clubs c ON c.id=a.club_id WHERE a.user_id=?', u.tg_id);
  if (mine.length) {
    let text = '🤝 Sizning Young Coach faoliyatingiz:\n';
    const rows = [];
    for (const a of mine) {
      text += `\n• ${a.sport} — ${YC_STATUS[a.status]}, o'tkazilgan mashg'ulot: ${a.sessions}`;
      if (a.status === 'approved') rows.push([`✅ ${a.sport}: mashg'ulot o'tkazdim`, `ycl:${a.id}`]);
    }
    await ctx.reply(text, rows.length ? inline(rows) : undefined);
  }
  const clubs = all('SELECT * FROM clubs WHERE school_id=?', u.school_id);
  if (clubs.length)
    await ctx.reply("Murabbiy yordamchisi bo'lish uchun to'garakni tanlang:", inline(clubs.map((c) => [c.sport, `yc:${c.id}`])));
  else if (!mine.length) await ctx.reply("Maktabingizda to'garaklar yo'q.");
});

bot.action(/^yc:(\d+)$/, async (ctx) => {
  const u = getUser(ctx.from.id);
  if (!u) return alert(ctx, "Avval /start orqali ro'yxatdan o'ting.");
  const cid = +ctx.match[1];
  const club = one('SELECT sport FROM clubs WHERE id=?', cid);
  if (!club) return alert(ctx, "To'garak topilmadi.");
  if (one('SELECT 1 x FROM assistants WHERE user_id=? AND club_id=?', u.tg_id, cid))
    return alert(ctx, 'Siz allaqachon ariza topshirgansiz.');
  const aid = run('INSERT INTO assistants(user_id,club_id) VALUES(?,?)', u.tg_id, cid).lastInsertRowid;
  await alert(ctx, '✅ Ariza yuborildi!');
  for (const mg of all("SELECT tg_id FROM users WHERE role='manager' AND school_id=?", u.school_id))
    await safeSend(mg.tg_id, `🤝 Yangi Young Coach arizasi:\n${u.full_name} (${u.grade}) — ${club.sport}`,
      inline([['✅ Tasdiqlash', `yca:${aid}:1`], ['❌ Rad etish', `yca:${aid}:0`]], 2));
});

bot.action(/^yca:(\d+):([01])$/, async (ctx) => {
  if (!(await needManager(ctx))) return;
  const a = one('SELECT * FROM assistants WHERE id=?', +ctx.match[1]);
  if (!a) return alert(ctx, 'Ariza topilmadi.');
  if (a.status !== 'pending') return alert(ctx, "Bu ariza allaqachon ko'rib chiqilgan.");
  const ok = ctx.match[2] === '1';
  run('UPDATE assistants SET status=? WHERE id=?', ok ? 'approved' : 'rejected', a.id);
  await safeEdit(ctx, ctx.callbackQuery.message.text + (ok ? '\n\n✅ Tasdiqlandi' : '\n\n❌ Rad etildi'));
  await safeSend(a.user_id, '🤝 Young Coach arizangiz: ' + (ok ? '✅ tasdiqlandi!' : '❌ rad etildi.'));
  ctx.answerCbQuery();
});

bot.action(/^ycl:(\d+)$/, (ctx) => {
  const r = run("UPDATE assistants SET sessions=sessions+1, last_day=? WHERE id=? AND user_id=? AND status='approved'",
    today(), +ctx.match[1], ctx.from.id);
  alert(ctx, r.changes ? '📈 Faoliyatingiz yozildi!' : "Ruxsat yo'q.");
});

bot.hears("👥 Young Coach'lar", (ctx) => {
  if (!isManager(ctx.from.id)) return;
  const rows = all(
    `SELECT u.full_name, u.grade, c.sport, a.status, a.sessions, a.last_day
     FROM assistants a JOIN users u ON u.tg_id=a.user_id JOIN clubs c ON c.id=a.club_id
     WHERE c.school_id=?`, getUser(ctx.from.id).school_id);
  if (!rows.length) return ctx.reply("Hozircha Young Coach'lar yo'q.");
  ctx.reply("👥 Young Coach'lar:\n\n" + rows.map((r) =>
    `• ${r.full_name} (${r.grade}) — ${r.sport}, ${r.status}, mashg'ulot: ${r.sessions}, oxirgi: ${r.last_day || '-'}`
  ).join('\n'));
});

// ───────────────────────── 5. Digital Report (mas'ul) ─────────────────────────
bot.hears('📊 Digital Report', (ctx) => {
  if (!isManager(ctx.from.id)) return ctx.reply("Bu bo'lim faqat maktab mas'ullari uchun.");
  ctx.reply('Digital Report:', inline([
    ['✅ Bugungi davomatni kiritish', 'att_start'],
    ['📈 Maktab hisoboti (CSV)', 'rep'],
  ]));
});

const clubMembers = (cid) =>
  all('SELECT u.tg_id, u.full_name FROM members mb JOIN users u ON u.tg_id=mb.user_id WHERE mb.club_id=?', cid);
const attKb = (members, present) =>
  inline([
    ...members.map((m) => [(present.has(m.tg_id) ? '✅ ' : '⬜ ') + m.full_name, `tg:${m.tg_id}`]),
    ['💾 Saqlash', 'att_save'],
  ]);

bot.action('att_start', async (ctx) => {
  if (!(await needManager(ctx))) return;
  const clubs = all('SELECT * FROM clubs WHERE school_id=?', getUser(ctx.from.id).school_id);
  if (!clubs.length) return alert(ctx, "Maktabingizda to'garaklar kiritilmagan.");
  await safeEdit(ctx, "To'garakni tanlang:", inline(clubs.map((c) => [c.sport, `attc:${c.id}`])));
});

bot.action(/^attc:(\d+)$/, async (ctx) => {
  if (!(await needManager(ctx))) return;
  const cid = +ctx.match[1];
  if (!ownClub(ctx, cid)) return alert(ctx, "Ruxsat yo'q.");
  const members = clubMembers(cid);
  if (!members.length) return alert(ctx, "Bu to'garakda a'zolar yo'q.");
  states.set(ctx.from.id, { step: 'att', cid, present: new Set() });
  await safeEdit(ctx, 'Kelganlarni belgilang:', attKb(members, new Set()));
});

bot.action(/^tg:(\d+)$/, async (ctx) => {
  const st = states.get(ctx.from.id);
  if (st?.step !== 'att') return alert(ctx, "Sessiya tugagan. «📊 Digital Report» dan qaytadan boshlang.");
  const uid = +ctx.match[1];
  st.present.has(uid) ? st.present.delete(uid) : st.present.add(uid);
  await safeEdit(ctx, ctx.callbackQuery.message.text, attKb(clubMembers(st.cid), st.present));
  ctx.answerCbQuery();
});

bot.action('att_save', async (ctx) => {
  const st = states.get(ctx.from.id);
  if (st?.step !== 'att') return alert(ctx, "Sessiya tugagan. «📊 Digital Report» dan qaytadan boshlang.");
  const day = today();
  const members = all('SELECT user_id FROM members WHERE club_id=?', st.cid);
  db.transaction(() => {
    run('DELETE FROM attendance WHERE club_id=? AND day=?', st.cid, day);
    for (const m of members)
      run('INSERT INTO attendance(club_id,user_id,day,present) VALUES(?,?,?,?)', st.cid, m.user_id, day, +st.present.has(m.user_id));
  })();
  states.delete(ctx.from.id);
  await safeEdit(ctx, `✅ Davomat saqlandi: ${st.present.size}/${members.length} o'quvchi qatnashdi (${day}).`);
  ctx.answerCbQuery();
});

bot.action('rep', async (ctx) => {
  if (!(await needManager(ctx))) return;
  const sid = getUser(ctx.from.id).school_id;
  const clubs = all(
    `SELECT c.sport, COUNT(DISTINCT mb.user_id) n FROM clubs c
     LEFT JOIN members mb ON mb.club_id=c.id WHERE c.school_id=? GROUP BY c.id`, sid);
  if (!clubs.length) return alert(ctx, "Hisobot uchun ma'lumot yo'q.");
  const rows = all(
    `SELECT u.full_name, u.grade, c.sport, COALESCE(SUM(a.present),0) att, COUNT(a.id) total
     FROM members mb JOIN users u ON u.tg_id=mb.user_id JOIN clubs c ON c.id=mb.club_id
     LEFT JOIN attendance a ON a.club_id=c.id AND a.user_id=u.tg_id
     WHERE c.school_id=? GROUP BY u.tg_id, c.id`, sid);
  await ctx.reply('📊 Maktab hisoboti\n\n' + clubs.map((x) => `• ${x.sport}: ${x.n} a'zo`).join('\n'));
  const csv = [["F.I.Sh", 'Sinf', "To'garak", 'Qatnashgan', "Jami mashg'ulot"],
    ...rows.map((r) => [r.full_name, r.grade, r.sport, r.att, r.total])]
    .map((row) => row.map(csvCell).join(',')).join('\n');
  await ctx.replyWithDocument({ source: Buffer.from('\uFEFF' + csv, 'utf8'), filename: `hisobot_${today()}.csv` });
  ctx.answerCbQuery();
});

// ───────────────────────── Natija kiritish (mas'ul) ─────────────────────────
bot.hears('📝 Natija kiritish', (ctx) => {
  if (!isManager(ctx.from.id)) return;
  const clubs = all('SELECT * FROM clubs WHERE school_id=?', getUser(ctx.from.id).school_id);
  if (!clubs.length) return ctx.reply("Maktabingizda to'garaklar kiritilmagan.");
  ctx.reply("To'garakni tanlang:", inline(clubs.map((c) => [c.sport, `rc:${c.id}`])));
});

bot.action(/^rc:(\d+)$/, async (ctx) => {
  if (!(await needManager(ctx))) return;
  const cid = +ctx.match[1];
  if (!ownClub(ctx, cid)) return alert(ctx, "Ruxsat yo'q.");
  const members = clubMembers(cid);
  if (!members.length) return alert(ctx, "Bu to'garakda a'zolar yo'q.");
  await safeEdit(ctx, "O'quvchini tanlang:", inline(members.map((m) => [m.full_name, `ru:${m.tg_id}`])));
});

bot.action(/^ru:(\d+)$/, async (ctx) => {
  if (!(await needManager(ctx))) return;
  states.set(ctx.from.id, { step: 'res_kind', uid: +ctx.match[1] });
  await safeEdit(ctx, 'Turini tanlang:', inline([['🏁 Musobaqa natijasi', 'rk:result'], ['🏆 Yutuq', 'rk:achievement']], 2));
});

bot.action(/^rk:(result|achievement)$/, async (ctx) => {
  if (!(await needManager(ctx))) return;
  const st = states.get(ctx.from.id);
  if (st?.step !== 'res_kind') return alert(ctx, 'Sessiya tugagan. Qaytadan boshlang.');
  st.kind = ctx.match[1];
  st.step = 'res_title';
  await safeEdit(ctx, 'Musobaqa / yutuq nomini yozing (bekor qilish: /cancel):');
});

// ───────────────────────── Matnli javoblar (holatlar) ─────────────────────────
bot.on('text', async (ctx, next) => {
  const st = states.get(ctx.from.id);
  const text = ctx.message.text.trim();
  if (!st || text.startsWith('/')) return next();

  switch (st.step) {
    case 'reg_name':
      if (!all('SELECT 1 FROM districts').length) {
        states.delete(ctx.from.id);
        return ctx.reply('Hozircha hududlar kiritilmagan. Administrator bilan bog\'laning.');
      }
      st.name = text.slice(0, 100);
      return ctx.reply('Hududingizni (tumanni) tanlang:', districtsKb('rgd'));

    case 'reg_grade':
      if (!st.name || !st.school_id) {
        states.delete(ctx.from.id);
        return ctx.reply('Sessiya tugagan. /start ni bosing.');
      }
      run("INSERT OR REPLACE INTO users(tg_id,full_name,school_id,grade,role) VALUES(?,?,?,?,'student')",
        ctx.from.id, st.name, st.school_id, text.slice(0, 20));
      states.delete(ctx.from.id);
      return ctx.reply("✅ Ro'yxatdan o'tdingiz!", menu(ctx.from.id));

    case 'res_title':
      st.title = text.slice(0, 200);
      st.step = 'res_place';
      return ctx.reply("O'rni yoki izoh (masalan: 1-o'rin, Oltin medal):");

    case 'res_place': {
      const place = text.slice(0, 200);
      run('INSERT INTO results(user_id,kind,title,place,day) VALUES(?,?,?,?,?)', st.uid, st.kind, st.title, place, today());
      states.delete(ctx.from.id);
      await ctx.reply("✅ Sport Passport'ga yozildi.", menu(ctx.from.id));
      return safeSend(st.uid, `🎉 Sport Passport'ingizga yangi yozuv: ${st.title} — ${place}`);
    }
    default:
      return next();
  }
});

// ───────────────────────── Administrator buyruqlari ─────────────────────────
const admin = (ctx, next) => (ADMIN_IDS.has(ctx.from.id) ? next() : undefined);

bot.command('admin', admin, (ctx) =>
  ctx.reply(
    '👑 Admin buyruqlari:\n\n' +
    '/add_district Chilonzor\n' +
    '/add_school <hudud_id> | <maktab nomi>\n' +
    '/add_club <maktab_id> | sport | kunlar | murabbiy | telefon\n' +
    '/add_comp <hudud_id> | nomi | YYYY-MM-DD | joyi | sport\n' +
    '/set_manager <tg_id> <maktab_id>\n' +
    '/comp_regs <musobaqa_id>\n' +
    "/list — hudud, maktab, to'garak va musobaqa ID lari"));

bot.command('list', admin, (ctx) => {
  const text =
    'Hududlar:\n' + all('SELECT * FROM districts').map((d) => `${d.id}. ${d.name}`).join('\n') +
    '\n\nMaktablar:\n' + all('SELECT * FROM schools').map((s) => `${s.id}. ${s.name} (hudud ${s.district_id})`).join('\n') +
    "\n\nTo'garaklar:\n" + all('SELECT * FROM clubs').map((c) => `${c.id}. ${c.sport} (maktab ${c.school_id})`).join('\n') +
    '\n\nMusobaqalar:\n' + all('SELECT * FROM competitions').map((c) => `${c.id}. ${c.title} (${c.day})`).join('\n');
  ctx.reply(text);
});

bot.command('add_district', admin, (ctx) => {
  const name = argsOf(ctx);
  if (!name) return ctx.reply('Format: /add_district Nomi');
  run('INSERT OR IGNORE INTO districts(name) VALUES(?)', name);
  ctx.reply("✅ Qo'shildi. /list");
});

bot.command('add_school', admin, (ctx) => {
  const p = pipeParts(ctx, 2);
  if (!p || !/^\d+$/.test(p[0])) return ctx.reply('Format: /add_school <hudud_id> | <nomi>');
  if (!one('SELECT 1 x FROM districts WHERE id=?', +p[0])) return ctx.reply("❌ Bunday hudud ID yo'q. /list");
  run('INSERT INTO schools(district_id,name) VALUES(?,?)', +p[0], p[1]);
  ctx.reply("✅ Maktab qo'shildi.");
});

bot.command('add_club', admin, (ctx) => {
  const p = pipeParts(ctx, 5);
  if (!p || !/^\d+$/.test(p[0])) return ctx.reply('Format: /add_club <maktab_id> | sport | kunlar | murabbiy | telefon');
  if (!one('SELECT 1 x FROM schools WHERE id=?', +p[0])) return ctx.reply("❌ Bunday maktab ID yo'q. /list");
  run('INSERT INTO clubs(school_id,sport,days,coach,phone) VALUES(?,?,?,?,?)', +p[0], p[1], p[2], p[3], p[4]);
  ctx.reply("✅ To'garak qo'shildi.");
});

bot.command('add_comp', admin, async (ctx) => {
  const p = pipeParts(ctx, 5);
  if (!p || !/^\d+$/.test(p[0])) return ctx.reply('Format: /add_comp <hudud_id> | nomi | YYYY-MM-DD | joyi | sport');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p[2]) || isNaN(new Date(p[2])))
    return ctx.reply("❌ Sana formati noto'g'ri. To'g'ri: 2026-11-20");
  if (!one('SELECT 1 x FROM districts WHERE id=?', +p[0])) return ctx.reply("❌ Bunday hudud ID yo'q. /list");
  run('INSERT INTO competitions(district_id,title,day,place,sport) VALUES(?,?,?,?,?)', +p[0], p[1], p[2], p[3], p[4]);
  let sent = 0;
  for (const u of all('SELECT u.tg_id FROM users u JOIN schools s ON s.id=u.school_id WHERE s.district_id=?', +p[0])) {
    if (await safeSend(u.tg_id, `🏆 Yangi musobaqa e'lon qilindi: ${p[1]} (${p[2]}). «Open Competition» bo'limidan yoziling!`)) sent++;
    await new Promise((r) => setTimeout(r, 50)); // Telegram limitiga tushmaslik uchun
  }
  ctx.reply(`✅ Musobaqa e'lon qilindi. Xabar ${sent} ta o'quvchiga yuborildi.`);
});

bot.command('set_manager', admin, (ctx) => {
  const a = argsOf(ctx).split(/\s+/);
  if (a.length !== 2 || !/^\d+$/.test(a[0]) || !/^\d+$/.test(a[1])) return ctx.reply('Format: /set_manager <tg_id> <maktab_id>');
  if (!one('SELECT 1 x FROM schools WHERE id=?', +a[1])) return ctx.reply("❌ Bunday maktab ID yo'q. /list");
  run(`INSERT INTO users(tg_id,full_name,school_id,grade,role) VALUES(?,?,?,?,'manager')
       ON CONFLICT(tg_id) DO UPDATE SET role='manager', school_id=excluded.school_id`, +a[0], "Mas'ul", +a[1], '-');
  ctx.reply("✅ Maktab mas'uli tayinlandi. U /start bosishi kerak.");
});

bot.command('comp_regs', admin, (ctx) => {
  const id = argsOf(ctx);
  if (!/^\d+$/.test(id)) return ctx.reply('Format: /comp_regs <musobaqa_id>');
  const rows = all(
    `SELECT u.full_name, u.grade, s.name FROM comp_regs r
     JOIN users u ON u.tg_id=r.user_id JOIN schools s ON s.id=u.school_id WHERE r.comp_id=?`, +id);
  if (!rows.length) return ctx.reply('Hech kim yozilmagan.');
  ctx.reply("✋ Ro'yxatdan o'tganlar:\n" + rows.map((r) => `• ${r.full_name} (${r.grade}, ${r.name})`).join('\n'));
});

// ───────────────────────── Ishga tushirish ─────────────────────────
bot.catch((err, ctx) => console.error(`Xato (${ctx.updateType}):`, err));
bot.telegram.getMe()
  .then((me) => {
    console.log(`Token to'g'ri ✅  @${me.username}`);
    return bot.launch();
  })
  .catch((e) => {
    if (e.response?.error_code === 401)
      console.error("❌ 401 Unauthorized: BOT_TOKEN noto'g'ri yoki bekor qilingan. @BotFather dan yangi token oling.");
    else console.error('❌ Ishga tushmadi:', e.message);
    process.exit(1);
  });
console.log('Bot ishga tushmoqda...');
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
