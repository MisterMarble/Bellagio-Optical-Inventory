// Bellagio Stock Check with OCR + bundled CSV baseline

const DB_NAME = 'bellagio-stock-ocr-v3';
const DB_VER = 1;
let db;

function openDB(){
  return new Promise((resolve,reject)=>{
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = (e)=>{
      const d = e.target.result;
      if(!d.objectStoreNames.contains('slabs')){
        d.createObjectStore('slabs', { keyPath:'combined_id' });
      }
      if(!d.objectStoreNames.contains('dictionary')){
        const store = d.createObjectStore('dictionary', { keyPath:'key' });
        store.put({ key:'materials', values: [] });
      }
    };
    req.onsuccess = (e)=>{ db = e.target.result; resolve(); };
    req.onerror = ()=>reject(req.error);
  });
}

function tx(store, mode='readonly'){
  return db.transaction(store, mode).objectStore(store);
}

// --- Data helpers ---

async function putManySlabs(records){
  return new Promise((resolve,reject)=>{
    const store = tx('slabs','readwrite');
    records.forEach(r=>store.put(r));
    store.transaction.oncomplete = ()=>resolve();
    store.transaction.onabort = store.transaction.onerror = ()=>reject(store.transaction.error);
  });
}

async function getAllSlabs(){
  return new Promise((resolve,reject)=>{
    const out = [];
    const req = tx('slabs').openCursor();
    req.onsuccess = e=>{
      const cur = e.target.result;
      if(cur){ out.push(cur.value); cur.continue(); } else resolve(out);
    };
    req.onerror = ()=>reject(req.error);
  });
}

async function clearAllSlabs(){
  return new Promise((resolve,reject)=>{
    const store = tx('slabs','readwrite');
    const req = store.clear();
    req.onsuccess = ()=>resolve();
    req.onerror = ()=>reject(req.error);
  });
}

async function getSlab(combinedId){
  return new Promise((resolve,reject)=>{
    const req = tx('slabs').get(combinedId);
    req.onsuccess = ()=>resolve(req.result || null);
    req.onerror = ()=>reject(req.error);
  });
}

async function updateSlab(rec){
  return new Promise((resolve,reject)=>{
    const store = tx('slabs','readwrite');
    const req = store.put(rec);
    req.onsuccess = ()=>resolve();
    req.onerror = ()=>reject(req.error);
  });
}

// Materials dict

async function loadMaterials(){
  return new Promise((resolve,reject)=>{
    const req = tx('dictionary').get('materials');
    req.onsuccess = ()=>resolve(req.result?.values || []);
    req.onerror = ()=>reject(req.error);
  });
}

async function saveMaterials(list){
  return new Promise((resolve,reject)=>{
    const store = tx('dictionary','readwrite');
    const req = store.put({ key:'materials', values:list });
    req.onsuccess = ()=>resolve();
    req.onerror = ()=>reject(req.error);
  });
}

async function addMaterialName(name){
  const up = name.trim();
  if(!up) return;
  const list = await loadMaterials();
  if(!list.includes(up)) {
    list.push(up);
    await saveMaterials(list);
    populateMaterialSuggestions();
  }
}

// --- UI helpers ---

function $(id){ return document.getElementById(id); }

function toTitle(s){
  return s.toLowerCase().replace(/\b\w/g,c=>c.toUpperCase()).replace(/\s+/g,' ').trim();
}

function populateMaterialSuggestions(){
  loadMaterials().then(list=>{
    const dl = $('materialList');
    if(!dl) return;
    dl.innerHTML = list.map(x=>`<option value="${toTitle(x)}">`).join('');
  }).catch(()=>{});
}

function applyFilters(rows){
  const batchF = $('fltBatch').value.trim().toUpperCase();
  const slabF = $('fltSlab').value.trim().toUpperCase();
  const matF = $('fltMaterial').value.trim().toUpperCase();
  const statusF = $('fltStatus').value;

  return rows.filter(r=>{
    const status = r.status || 'available';
    const seen = !!r.last_seen;

    if(batchF && !String(r.batch_number || '').toUpperCase().includes(batchF)) return false;
    if(slabF && !String(r.slab_number || '').toUpperCase().includes(slabF)) return false;
    if(matF && !String(r.material || '').toUpperCase().includes(matF)) return false;

    if(statusF === 'available' && status !== 'available') return false;
    if(statusF === 'used' && status !== 'used') return false;
    if(statusF === 'seen' && !seen) return false;
    if(statusF === 'missing' && seen) return false;

    return true;
  });
}

