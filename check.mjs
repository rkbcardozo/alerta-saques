// Avisa no celular quando fica muito tempo sem NENHUM pedido de saque novo
// (sinal de que o saque pode ter quebrado). Roda no GitHub Actions a cada ~5 min.
import fs from 'node:fs';
import crypto from 'node:crypto';
import webpush from 'web-push';

const env = (k, d) => (process.env[k] ?? '').trim() || d;
const BASE = env('BO_URL', 'https://backoffice.play4tune.com');
const LOGIN_PATH = env('BO_LOGIN_PATH', '/api/auth/admin/login');
const NO_WITHDRAW_HOURS = Number(env('NO_WITHDRAW_HOURS', '3')); // horas sem pedido de saque = alerta
const NIGHT_HOURS = Number(env('NIGHT_HOURS', '6'));             // limite maior durante a madrugada
const NIGHT_START = Number(env('NIGHT_START', '0'));             // madrugada começa (hora local)
const NIGHT_END = Number(env('NIGHT_END', '7'));                 // madrugada termina (hora local)
const TZ = env('TIMEZONE', 'America/Bogota');                    // fuso dos jogadores
const REPEAT_MINUTES = Number(env('REPEAT_MINUTES', '60'));      // repete o alerta a cada X min enquanto continuar sem saque
const STATE_FILE = 'state/state.json';

// Chave pública vem do docs/config.js (mesma que o site usa), assim não precisa duplicar
const PUBLIC_KEY = (fs.readFileSync('docs/config.js', 'utf8').match(/VAPID_PUBLIC_KEY\s*=\s*'([^']+)'/) || [])[1] || env('VAPID_PUBLIC_KEY');
webpush.setVapidDetails(env('VAPID_SUBJECT', 'mailto:admin@example.com'), PUBLIC_KEY, env('VAPID_PRIVATE_KEY'));
let subs = JSON.parse(env('PUSH_SUBSCRIPTIONS', '[]'));
if (!Array.isArray(subs)) subs = [subs];

const now = Date.now();
const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {};
const next = { lastGapAlert: state.lastGapAlert || 0, lastErrorAlert: state.lastErrorAlert || 0 };

async function push(payload) {
  console.log('PUSH:', payload.title, '-', payload.body);
  for (const s of subs) {
    try { await webpush.sendNotification(s, JSON.stringify({ url: `${BASE}/transactions`, ...payload })); }
    catch (e) { console.error('Falha ao enviar push', e.statusCode, e.statusCode === 410 ? '(inscrição expirada, ative de novo no site)' : e.body); }
  }
}

// Gera o código de 6 dígitos do 2FA, o mesmo que o app Authenticator mostra
function totp(secretB32) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of secretB32.replace(/[\s=-]/g, '').toUpperCase()) bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g).map(b => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const h = crypto.createHmac('sha1', key).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}

const cookiesDe = res => res.headers.getSetCookie().map(c => c.split(';')[0]);
const resumoErro = async res => {
  try { const j = await res.json(); return JSON.stringify({ code: j.code, message: j.message, errors: j.errors }); }
  catch { return `(HTTP ${res.status})`; }
};

