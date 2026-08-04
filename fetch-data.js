/* ============================================================
   Futura UpperFunnel - Robot de datos (GitHub Actions)
   Pide los datos a Meta (Graph API) y genera futura-data.js
   en el mismo formato que consume el reporte (index.html).
   No requiere PC del usuario ni Claude. Corre en la nube.
   ============================================================ */

const AD_ACCOUNT_ID = process.env.AD_ACCOUNT_ID || '1270090183944073';
const TOKEN = process.env.META_TOKEN;
const API = 'https://graph.facebook.com/v21.0';
const YEAR_START_MONDAY = '2025-12-29'; // lunes de la semana 1 de 2026
const CHUNK_WEEKS = 4;                   // semanas por bloque (evita respuestas enormes)
const PREVIEW_MAX = 60;                  // nº de anuncios con preview

if (!TOKEN) { console.error('FALTA META_TOKEN'); process.exit(1); }

/* ---------- utilidades ---------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));
function isoAddDays(iso, n){ const d = new Date(iso+'T00:00:00Z'); d.setUTCDate(d.getUTCDate()+n); return d.toISOString().slice(0,10); }
function todayISO(){ return new Date().toISOString().slice(0,10); }
// formato "es" (miles con '.', decimal ',') para que el reporte lo parsee igual que el conector
function esNum(n, dec=0){ return Number(n).toLocaleString('de-DE', {minimumFractionDigits:dec, maximumFractionDigits:dec}); }
function fmtSpend(n){ return '$' + esNum(n, 2) + ' MXN'; }

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
        // reintentar solo errores transitorios
        const code = json.error.code;
        if (![1,2,4,17,341,368].includes(code)) throw lastErr;
        continue;
      }
      return json;
    }catch(e){ lastErr = e; }
  }
  throw lastErr;
}

// pagina todas las filas de un endpoint /insights
async function graphAll(path, params){
  let rows = [];
  let after = null;
  do{
    const p = { ...params, limit: 300 };
    if (after) p.after = after;
    const json = await graph(path, p);
    if (json.data) rows = rows.concat(json.data);
    after = json.paging && json.paging.cursors && json.paging.next ? json.paging.cursors.after : null;
  } while (after);
  return rows;
}

/* ---------- MQL ---------- */
// valor de la acción QualifiedLead (evento de píxel). En la API cruda viene
// separada de los "meta leads", así que se toma directa (sin restar).
function qlValue(actions){
  if (!Array.isArray(actions)) return 0;
  let v = 0;
  for (const a of actions){
    if (a && typeof a.action_type === 'string' && /qualifiedlead/i.test(a.action_type)){
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

/* ---------- insights ---------- */
const INSIGHT_FIELDS = 'ad_id,ad_name,adset_id,campaign_id,impressions,reach,spend,clicks,actions';

async function fetchInsights(timeIncrement, since, until){
  const raw = await graphAll(`act_${AD_ACCOUNT_ID}/insights`, {
    level: 'ad',
    fields: INSIGHT_FIELDS,
    time_increment: timeIncrement,
    time_range: JSON.stringify({ since, until }),
  });
  // solo mx_/co_ con impresiones > 0
  return raw.filter(r => country(r.ad_name) && (parseFloat(r.impressions)||0) > 0);
}

// convierte una fila cruda de Graph al formato que espera el reporte
function toReportRow(r, qlCampaigns){
  const ql = qlValue(r.actions);
  const inProgram = qlCampaigns.has(String(r.campaign_id));
  const resultsLabel = inProgram ? `${ql} (QualifiedLead)` : `0 (Otros)`;
  return {
    id: r.ad_id,
    name: r.ad_name,
    adset_id: r.adset_id,
    campaign_id: r.campaign_id,
    creative_id: null, // se rellena luego
    impressions: esNum(r.impressions),
    reach: esNum(r.reach || 0),
    amount_spent: fmtSpend(r.spend || 0),
    clicks: esNum(r.clicks || 0),
    'actions:link_click': esNum(linkClicks(r.actions)),
    results: { value: resultsLabel },
    onsite_conversion_lead_grouped: 'Not available',
    date_start: r.date_start,
    date_stop: r.date_stop,
  };
}

/* ---------- main ---------- */
(async () => {
  const today = todayISO();
  console.log('=== Robot Futura: inicio', new Date().toISOString(), '===');

  // 1) WEEKLY por bloques
  let weeklyRaw = [];
  let start = YEAR_START_MONDAY;
  while (start <= today){
    const end = isoAddDays(start, CHUNK_WEEKS*7 - 1);
    const until = end < today ? end : today;
    console.log(`Weekly bloque ${start} -> ${until}`);
    const rows = await fetchInsights('7', start, until);
    weeklyRaw = weeklyRaw.concat(rows);
    start = isoAddDays(start, CHUNK_WEEKS*7);
  }
  console.log('Weekly filas:', weeklyRaw.length);

  // 2) MONTHLY
  console.log('Monthly...');
  const monthlyRaw = await fetchInsights('monthly', '2026-01-01', today);
  console.log('Monthly filas:', monthlyRaw.length);

  // 3) Campañas QL-program = las que tienen >=1 QualifiedLead en cualquier fila
  const qlCampaigns = new Set();
  for (const r of weeklyRaw.concat(monthlyRaw)){
    if (qlValue(r.actions) > 0) qlCampaigns.add(String(r.campaign_id));
  }
  console.log('Campañas QL detectadas:', qlCampaigns.size);

  // 4) Nombres de campañas
  const campsData = await graphAll(`act_${AD_ACCOUNT_ID}/campaigns`, { fields: 'id,name' });
  const campaigns = {};
  campsData.forEach(c => { campaigns[String(c.id)] = c.name; });

  // 5) Anuncios -> mapa ad_id->creative_id y detalles de creativos
  const adsData = await graphAll(`act_${AD_ACCOUNT_ID}/ads`, { fields: 'id,creative{id,thumbnail_url,body,title}' });
  const adCreative = {};   // ad_id -> creative_id
  const creatives = {};    // creative_id -> {thumb, body, title}
  adsData.forEach(a => {
    if (a.creative && a.creative.id){
      adCreative[String(a.id)] = String(a.creative.id);
      creatives[String(a.creative.id)] = {
        thumb: a.creative.thumbnail_url || null,
        body: a.creative.body || null,
        title: a.creative.title || null,
      };
    }
  });

  // 6) Convertir filas al formato del reporte + adjuntar creative_id
  const weekly = weeklyRaw.map(r => { const o = toReportRow(r, qlCampaigns); o.creative_id = adCreative[String(r.ad_id)] || null; return o; });
  const monthly = monthlyRaw.map(r => { const o = toReportRow(r, qlCampaigns); o.creative_id = adCreative[String(r.ad_id)] || null; return o; });

  // 7) Previews de los anuncios con más gasto en las últimas 6 semanas
  const sixWeeksAgo = isoAddDays(today, -42);
  const spendByAd = {};
  weeklyRaw.forEach(r => {
    if ((r.date_start||'') >= sixWeeksAgo){
      spendByAd[r.ad_id] = (spendByAd[r.ad_id]||0) + (parseFloat(r.spend)||0);
    }
  });
  const topAds = Object.entries(spendByAd).sort((a,b)=>b[1]-a[1]).slice(0, PREVIEW_MAX).map(x=>x[0]);
  const previews = {};
  for (const adId of topAds){
    try{
      const json = await graph(`${adId}/previews`, { ad_format: 'MOBILE_FEED_STANDARD' });
      const body = json.data && json.data[0] && json.data[0].body;
      if (body){
        const m = body.match(/src="([^"]+)"/);
        if (m) previews[adId] = m[1].replace(/&amp;/g,'&');
      }
    }catch(e){ /* si falla uno, seguimos */ }
  }
  console.log('Previews:', Object.keys(previews).length);

  // 8) Ensamblar y escribir futura-data.js
  const now = new Date();
  const generated = `${String(now.getUTCDate()).padStart(2,'0')}/${String(now.getUTCMonth()+1).padStart(2,'0')}/${now.getUTCFullYear()} ${String(now.getUTCHours()).padStart(2,'0')}:${String(now.getUTCMinutes()).padStart(2,'0')} UTC`;
  const snap = { generated, campaigns, weekly, monthly, creatives, previews };
  const out = 'window.__FUTURA_SNAPSHOT__=' + JSON.stringify(snap) + ';';
  require('fs').writeFileSync('futura-data.js', out);
  console.log('=== futura-data.js generado:', out.length, 'bytes | weekly:', weekly.length, '| generated:', generated, '===');
})().catch(e => { console.error('ERROR FATAL:', e); process.exit(1); });