function updateCounters(allRows){
  const total = allRows.length;
  const available = allRows.filter(r=>(r.status||'available') === 'available').length;
  const used = allRows.filter(r=>r.status === 'used').length;
  const seen = allRows.filter(r=>!!r.last_seen).length;
  const missing = total - seen;

  $('countTotal').textContent = `Total: ${total}`;
  $('countAvailable').textContent = `Available: ${available}`;
  $('countUsed').textContent = `Used: ${used}`;
  $('countSeen').textContent = `Seen: ${seen}`;
  $('countMissing').textContent = `Missing: ${missing}`;
}

async function renderRows(allRows){
  const filtered = applyFilters(allRows);
  const tb = $('rows');
  const nowRows = filtered.map(r=>{
    const status = r.status || 'available';
    const statusClass = status === 'used' ? 'used' : 'available';
    const seen = !!r.last_seen;
    const trClass = [
      status === 'used' ? 'used' : '',
      !seen ? 'missing' : ''
    ].filter(Boolean).join(' ');
    const seenLabel = seen ? 'Seen' : 'Missing';
    const seenClass = seen ? 'seen' : 'missing';
    return `
      <tr data-id="${r.combined_id}" class="${trClass}">
        <td>${r.slab_number || ''}</td>
        <td>${r.batch_number || ''}</td>
        <td>${r.material || ''}</td>
        <td>${r.dimensions || ''}</td>
        <td>${r.thickness_mm || ''}</td>
        <td class="status-cell"><span class="${statusClass}">${status}</span></td>
        <td><span class="badge ${seenClass}">${seenLabel}</span></td>
      </tr>`;
  }).join('');
  tb.innerHTML = nowRows;

  $('emptyState').style.display = allRows.length ? 'none' : 'block';
  updateCounters(allRows);
}

// --- CSV import / export ---

function parseCSV(text){
  const lines = text.split(/\r?\n/).filter(l=>l.trim().length);
  if(!lines.length) return [];
  const headers = lines[0].split(',').map(h=>h.trim().toLowerCase());
  const getIndex = name => headers.indexOf(name.toLowerCase());

  const idxCombined = getIndex('combined_id');
  const idxSlab = getIndex('slab_number');
  const idxBatch = getIndex('batch_number');
  const idxMaterial = getIndex('material_name');
  const idxSize = getIndex('size_mm');
  const idxThick = getIndex('thickness_mm');
  const idxColour = getIndex('colour_family');
  const idxLoc = getIndex('location');
  const idxRecv = getIndex('received_date');
  const idxNotes = getIndex('notes');

  const rows = [];
  for(let i=1;i<lines.length;i++){
    const parts = lines[i].split(',');
    if(!parts.length) continue;
    const get = idx => idx>=0 && idx<parts.length ? parts[idx].trim() : '';
    let combined = get(idxCombined);
    const slab = get(idxSlab);
    const batch = get(idxBatch);
    if(!combined){
      if(slab && batch) combined = slab + '/' + batch;
      else combined = slab || batch || `row_${i}`;
    }
    const material = get(idxMaterial);
    const size = get(idxSize);
    const thick = get(idxThick);
    const colour = get(idxColour);
    const loc = get(idxLoc);
    const recv = get(idxRecv);
    const notes = get(idxNotes);

    rows.push({
      combined_id: combined,
      slab_number: slab,
      batch_number: batch,
      material: material,
      dimensions: size,
      thickness_mm: thick,
      colour_family: colour,
      location: loc,
      received_date: recv,
      notes: notes,
      status: 'available',
      last_seen: null,
      raw_ocr_text: '',
      ocr_confidence: 0,
      source: 'csv'
    });
  }
  return rows;
}

