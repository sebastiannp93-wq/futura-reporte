/* ============================================================
   Futura UpperFunnel - Robot de datos (GitHub Actions)
   Pide los datos a Meta (Graph API) y genera futura-data.js
   en el mismo formato que consume el reporte (index.html).
   ============================================================ */

const AD_ACCOUNT_ID = process.env.AD_ACCOUNT_ID || '1270090183944073';
const TOKEN = process.env.META_TOKEN;
const API = 'https://graph.facebook.com/v21.0';
const YEAR_START_MONDAY = '2025-12-29';
const CHUNK_WEEKS = 4;
const PREVIEW_MAX = 60;

if (!TOKEN) { console.error('FALTA META_TOKEN'); process.exit(1); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
function isoAddDays(iso, n){ const d = new Date(iso+'T00:00:00Z'); d.setUTCDate(d.getUTCDate()+n); return d.toISOString().slice(0,10); }
function todayISO(){ return new Date().toISOString().slice(0,10); }
function esNum(n, dec=0){ return Number(n).toLocaleString('de-DE', {minimumFractionDigits:dec, maximumFractionDigits:dec}); }
function fmtSpend(n){ return '$' + esNum(n, 2) + ' MXN'; }

async function graph(path, params, tries=4){
  const usp = new URLSearchParams({ ...params, access_token: TOKEN });
  const url = `${API}/${path}?${usp.toString()}`;
  let lastErr;
  for (let a=0; a<tries; a++){
    if (a) await sleep(a*3000);
    try{
      const res = await fetch(url);
      const json = await res.json();
      if (json.error){
        lastErr = new Error(`Graph error: ${JSON.stringify(json.error).slice(0,300)}`);
        const code = json.error.code;
        if (![1,2,4,17,341,368].includes(code)) throw lastErr;
        continue;
      }
      return json;
    }catch(e){ lastErr = e; }
  }
  throw lastErr;
}

async function graphAll(path, params){
  let rows = [];
  let after = null;
  do{
    const p = { ...params, limit: 300 };
    if (after) p.after = after;
    const json = await graph(path, p);
    if (json.data) rows = rows.concat(json.data);
    after = (json.paging && json.paging.next && json.paging.cursors) ? json.paging.cursors.after : null;
  } while (after);
  return rows;
}

// El evento QualifiedLead llega en la API directa bajo la etiqueta
// "offsite_conversion.fb_pixel_custom" (evento de píxel personalizado).
function qlValue(actions){
  if (!Array.isArray(actions)) return 0;
  let v = 0;
  for (const a of actions){
    const t = a && a.action_type;
    if (typeof t === 'string' && (/fb_pixel_custom/i.test(t) || /qualifiedlead/i.test(t) || /offsite_conversion\.custom\./i.test(t))){
      v += parseFloat(a.value) || 0;
    }
  }
  return v;
}
function linkClicks(actions){
  if (!Array.isArray(actions)) return 0;
  const a = actions.find(x => x.action_type === 'link_click');
  return a ? (parseFloat(a.value)||0) : 0;
}
function country(name){ const n=(name||'').toLowerCase(); if(n.startsWith('mx_'))return 'MX'; if(n.startsWith('co_'))return 'CO'; return null; }

const INSIGHT_FIELDS = 'ad_id,ad_name,adset_id,campaign_id,impressions,reach,spend,clicks,actions';

async function fetchInsights(timeIncrement, since, until){
  const raw = await graphAll(`act_${AD_ACCOUNT_ID}/insights`, {
    level: 'ad',
    fields: INSIGHT_FIELDS,
    time_increment: timeIncrement,
    time_range: JSON.stringify({ since, until }),
  });
  return raw.filter(r => country(r.ad_name) && (parseFloat(r.impressions)||0) > 0);
}

function toReportRow(r, qlCampaigns){
  const ql = qlValue(r.actions);
  const inProgram = qlCampaigns.has(String(r.campaign_id));
  const resultsLabel = inProgram ? `${ql} (QualifiedLead)` : `0 (Otros)`;
  return {
    id: r.ad_id, name: r.ad_name, adset_id: r.adset_id, campaign_id: r.campaign_id,
    creative_id: null,
    impressions: esNum(r.impressions),
    reach: esNum(r.reach || 0),
    amount_spent: fmtSpend(r.spend || 0),
    clicks: esNum(r.clicks || 0),
    'actions:link_click': esNum(linkClicks(r.actions)),
    results: { value: resultsLabel },
    onsite_conversion_lead_grouped: 'Not available',
    date_start: r.date_start, date_stop: r.date_stop,
  };
}

(async () => {
  const today = todayISO();
  console.log('=== Robot Futura: inicio', new Date().toISOString(), '===');

  let weeklyRaw = [];
  let start = YEAR_START_MONDAY;
  while (start <= today){
    const end = isoAddDays(start, CHUNK_WEEKS*7 - 1);
    const until = end < today ? end : today;
    console.log(`Weekly bloque ${start} -> ${until}`);
    weeklyRaw = weeklyRaw.concat(await fetchInsights('7', start, until));
    start = isoAddDays(start, CHUNK_WEEKS*7);
  }
  console.log('Weekly filas:', weeklyRaw.length);

  // --- AUTO-VALIDACIÓN: semana 15-21 jun (ya validada: MX 68, CO 9, total 77) ---
  let vMX=0, vCO=0, vUgly=0;
  weeklyRaw.filter(r => r.date_start === '2026-06-15').forEach(r => {
    const q = qlValue(r.actions); const c = country(r.ad_name);
    if (c==='MX') vMX += q; if (c==='CO') vCO += q;
    if (r.ad_name === 'mx_img_mt_ugly_abril_h4') vUgly += q;
  });
  console.log(`>>> VALIDACION semana 15-21 jun: MX=${vMX} CO=${vCO} TOTAL=${vMX+vCO} (esperado 68/9/77) | ugly_abril_h4=${vUgly} (esperado 7)`);
  // ---------------------------------------------------------------------------

  console.log('Monthly...');
  const monthlyRaw = await fetchInsights('monthly', '2026-01-01', today);
  console.log('Monthly filas:', monthlyRaw.length);

  const qlCampaigns = new Set();
  for (const r of weeklyRaw.concat(monthlyRaw)){
    if (qlValue(r.actions) > 0) qlCampaigns.add(String(r.campaign_id));
  }
  console.log('Campañas QL detectadas:', qlCampaigns.size);

  const campsData = await graphAll(`act_${AD_ACCOUNT_ID}/campaigns`, { fields: 'id,name' });
  const campaigns = {};
  campsData.forEach(c => { campaigns[String(c.id)] = c.name; });

  const adsData = await graphAll(`act_${AD_ACCOUNT_ID}/ads`, { fields: 'id,creative{id,thumbnail_url,body,title}' });
  const adCreative = {}; const creatives = {};
  adsData.forEach(a => {
    if (a.creative && a.creative.id){
      adCreative[String(a.id)] = String(a.creative.id);
      creatives[String(a.creative.id)] = { thumb: a.creative.thumbnail_url||null, body: a.creative.body||null, title: a.creative.title||null };
    }
  });

  const weekly = weeklyRaw.map(r => { const o = toReportRow(r, qlCampaigns); o.creative_id = adCreative[String(r.ad_id)]||null; return o; });
  const monthly = monthlyRaw.map(r => { const o = toReportRow(r, qlCampaigns); o.creative_id = adCreative[String(r.ad_id)]||null; return o; });

  const sixWeeksAgo = isoAddDays(today, -42);
  const spendByAd = {};
  weeklyRaw.forEach(r => { if ((r.date_start||'') >= sixWeeksAgo) spendByAd[r.ad_id] = (spendByAd[r.ad_id]||0) + (parseFloat(r.spend)||0); });
  const topAds = Object.entries(spendByAd).sort((a,b)=>b[1]-a[1]).slice(0, PREVIEW_MAX).map(x=>x[0]);
  const previews = {};
  for (const adId of topAds){
    try{
      const json = await graph(`${adId}/previews`, { ad_format: 'MOBILE_FEED_STANDARD' });
      const body = json.data && json.data[0] && json.data[0].body;
      if (body){ const m = body.match(/src="([^"]+)"/); if (m) previews[adId] = m[1].replace(/&amp;/g,'&'); }
    }catch(e){}
  }
  console.log('Previews:', Object.keys(previews).length);

  const now = new Date();
  const generated = `${String(now.getUTCDate()).padStart(2,'0')}/${String(now.getUTCMonth()+1).padStart(2,'0')}/${now.getUTCFullYear()} ${String(now.getUTCHours()).padStart(2,'0')}:${String(now.getUTCMinutes()).padStart(2,'0')} UTC`;
  const snap = { generated, campaigns, weekly, monthly, creatives, previews };
  require('fs').writeFileSync('futura-data.js', 'window.__FUTURA_SNAPSHOT__=' + JSON.stringify(snap) + ';');
  console.log('=== futura-data.js generado | weekly:', weekly.length, '| QL campañas:', qlCampaigns.size, '| generated:', generated, '===');
})().catch(e => { console.error('ERROR FATAL:', e); process.exit(1); });