async function getCookie() {
  if (env('BO_COOKIE')) return env('BO_COOKIE');
  const res = await fetch(BASE + LOGIN_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: env('BO_EMAIL'), password: env('BO_PASSWORD') }),
  });
  if (res.ok) {
    const c = cookiesDe(res);
    if (c.length) return c.join('; ');
    throw new Error('Login não retornou cookie de sessão');
  }
  const body = await res.json().catch(() => ({}));
  if (body.code !== 'TWO_FACTOR_REQUIRED')
    throw new Error(`Login falhou: ${JSON.stringify({ code: body.code, message: body.message, errors: body.errors })}`);
  if (!env('BO_TOTP_SECRET')) throw new Error('Backoffice pediu 2FA e falta o secret BO_TOTP_SECRET');

  // 2ª etapa: envia o código do 2FA junto com o token do desafio
  const challengeToken = body.context?.challengeToken;
  const code = totp(env('BO_TOTP_SECRET'));
  const paths = env('BO_2FA_PATH') ? [env('BO_2FA_PATH')] : [
    '/api/auth/admin/2fa/verify', '/api/auth/admin/login/2fa', '/api/auth/admin/two-factor/verify',
    '/api/auth/admin/login/verify', '/api/auth/admin/verify-2fa', '/api/auth/admin/2fa',
    '/api/auth/admin/totp/verify', '/api/auth/admin/mfa/verify', '/api/auth/admin/login/two-factor',
  ];
  for (const path of paths) {
    const r = await fetch(BASE + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ challengeToken, code }),
    });
    if (r.status === 404) { console.log(`2FA: ${path} -> 404`); continue; }
    if (r.ok) {
      const c = cookiesDe(r);
      console.log(`2FA OK em ${path}${env('BO_2FA_PATH') ? '' : ' (crie a variável BO_2FA_PATH com esse valor)'}`);
      if (c.length) return c.join('; ');
      throw new Error(`2FA aceito em ${path} mas sem cookie de sessão`);
    }
    throw new Error(`2FA falhou em ${path}: ${await resumoErro(r)}`);
  }
  throw new Error('Não encontrei o endereço de verificação do 2FA');
}

// Último pedido de saque de jogador real (qualquer status), ignorando usuários de teste
async function lastWithdrawal(cookie) {
  const res = await fetch(`${BASE}/api/admin/transactions?type=WITHDRAW&page=1&limit=50`, { headers: { cookie, accept: 'application/json' } });
  if (!res.ok) throw new Error(`API de saques respondeu HTTP ${res.status}`);
  const { data = [] } = await res.json();
  return data
    .filter(t => !t.user?.isTestUser)
    .reduce((a, t) => (!a || t.createdAt > a.createdAt ? t : a), null);
}

const hora = ms => Number(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hourCycle: 'h23' }).format(new Date(ms)));
const madrugada = ms => { const h = hora(ms); return NIGHT_START < NIGHT_END ? h >= NIGHT_START && h < NIGHT_END : h >= NIGHT_START || h < NIGHT_END; };

const tempo = m => (m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}` : `${m} min`);

try {
  const last = await lastWithdrawal(await getCookie());
  if (state.lastErrorAlert) await push({ title: '✅ Monitor de saques voltou', body: 'O acesso ao backoffice voltou a funcionar.', tag: 'erro' });
  next.lastErrorAlert = 0;

  const minSemSaque = last ? Math.floor((now - new Date(last.createdAt).getTime()) / 60000) : Infinity;
  console.log(`Último pedido de saque: ${last?.createdAt || 'nenhum'} (${tempo(minSemSaque)} atrás)`);

  // Usa o limite da madrugada se agora é madrugada ou se o último saque foi de madrugada
  const noturno = madrugada(now) || (last && madrugada(new Date(last.createdAt).getTime()));
  const limiteHoras = noturno ? Math.max(NIGHT_HOURS, NO_WITHDRAW_HOURS) : NO_WITHDRAW_HOURS;
  console.log(`Limite atual: ${limiteHoras}h (${noturno ? 'madrugada' : 'dia'}, fuso ${TZ})`);

  if (minSemSaque >= limiteHoras * 60) {
    if (now - next.lastGapAlert >= REPEAT_MINUTES * 60000) {
      await push({
        title: '⚠️ Nenhum saque há ' + tempo(minSemSaque),
        body: `Ninguém pediu saque nas últimas ${tempo(minSemSaque)}. Confira se o saque está funcionando.`,
        tag: 'sem-saque',
      });
      next.lastGapAlert = now;
    }
  } else if (next.lastGapAlert) {
    await push({ title: '✅ Saques voltaram', body: 'Entrou um novo pedido de saque.', tag: 'sem-saque' });
    next.lastGapAlert = 0;
  }
} catch (e) {
  console.error(e);
  if (now - next.lastErrorAlert >= REPEAT_MINUTES * 60000) {
    await push({ title: '❌ Monitor de saques com erro', body: e.message, tag: 'erro' });
    next.lastErrorAlert = now;
  }
}

fs.mkdirSync('state', { recursive: true });
fs.writeFileSync(STATE_FILE, JSON.stringify(next));