function toCSV(rows){
  const header = [
    'combined_id','slab_number','batch_number',
    'material_name','size_mm','thickness_mm',
    'colour_family','location','received_date','notes',
    'status','last_seen','missing'
  ].join(',') + '\n';

  const lines = rows.map(r=>{
    const missing = r.last_seen ? '' : 'missing';
    const vals = [
      r.combined_id || '',
      r.slab_number || '',
      r.batch_number || '',
      r.material || '',
      r.dimensions || '',
      r.thickness_mm || '',
      r.colour_family || '',
      r.location || '',
      r.received_date || '',
      r.notes || '',
      r.status || 'available',
      r.last_seen || '',
      missing
    ];
    return vals.map(v=>{
      const t = String(v).replace(/\r?\n/g,' ').trim();
      return '"' + t.replace(/"/g,'""') + '"';
    }).join(',');
  });
  return header + lines.join('\n');
}

function download(filename, text){
  const blob = new Blob([text],{type:'text/csv;charset=utf-8'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// --- OCR helpers ---

let mediaStream = null;

async function openScanner(){
  const dlg = $('scanModal');
  dlg.showModal();
  try{
    mediaStream = await navigator.mediaDevices.getUserMedia({ video:{ facingMode:'environment' } });
    $('scanVideo').srcObject = mediaStream;
  }catch(e){
    alert('Cannot access camera: ' + e.message);
  }
}

function closeScanner(){
  try{ mediaStream?.getTracks()?.forEach(t=>t.stop()); }catch(e){}
  $('scanModal').close();
}

async function toggleTorch(){
  const track = mediaStream?.getVideoTracks?.[0];
  const caps = track?.getCapabilities?.();
  if(!caps || !caps.torch) return;
  const settings = track.getSettings();
  await track.applyConstraints({ advanced:[{ torch: !settings.torch }] });
}

function getRoiRect(video, roiEl){
  const v = video.getBoundingClientRect();
  const r = roiEl.getBoundingClientRect();
  const rx = r.left - v.left, ry = r.top - v.top, rw = r.width, rh = r.height;
  const scaleX = video.videoWidth / v.width;
  const scaleY = video.videoHeight / v.height;
  return {
    sx: Math.max(0, Math.floor(rx * scaleX)),
    sy: Math.max(0, Math.floor(ry * scaleY)),
    sw: Math.max(1, Math.floor(rw * scaleX)),
    sh: Math.max(1, Math.floor(rh * scaleY))
  };
}

function captureFrame(){
  const video = $('scanVideo');
  if(!video.videoWidth || !video.videoHeight) return null;
  const roi = $('roi');
  const { sx, sy, sw, sh } = getRoiRect(video, roi);
  const canvas = $('scanCanvas');
  canvas.width = sw;
  canvas.height = sh;
  const ctx = canvas.getContext('2d',{ willReadFrequently:true });
  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh);
  return canvas;
}

let ocrWorker = null;

async function getOCRWorker(){
  if(ocrWorker) return ocrWorker;
  const { createWorker } = Tesseract;
  ocrWorker = await createWorker({ logger:m=>console.debug('OCR',m) });
  await ocrWorker.load();
  await ocrWorker.loadLanguage('eng');
  await ocrWorker.initialize('eng');
  await ocrWorker.setParameters({
    tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789#-/ .()×x'
  });
  return ocrWorker;
}

async function runOCR(canvas){
  const worker = await getOCRWorker();
  const { data } = await worker.recognize(canvas);
  const text = (data?.text || '').trim();
  const conf = Math.round(data?.confidence ?? 0);
  return { text, confidence: conf };
}

function normaliseOCRText(txt){
  return txt.toUpperCase().replace(/×/g,'x').replace(/\s+/g,' ').trim();
}

function parseGeneric(text){
  const src = normaliseOCRText(text);

  // Expecting something like "00925/6217" somewhere
  const mCombined = src.match(/\b\d{3,5}\/\d{3,5}\b/);
  const combined_id = mCombined ? mCombined[0] : '';

  const mSlab = src.match(/\b\d{3,5}(?=\/)/);
  const slab_number = mSlab ? mSlab[0] : '';

  const mBatch = src.match(/\/(\d{3,5})\b/);
  const batch_number = mBatch ? mBatch[1] : '';

  const mDim = src.match(/(\d{3,4})\s*x\s*(\d{3,4})/);
  const dimensions = mDim ? `${mDim[1]}x${mDim[2]}` : '';

  const mTh = src.match(/(\d+(?:\.\d+)?)\s*(CM|MM)\b/);
  let thickness_mm = '';
  if(mTh){
    const val = parseFloat(mTh[1]);
    thickness_mm = (mTh[2] === 'CM') ? String(Math.round(val*10)) : String(Math.round(val));
  }

  return {
    combined_id,
    slab_number,
    batch_number,
    dimensions,
    thickness_mm,
    raw_ocr_text: text
  };
}

async function matchOCRToSlab(parsed){
  if(!parsed.combined_id) return null;
  const cId = parsed.combined_id.trim();
  if(!cId) return null;
  const rec = await getSlab(cId);
  return rec;
}

// --- Main init / event wiring ---

async function reloadAndRender(){
  const rows = await getAllSlabs();
  await renderRows(rows);
}

async function toggleRowStatus(combinedId){
  if(!combinedId) return;
  const rec = await getSlab(combinedId);
  if(!rec) return;
  rec.status = (rec.status === 'used') ? 'available' : 'used';
  await updateSlab(rec);
  await reloadAndRender();
}

async function markSeen(rec, status, rawText, confidence){
  rec.status = status || rec.status || 'available';
  rec.last_seen = new Date().toISOString();
  rec.raw_ocr_text = rawText || rec.raw_ocr_text || '';
  rec.ocr_confidence = typeof confidence==='number' ? confidence : (rec.ocr_confidence||0);
  rec.source = rec.source || 'csv';
  await updateSlab(rec);
  await reloadAndRender();
}

async function ensureBaselineLoaded(){
  const rows = await getAllSlabs();
  if(rows.length) return; // already loaded

  // Fetch bundled CSV
  try{
    const resp = await fetch('data/slabs.csv');
    if(!resp.ok){
      console.error('Failed to fetch data/slabs.csv', resp.status);
      return;
    }
    const text = await resp.text();
    const parsed = parseCSV(text);
    if(!parsed.length){
      console.warn('No rows parsed from bundled CSV');
      return;
    }
    await putManySlabs(parsed);

    // Build materials dict
    const mats = Array.from(new Set(parsed.map(r=>r.material).filter(Boolean))).map(m=>m.toUpperCase());
    await saveMaterials(mats);
    populateMaterialSuggestions();
  }catch(err){
    console.error('Error loading bundled CSV', err);
  }
}

async function init(){
  await openDB();
  await ensureBaselineLoaded();
  populateMaterialSuggestions();
  await reloadAndRender();

  // Import CSV (optional, overrides current)
  $('btnImport').addEventListener('click', ()=> $('fileImport').click());
  $('fileImport').addEventListener('change', async (e)=>{
    const file = e.target.files[0];
    if(!file) return;
    if(!confirm('Import this CSV and replace existing slabs on this device?')) {
      e.target.value = '';
      return;
    }
    const text = await file.text();
    const rows = parseCSV(text);
    await clearAllSlabs();
    await putManySlabs(rows);

    // rebuild materials list from CSV
    const mats = Array.from(new Set(rows.map(r=>r.material).filter(Boolean))).map(m=>m.toUpperCase());
    await saveMaterials(mats);
    populateMaterialSuggestions();

    e.target.value = '';
    await reloadAndRender();
  });

  // Scanner
  $('btnScan').addEventListener('click', openScanner);
  $('btnCloseScan').addEventListener('click', closeScanner);
  $('btnTorch').addEventListener('click', toggleTorch);
  $('btnCapture').addEventListener('click', async ()=>{
    const canvas = captureFrame();
    if(!canvas){ alert('No frame captured.'); return; }
    const { text, confidence } = await runOCR(canvas);
    closeScanner();
    const parsed = parseGeneric(text);
    const match = await matchOCRToSlab(parsed);
    if(!match){
      $('ocrSummary').textContent = 'No matching slab found for combined ID: ' + (parsed.combined_id || '(not detected)');
      $('cfCombined').value = parsed.combined_id || '';
      $('cfSlab').value = parsed.slab_number || '';
      $('cfBatchNo').value = parsed.batch_number || '';
      $('cfMaterial').value = '';
      $('cfDims').value = parsed.dimensions || '';
      $('cfThick').value = parsed.thickness_mm || '';
    }else{
      $('ocrSummary').textContent = 'Matched slab from CSV.';
      $('cfCombined').value = match.combined_id || '';
      $('cfSlab').value = match.slab_number || '';
      $('cfBatchNo').value = match.batch_number || '';
      $('cfMaterial').value = match.material || '';
      $('cfDims').value = match.dimensions || '';
      $('cfThick').value = match.thickness_mm || '';
    }
    $('cfRaw').value = text;
    $('cfConf').value = String(confidence || 0);
    $('confirmModal').showModal();
  });

  $('btnCancelConfirm').addEventListener('click', ()=> $('confirmModal').close());
  $('confirmForm').addEventListener('submit', async (ev)=>{
    ev.preventDefault();
    const d = new FormData(ev.currentTarget);
    const combined_id = (d.get('combined_id') || '').toString().trim();
    if(!combined_id){
      alert('No combined ID detected. Cannot match to CSV.');
      return;
    }
    const rec = await getSlab(combined_id);
    if(!rec){
      alert('This combined ID does not exist in the current slabs data.');
      return;
    }
    const status = (d.get('status') || 'available').toString();
    const raw = (d.get('raw_ocr_text') || '').toString();
    const conf = Number(d.get('ocr_confidence') || 0);
    await markSeen(rec, status, raw, conf);
    $('confirmModal').close();
  });

  // Manual add (for slabs not in CSV)
  $('btnManual').addEventListener('click', ()=> $('manualModal').showModal());
  $('btnCancelManual').addEventListener('click', ()=> $('manualModal').close());
  $('manualForm').addEventListener('submit', async (ev)=>{
    ev.preventDefault();
    const d = new FormData(ev.currentTarget);
    const combined_id = (d.get('combined_id') || '').toString().trim();
    if(!combined_id){
      alert('Combined ID is required.');
      return;
    }
    const existing = await getSlab(combined_id);
    if(existing){
      alert('A slab with this combined ID already exists in the current data.');
      return;
    }
    const now = new Date().toISOString();
    const rec = {
      combined_id,
      slab_number: (d.get('slab_number') || '').toString().trim(),
      batch_number: (d.get('batch_number') || '').toString().trim(),
      material: (d.get('material') || '').toString().trim(),
      dimensions: (d.get('dimensions') || '').toString().trim(),
      thickness_mm: (d.get('thickness_mm') || '').toString().trim(),
      colour_family: '',
      location: '',
      received_date: '',
      notes: '',
      status: (d.get('status') || 'available').toString(),
      last_seen: now,
      raw_ocr_text: '',
      ocr_confidence: 100,
      source: 'manual'
    };
    await updateSlab(rec);
    if(rec.material) await addMaterialName(rec.material.toUpperCase());
    $('manualModal').close();
    await reloadAndRender();
  });

  // Export
  $('btnExport').addEventListener('click', async ()=>{
    const rows = await getAllSlabs();
    if(!rows.length){
      alert('No slabs to export.');
      return;
    }
    download('slabs-updated.csv', toCSV(rows));
  });

  // Clear all
  $('btnClear').addEventListener('click', async ()=>{
    if(!confirm('Clear all slabs from this device?')) return;
    await clearAllSlabs();
    await reloadAndRender();
  });

  // Row status toggle
  $('rows').addEventListener('click', async e=>{
    const cell = e.target.closest('td.status-cell');
    if(!cell) return;
    const tr = cell.closest('tr');
    if(!tr) return;
    const id = tr.getAttribute('data-id');
    await toggleRowStatus(id);
  });

  // Filters
  $('fltBatch').addEventListener('input', reloadAndRender);
  $('fltSlab').addEventListener('input', reloadAndRender);
  $('fltMaterial').addEventListener('input', reloadAndRender);
  $('fltStatus').addEventListener('change', reloadAndRender);
  $('btnClearFilters').addEventListener('click', ()=>{
    $('fltBatch').value = '';
    $('fltSlab').value = '';
    $('fltMaterial').value = '';
    $('fltStatus').value = '';
    reloadAndRender();
  });
}

document.addEventListener('DOMContentLoaded', init);
