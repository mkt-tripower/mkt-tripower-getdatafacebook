'use strict';
/*
 * fb.js — lớp gọi Facebook Graph API dùng chung.
 * Token USER lấy từ biến môi trường FB_USER_TOKEN (đặt ở GitHub Secrets, không nằm trong code).
 */
const VERSION = process.env.FB_VERSION || 'v21.0';
const GRAPH = `https://graph.facebook.com/${VERSION}`;
const USER_TOKEN = process.env.FB_USER_TOKEN || '';

async function call(url, opt) {
  const r = await fetch(url, opt);
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { j = { _raw: t }; }
  if (!r.ok || j.error) {
    const e = j.error || {};
    throw new Error(`FB ${r.status} ${e.type || ''} (code ${e.code || '?'}): ${e.message || j._raw || t}`.slice(0, 400));
  }
  return j;
}

/** GET /{path} kèm token; tự đi hết phân trang, gộp data. `limit` = trần số bản ghi (0 = hết). */
async function getAll(path, params, tokenStr, limit = 0) {
  const qs = new URLSearchParams({ ...params, access_token: tokenStr || USER_TOKEN });
  let url = `${GRAPH}/${path}?${qs}`;
  const out = [];
  while (url) {
    const j = await call(url);
    out.push(...(j.data || []));
    if (limit && out.length >= limit) return out.slice(0, limit);
    url = (j.paging && j.paging.next) || '';
  }
  return out;
}

async function get(path, params, tokenStr) {
  const qs = new URLSearchParams({ ...params, access_token: tokenStr || USER_TOKEN });
  return call(`${GRAPH}/${path}?${qs}`);
}

/** Kiểm tra token trước khi chạy — hỏng token thì báo ngay, không để lỗi mơ hồ ở giữa chừng. */
async function checkToken() {
  if (!USER_TOKEN) throw new Error('Thiếu FB_USER_TOKEN (đặt ở GitHub Secrets).');

  // debug_token cho biết hạn dùng dữ liệu, nhưng Facebook CHỈ cho owner/developer của app
  // soi token của app đó (lỗi code 100). Token vẫn dùng bình thường, nên đừng chết ở đây:
  // lùi sang /me/permissions — vẫn lấy đủ danh sách quyền để requireScopes() làm việc.
  let j;
  try {
    j = await call(`${GRAPH}/debug_token?input_token=${encodeURIComponent(USER_TOKEN)}&access_token=${encodeURIComponent(USER_TOKEN)}`);
  } catch (e) {
    if (!/code 100|owner or developer/i.test(e.message)) throw e;
    const me = await get('me', { fields: 'id' });
    const perm = await get('me/permissions', {});
    const scopes = (perm.data || []).filter(x => x.status === 'granted').map(x => x.permission);
    if (!scopes.length) throw new Error('FB_USER_TOKEN không hợp lệ / đã hết hạn → cấp lại token rồi cập nhật Secret.');
    return { scopes, dataAccessExpires: 'không soi được (token của app khác)', userId: me.id };
  }

  const d = j.data || {};
  if (!d.is_valid) throw new Error('FB_USER_TOKEN không hợp lệ / đã hết hạn → cấp lại token rồi cập nhật Secret.');
  const exp = d.data_access_expires_at ? new Date(d.data_access_expires_at * 1000).toISOString().slice(0, 10) : '?';
  return { scopes: d.scopes || [], dataAccessExpires: exp, userId: d.user_id };
}

/** Ném lỗi nếu token thiếu quyền cần thiết — tránh chạy nửa vời rồi trả bảng rỗng. */
function requireScopes(info, needed) {
  const miss = needed.filter(s => !info.scopes.includes(s));
  if (miss.length) {
    throw new Error(
      `FB_USER_TOKEN thiếu quyền: ${miss.join(', ')}.\n` +
      `   → Vào Graph API Explorer, cấp lại token có đủ các quyền này rồi cập nhật Secret FB_USER_TOKEN.`
    );
  }
}

/** Danh sách Page mà user quản lý, kèm token riêng của từng Page. */
const pages = () =>
  getAll('me/accounts', { fields: 'id,name,access_token,category,followers_count,fan_count,picture.type(large){url}', limit: '100' });

/** Bài đã đăng của 1 Page (kèm reaction tách theo loại). */
const REACTS = [['LIKE', 'r_like'], ['LOVE', 'r_love'], ['HAHA', 'r_haha'], ['WOW', 'r_wow'], ['SAD', 'r_sad'], ['ANGRY', 'r_angry'], ['CARE', 'r_care']];
function posts(pageId, pageToken, max) {
  const rf = REACTS.map(([t, a]) => `reactions.type(${t}).summary(total_count).limit(0).as(${a})`).join(',');
  const fields = [
    'id', 'message', 'permalink_url', 'created_time', 'full_picture', 'shares',
    'comments.summary(total_count).limit(0)',
    'reactions.summary(total_count).limit(0).as(reactions)',
    rf,
  ].join(',');
  return getAll(`${pageId}/published_posts`, { fields, limit: '50' }, pageToken, max);
}

/** Tài khoản quảng cáo của user. */
const adAccounts = () =>
  getAll('me/adaccounts', { fields: 'id,account_id,name,currency,amount_spent,created_time,account_status', limit: '100' });

/** Số liệu quảng cáo theo NGÀY (mỗi dòng = 1 ad × 1 ngày). */
const INSIGHT_FIELDS = [
  'ad_id', 'ad_name', 'adset_id', 'adset_name', 'campaign_id', 'campaign_name',
  'account_id', 'account_name', 'spend', 'cpm', 'cpc', 'ctr', 'frequency',
  'impressions', 'clicks', 'reach', 'actions', 'action_values', 'date_start', 'date_stop',
].join(',');
function insights(actId, { datePreset = 'last_30d', since = '', until = '' } = {}) {
  const p = { fields: INSIGHT_FIELDS, level: 'ad', time_increment: '1', limit: '200' };
  if (since && until) p.time_range = JSON.stringify({ since, until });
  else p.date_preset = datePreset;
  return getAll(`${actId}/insights`, p);
}

/** Cộng dồn các action_type khớp — FB đặt tên loại action rất lắt léo nên gom nhiều biến thể. */
function sumActions(list, patterns) {
  if (!Array.isArray(list)) return 0;
  let s = 0;
  for (const a of list) if (patterns.some(p => p.test(a.action_type))) s += Number(a.value || 0);
  return s;
}

const ACTION = {
  mess: [/^onsite_conversion\.messaging_conversation_started_7d$/, /^onsite_conversion\.total_messaging_connection$/],
  follow: [/^onsite_conversion\.post_net_like$/, /^like$/, /^follow$/, /^page_like$/],
  purchase: [/^purchase$/, /^omni_purchase$/, /^offsite_conversion\.fb_pixel_purchase$/],
  pageEngagement: [/^page_engagement$/],
};

module.exports = { VERSION, GRAPH, USER_TOKEN, call, get, getAll, checkToken, requireScopes, pages, posts, adAccounts, insights, sumActions, ACTION };
