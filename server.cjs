const express = require('express');
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const app = express();

// --- CONFIGURATION ---
const port = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Arn903_346";
const MONGO_URI = process.env.MONGO_URI;

// Linkvertise Configuration
const LINKVERTISE_KEY_HOURS = 24; // How long keys from Linkvertise last (hours)

// Script Files
const FILE_HEADLESS = 'headless';
const FILE_NORMAL = 'read';
const FILE_SAFE = 'safe';
const FILE_CHAINSAW = 'chainsaw';
const FILE_SOLO = 'Solo';

// --- MONGODB CONNECTION ---
if (!MONGO_URI) {
    console.error("❌ CRITICAL ERROR: MONGO_URI is missing from Environment Variables!");
    console.error("   Please add it in Render Dashboard -> Environment Variables.");
} else {
    mongoose.connect(MONGO_URI, {
        serverSelectionTimeoutMS: 5000
    })
        .then(() => console.log("✅ Connected to MongoDB Atlas"))
        .catch(err => {
            console.error("❌ MongoDB Connection Error:", err);
            console.error("💡 HINT: Did you add 0.0.0.0/0 to MongoDB Network Access?");
        });

    mongoose.connection.on('error', err => console.error("❌ DB Runtime Error:", err));
}

// --- DATABASE SCHEMA ---
const keySchema = new mongoose.Schema({
    key: { type: String, required: true, unique: true },
    note: { type: String, default: "No Label" },
    hwid: { type: String, default: null },
    created_at: { type: Number, default: Date.now },
    expires: { type: Number, required: true }
});

const Key = mongoose.model('Key', keySchema);

// --- MIDDLEWARE ---
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- AUTH MIDDLEWARE ---
const requireAuth = (req, res, next) => {
    const pass = req.headers['authorization'] || req.query.pass;
    if (pass !== ADMIN_PASSWORD) {
        return res.status(403).json({ error: "Invalid Admin Password" });
    }
    next();
};

// --- API ROUTES (ADMIN) ---

// 1. Get All Keys
app.get('/api/keys', requireAuth, async (req, res) => {
    if (mongoose.connection.readyState !== 1) {
        return res.status(500).json({ error: "Database not connected. Check Render Logs for 'MongoDB Connection Error'." });
    }
    try {
        const keys = await Key.find({}).sort({ created_at: -1 });
        res.json(keys);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 2. Create Key
app.post('/api/create', requireAuth, async (req, res) => {
    try {
        const { days, note } = req.body;
        const durationDays = parseInt(days) || 30;

        const newKey = await Key.create({
            key: "KEY_" + Math.random().toString(36).substr(2, 8).toUpperCase(),
            note: note || "No Label",
            expires: Date.now() + (durationDays * 24 * 60 * 60 * 1000)
        });

        res.json({ success: true, key: newKey });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 3. Reset HWID
app.post('/api/reset', requireAuth, async (req, res) => {
    try {
        const { key } = req.body;
        const updated = await Key.findOneAndUpdate({ key: key }, { hwid: null }, { new: true });
        if (updated) res.json({ success: true });
        else res.status(404).json({ error: "Key not found" });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 4. Delete Key
app.post('/api/delete', requireAuth, async (req, res) => {
    try {
        const { key } = req.body;
        await Key.findOneAndDelete({ key: key });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 5. Update Note
app.post('/api/update', requireAuth, async (req, res) => {
    try {
        const { key, note } = req.body;
        const updated = await Key.findOneAndUpdate({ key: key }, { note: note }, { new: true });
        if (updated) res.json({ success: true });
        else res.status(404).json({ error: "Key not found" });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 6. Extend Key
app.post('/api/extend', requireAuth, async (req, res) => {
    try {
        const { key, days } = req.body;
        const kData = await Key.findOne({ key: key });
        if (!kData) return res.status(404).json({ error: "Key not found" });
        
        const now = Date.now();
        const base = kData.expires > now ? kData.expires : now;
        kData.expires = base + (parseInt(days) * 24 * 60 * 60 * 1000);
        await kData.save();
        res.json({ success: true, newExpires: kData.expires });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- SCRIPT DELIVERY LOGIC ---

async function validateKey(req, res) {
    const { key, hwid } = req.query;

    const MSG_DENIED = `<h1>⛔ ACCESS DENIED</h1><p>Invalid Key or missing parameters.</p>`;
    const MSG_LOCKED = `<h1>🔒 HWID LOCKED</h1><p>This key is linked to another device.</p>`;
    const MSG_EXPIRED = `<h1>⌛ KEY EXPIRED</h1><p>This key is no longer valid.</p>`;

    if (!key || !hwid) { res.status(403).send(MSG_DENIED); return false; }

    try {
        const kData = await Key.findOne({ key: key });

        if (!kData) { res.status(403).send(MSG_DENIED); return false; }

        if (Date.now() > kData.expires) {
            res.status(403).send(MSG_EXPIRED);
            return false;
        }

        if (!kData.hwid) {
            kData.hwid = hwid;
            await kData.save();
        } else if (kData.hwid !== hwid) {
            res.status(403).send(MSG_LOCKED);
            return false;
        }

        return true;
    } catch (e) {
        console.error(e);
        res.status(500).send("Database Error");
        return false;
    }
}

// --- LUA SCRIPT ROUTES ---

app.get('/headless', async (req, res) => {
    if (!await validateKey(req, res)) return;
    if (!fs.existsSync(FILE_HEADLESS)) return res.send("print('Error: Server missing headless.lua')");
    try {
        let lua = fs.readFileSync(FILE_HEADLESS, 'utf8');
        const debugInfo = `\nprint("[SERVER] Authenticated: ${req.query.key.substr(0, 8)}...")\n`;
        res.send(debugInfo + lua);
    } catch (e) { res.send("print('Error reading file')"); }
});

app.get('/script', async (req, res) => {
    if (!await validateKey(req, res)) return;
    if (fs.existsSync(FILE_NORMAL)) res.send(fs.readFileSync(FILE_NORMAL, 'utf8'));
    else res.send("print('Error: read.lua missing')");
});

app.get('/safe', async (req, res) => {
    if (!await validateKey(req, res)) return;
    if (fs.existsSync(FILE_SAFE)) res.send(fs.readFileSync(FILE_SAFE, 'utf8'));
    else res.send("print('Error: safe.lua missing')");
});

app.get('/chainsaw', async (req, res) => {
    if (!await validateKey(req, res)) return;
    if (fs.existsSync(FILE_CHAINSAW)) {
        try {
            let lua = fs.readFileSync(FILE_CHAINSAW, 'utf8');
            res.send(lua);
        } catch (e) { res.send("print('Error reading chainsaw.lua')"); }
    } else {
        res.send("print('Error: chainsaw.lua missing on server')");
    }
});

app.get('/solo', async (req, res) => {
    if (!await validateKey(req, res)) return;
    if (fs.existsSync(FILE_SOLO)) {
        try {
            let lua = fs.readFileSync(FILE_SOLO, 'utf8');
            res.send(lua);
        } catch (e) { res.send("print('Error reading Solo')"); }
    } else {
        res.send("print('Error: Solo missing on server')");
    }
});

// --- DASHBOARD (EMBEDDED HTML) ---
const DASHBOARD_HTML = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Key Manager</title><style>*{box-sizing:border-box}:root{--bg:#0a0e1a;--card:#151c2c;--text:#e2e8f0;--text2:#94a3b8;--accent:#3b82f6;--danger:#ef4444;--success:#10b981;--warning:#f59e0b;--purple:#8b5cf6}body{background:var(--bg);color:var(--text);font-family:system-ui,sans-serif;margin:0;min-height:100vh}.login-container{display:flex;height:100vh;justify-content:center;align-items:center;background:radial-gradient(circle at 50% 50%,#1a2235 0%,#0a0e1a 70%)}.login-box{background:var(--card);padding:50px;border-radius:20px;text-align:center;box-shadow:0 25px 50px rgba(0,0,0,0.5);border:1px solid #252d3d}.login-box h2{margin:0 0 30px;font-size:1.8rem;background:linear-gradient(135deg,var(--accent),var(--purple));-webkit-background-clip:text;-webkit-text-fill-color:transparent}.login-box input{width:280px;padding:15px 20px;border-radius:12px;border:2px solid #252d3d;background:var(--bg);color:#fff;font-size:1rem}.login-box input:focus{outline:none;border-color:var(--accent)}.login-box button{width:280px;margin-top:15px;padding:15px;border-radius:12px;border:none;background:linear-gradient(135deg,var(--accent),var(--purple));color:#fff;font-size:1rem;font-weight:600;cursor:pointer}.login-box button:hover{box-shadow:0 10px 30px rgba(59,130,246,0.4)}.dashboard{display:none;max-width:1300px;margin:0 auto;padding:30px}.header{display:flex;justify-content:space-between;align-items:center;margin-bottom:30px;flex-wrap:wrap;gap:15px}.header h1{margin:0;font-size:1.8rem}.header h1 span{background:linear-gradient(135deg,var(--accent),var(--purple));-webkit-background-clip:text;-webkit-text-fill-color:transparent}.header-actions{display:flex;gap:10px}.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:20px;margin-bottom:30px}.stat-card{background:var(--card);padding:25px;border-radius:16px;border:1px solid #252d3d}.stat-card .label{color:var(--text2);font-size:.8rem;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px}.stat-card .value{font-size:2rem;font-weight:700}.stat-card.total .value{color:var(--accent)}.stat-card.active .value{color:var(--success)}.stat-card.expired .value{color:var(--danger)}.stat-card.linked .value{color:var(--purple)}.controls{background:var(--card);padding:20px;border-radius:16px;margin-bottom:20px;border:1px solid #252d3d}.controls-row{display:flex;gap:12px;flex-wrap:wrap;align-items:center}.controls input,.controls select{padding:12px 16px;border-radius:10px;border:2px solid #252d3d;background:var(--bg);color:#fff;font-size:.95rem}.controls input:focus{outline:none;border-color:var(--accent)}#noteInput{flex:1;min-width:200px}#daysInput{width:90px}button{padding:12px 20px;border-radius:10px;border:none;font-size:.9rem;font-weight:600;cursor:pointer;display:inline-flex;align-items:center;gap:6px}.btn-primary{background:linear-gradient(135deg,var(--accent),#2563eb);color:#fff}.btn-primary:hover{box-shadow:0 5px 20px rgba(59,130,246,0.4)}.btn-secondary{background:var(--card);color:var(--text);border:1px solid #252d3d}.btn-secondary:hover{background:#252d3d}.btn-danger{background:var(--danger);color:#fff}.btn-success{background:var(--success);color:#fff}.btn-sm{padding:8px 12px;font-size:.8rem}.filter-bar{display:flex;gap:12px;margin-bottom:20px;flex-wrap:wrap;align-items:center}.search-box{flex:1;min-width:250px;position:relative}.search-box input{width:100%;padding:14px 20px 14px 45px;border-radius:12px;border:2px solid #252d3d;background:var(--card);color:#fff;font-size:.95rem}.search-box input:focus{border-color:var(--accent);outline:none}.search-box::before{content:"🔍";position:absolute;left:15px;top:50%;transform:translateY(-50%)}.filter-btn.active{background:var(--accent);color:#fff;border-color:var(--accent)}.table-container{background:var(--card);border-radius:16px;overflow:hidden;border:1px solid #252d3d}table{width:100%;border-collapse:collapse}th{background:var(--bg);color:var(--text2);font-weight:600;text-transform:uppercase;font-size:.7rem;letter-spacing:1px;padding:14px 16px;text-align:left}td{padding:14px 16px;border-bottom:1px solid #1a2235}tr:hover td{background:rgba(59,130,246,0.05)}tr:last-child td{border-bottom:none}.key-cell{font-family:monospace;color:var(--accent);cursor:pointer}.key-cell:hover{color:#fff}.badge{padding:5px 10px;border-radius:20px;font-size:.7rem;font-weight:600}.badge.active{background:rgba(16,185,129,0.15);color:#34d399}.badge.expired{background:rgba(239,68,68,0.15);color:#fca5a5}.hwid-linked{color:var(--purple);font-size:.85rem}.hwid-open{color:var(--success);font-size:.85rem}.actions-cell{display:flex;gap:6px;flex-wrap:wrap}.toast-container{position:fixed;top:20px;right:20px;z-index:9999;display:flex;flex-direction:column;gap:10px}.toast{padding:14px 20px;border-radius:12px;color:#fff;font-weight:500;animation:toastIn .3s ease;display:flex;align-items:center;gap:10px;box-shadow:0 10px 30px rgba(0,0,0,0.3)}@keyframes toastIn{from{opacity:0;transform:translateX(50px)}to{opacity:1;transform:translateX(0)}}.toast.success{background:var(--success)}.toast.error{background:var(--danger)}.toast.info{background:var(--accent)}.modal-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:1000;align-items:center;justify-content:center;backdrop-filter:blur(5px)}.modal-overlay.show{display:flex}.modal{background:var(--card);padding:30px;border-radius:20px;max-width:420px;width:90%;border:1px solid #252d3d}.modal h3{margin:0 0 12px}.modal p{color:var(--text2);margin:0 0 20px}.modal-actions{display:flex;gap:12px;justify-content:flex-end}.modal input{width:100%;padding:12px 16px;border-radius:10px;border:2px solid #252d3d;background:var(--bg);color:#fff;margin-bottom:15px}.modal input:focus{outline:none;border-color:var(--accent)}.empty-state{text-align:center;padding:60px 20px;color:var(--text2)}.empty-state .icon{font-size:3rem;margin-bottom:15px;opacity:.5}.bulk-bar{display:none;background:linear-gradient(135deg,var(--accent),var(--purple));padding:12px 20px;border-radius:12px;margin-bottom:15px;align-items:center;justify-content:space-between}.bulk-bar.show{display:flex}.bulk-actions{display:flex;gap:8px}@media(max-width:768px){.dashboard{padding:15px}.header{flex-direction:column;align-items:flex-start}.stats{grid-template-columns:repeat(2,1fr)}.controls-row{flex-direction:column}.controls input,.controls button{width:100%}th,td{padding:10px;font-size:.8rem}.actions-cell{flex-direction:column}}</style></head><body><div id="toastContainer" class="toast-container"></div><div id="modalOverlay" class="modal-overlay"><div class="modal"><h3 id="modalTitle">Confirm</h3><p id="modalMessage">Are you sure?</p><div id="modalInputContainer"></div><div class="modal-actions"><button class="btn-secondary" onclick="closeModal()">Cancel</button><button id="modalConfirm" class="btn-danger">Confirm</button></div></div></div><div id="loginScreen" class="login-container"><div class="login-box"><h2>🔐 Admin Access</h2><input type="password" id="passwordInput" placeholder="Enter password..." onkeypress="if(event.key==='Enter')login()"><button onclick="login()">Unlock Dashboard</button></div></div><div id="dashboard" class="dashboard"><div class="header"><h1>⚡ <span>Key Manager</span></h1><div class="header-actions"><button class="btn-secondary" onclick="fetchKeys()">🔄 Refresh</button><button class="btn-secondary" onclick="exportCSV()">📥 Export</button><button class="btn-secondary" onclick="deleteExpired()">🗑️ Purge Expired</button><button class="btn-secondary" onclick="logout()">🚪 Logout</button></div></div><div class="stats"><div class="stat-card total"><div class="label">Total Keys</div><div class="value" id="statTotal">0</div></div><div class="stat-card active"><div class="label">Active</div><div class="value" id="statActive">0</div></div><div class="stat-card expired"><div class="label">Expired</div><div class="value" id="statExpired">0</div></div><div class="stat-card linked"><div class="label">HWID Linked</div><div class="value" id="statLinked">0</div></div></div><div class="controls"><div class="controls-row"><input type="text" id="noteInput" placeholder="Note (e.g. Buyer name, Discord ID...)"><input type="number" id="daysInput" value="30" min="1"><select id="daysPreset" onchange="document.getElementById('daysInput').value=this.value"><option value="">⏱️ Presets</option><option value="1">1 Day</option><option value="7">1 Week</option><option value="30">1 Month</option><option value="90">3 Months</option><option value="365">1 Year</option><option value="3650">Lifetime</option></select><button class="btn-primary" onclick="createKey()">➕ Create Key</button></div></div><div class="filter-bar"><div class="search-box"><input type="text" id="searchInput" placeholder="Search keys, notes, HWID..." oninput="filterKeys()"></div><button class="btn-secondary filter-btn active" data-filter="all" onclick="setFilter('all')">All</button><button class="btn-secondary filter-btn" data-filter="active" onclick="setFilter('active')">Active</button><button class="btn-secondary filter-btn" data-filter="expired" onclick="setFilter('expired')">Expired</button><button class="btn-secondary filter-btn" data-filter="linked" onclick="setFilter('linked')">Linked</button></div><div class="bulk-bar" id="bulkBar"><span><strong id="selectedCount">0</strong> selected</span><div class="bulk-actions"><button class="btn-secondary btn-sm" onclick="bulkReset()">🔓 Reset All HWID</button><button class="btn-danger btn-sm" onclick="bulkDelete()">🗑️ Delete Selected</button><button class="btn-secondary btn-sm" onclick="clearSelection()">✖ Clear</button></div></div><div class="table-container"><table><thead><tr><th style="width:30px"><input type="checkbox" id="selectAll" onclick="toggleSelectAll()"></th><th>Key</th><th>Note</th><th>Status</th><th>HWID</th><th>Expires</th><th>Actions</th></tr></thead><tbody id="keyTableBody"></tbody></table></div></div><script>let authToken=localStorage.getItem('adminPass')||'';let allKeys=[];let filteredKeys=[];let selectedKeys=new Set();let currentFilter='all';function toast(msg,type='info'){const c=document.getElementById('toastContainer');const t=document.createElement('div');t.className='toast '+type;t.innerHTML=(type==='success'?'✅':type==='error'?'❌':'ℹ️')+' '+msg;c.appendChild(t);setTimeout(()=>{t.style.opacity='0';setTimeout(()=>t.remove(),300)},3000)}let modalResolve=null;function showModal(title,message,btnText='Confirm',btnClass='btn-danger',inputPlaceholder=null){return new Promise(resolve=>{document.getElementById('modalTitle').textContent=title;document.getElementById('modalMessage').textContent=message;document.getElementById('modalConfirm').textContent=btnText;document.getElementById('modalConfirm').className=btnClass;document.getElementById('modalInputContainer').innerHTML=inputPlaceholder?'<input id="modalInput" placeholder="'+inputPlaceholder+'">':'';document.getElementById('modalOverlay').classList.add('show');modalResolve=resolve;document.getElementById('modalConfirm').onclick=()=>{const val=inputPlaceholder?document.getElementById('modalInput').value:true;closeModal();resolve(val)}})}function closeModal(){document.getElementById('modalOverlay').classList.remove('show');if(modalResolve)modalResolve(false)}function login(){authToken=document.getElementById('passwordInput').value;fetchKeys()}function logout(){localStorage.removeItem('adminPass');location.reload()}async function api(endpoint,method='GET',body=null){const headers={'Content-Type':'application/json','Authorization':authToken};const opts={method,headers};if(body)opts.body=JSON.stringify(body);try{const res=await fetch('/api'+endpoint,opts);if(res.status===403){document.getElementById('loginScreen').style.display='flex';document.getElementById('dashboard').style.display='none';toast('Invalid password','error');return null}const data=await res.json();if(data.error){toast(data.error,'error');return null}return data}catch(e){toast('Connection failed','error');return null}}async function fetchKeys(){const data=await api('/keys');if(data){localStorage.setItem('adminPass',authToken);document.getElementById('loginScreen').style.display='none';document.getElementById('dashboard').style.display='block';allKeys=data;updateStats();filterKeys();toast('Keys loaded','success')}}function updateStats(){const now=Date.now();document.getElementById('statTotal').textContent=allKeys.length;document.getElementById('statActive').textContent=allKeys.filter(k=>now<=k.expires).length;document.getElementById('statExpired').textContent=allKeys.filter(k=>now>k.expires).length;document.getElementById('statLinked').textContent=allKeys.filter(k=>k.hwid).length}function filterKeys(){const search=document.getElementById('searchInput').value.toLowerCase();const now=Date.now();filteredKeys=allKeys.filter(k=>{const matchSearch=!search||k.key.toLowerCase().includes(search)||(k.note&&k.note.toLowerCase().includes(search))||(k.hwid&&k.hwid.toLowerCase().includes(search));if(!matchSearch)return false;switch(currentFilter){case'active':return now<=k.expires;case'expired':return now>k.expires;case'linked':return!!k.hwid;default:return true}});renderTable()}function setFilter(f){currentFilter=f;document.querySelectorAll('.filter-btn').forEach(b=>b.classList.toggle('active',b.dataset.filter===f));filterKeys()}function renderTable(){const tbody=document.getElementById('keyTableBody');if(filteredKeys.length===0){tbody.innerHTML='<tr><td colspan="7"><div class="empty-state"><div class="icon">🔑</div><h3>No keys found</h3></div></td></tr>';return}const now=Date.now();tbody.innerHTML=filteredKeys.map(k=>{const isExp=now>k.expires;const days=Math.ceil((k.expires-now)/86400000);const daysText=isExp?'Expired':''+days+'d left';const checked=selectedKeys.has(k.key)?'checked':'';return'<tr><td><input type="checkbox" '+checked+' onchange="toggleSelect(\\''+k.key+'\\')"></td><td class="key-cell" onclick="copyKey(\\''+k.key+'\\')">'+k.key+' 📋</td><td>'+escHtml(k.note||'-')+'</td><td><span class="badge '+(isExp?'expired':'active')+'">'+(isExp?'EXPIRED':'ACTIVE')+'</span></td><td class="'+(k.hwid?'hwid-linked':'hwid-open')+'">'+(k.hwid?'🔒 Linked':'🔓 Open')+'</td><td style="color:'+(isExp?'var(--danger)':days<=3?'var(--warning)':'var(--text2)')+'">'+daysText+'</td><td class="actions-cell"><button class="btn-sm btn-secondary" onclick="copyKey(\\''+k.key+'\\')">Copy</button><button class="btn-sm btn-secondary" onclick="editNote(\\''+k.key+'\\',\\''+escHtml(k.note||'')+'\\')">✏️</button><button class="btn-sm btn-secondary" onclick="extendKey(\\''+k.key+'\\')">⏱️</button><button class="btn-sm btn-secondary" onclick="resetHWID(\\''+k.key+'\\')">🔓</button><button class="btn-sm btn-danger" onclick="deleteKey(\\''+k.key+'\\')">🗑️</button></td></tr>'}).join('')}function escHtml(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')}function copyKey(key){navigator.clipboard.writeText(key);toast('Copied: '+key,'success')}async function createKey(){const note=document.getElementById('noteInput').value;const days=document.getElementById('daysInput').value;const res=await api('/create','POST',{days,note});if(res&&res.success){document.getElementById('noteInput').value='';toast('Key created: '+res.key.key,'success');fetchKeys()}}async function resetHWID(key){const ok=await showModal('Reset HWID','Reset HWID for '+key+'?','Reset','btn-secondary');if(ok){await api('/reset','POST',{key});toast('HWID reset','success');fetchKeys()}}async function deleteKey(key){const ok=await showModal('Delete Key','Permanently delete '+key+'?','Delete','btn-danger');if(ok){await api('/delete','POST',{key});toast('Key deleted','success');fetchKeys()}}async function editNote(key,currentNote){const newNote=await showModal('Edit Note','Enter new note for '+key+':','Save','btn-primary',currentNote||'Note...');if(newNote!==false){await api('/update','POST',{key,note:newNote});toast('Note updated','success');fetchKeys()}}async function extendKey(key){const days=await showModal('Extend Key','Add days to '+key+':','Extend','btn-success','Days to add...');if(days&&!isNaN(days)){await api('/extend','POST',{key,days:parseInt(days)});toast('Extended by '+days+' days','success');fetchKeys()}}async function deleteExpired(){const ok=await showModal('Purge Expired','Delete ALL expired keys?','Purge','btn-danger');if(ok){const expired=allKeys.filter(k=>Date.now()>k.expires);for(const k of expired){await api('/delete','POST',{key:k.key})}toast(expired.length+' expired keys deleted','success');fetchKeys()}}function toggleSelect(key){if(selectedKeys.has(key))selectedKeys.delete(key);else selectedKeys.add(key);updateBulkBar()}function toggleSelectAll(){const all=document.getElementById('selectAll').checked;selectedKeys.clear();if(all)filteredKeys.forEach(k=>selectedKeys.add(k.key));renderTable();updateBulkBar()}function clearSelection(){selectedKeys.clear();document.getElementById('selectAll').checked=false;renderTable();updateBulkBar()}function updateBulkBar(){document.getElementById('selectedCount').textContent=selectedKeys.size;document.getElementById('bulkBar').classList.toggle('show',selectedKeys.size>0)}async function bulkReset(){const ok=await showModal('Bulk Reset','Reset HWID for '+selectedKeys.size+' keys?','Reset All','btn-secondary');if(ok){for(const key of selectedKeys){await api('/reset','POST',{key})}toast(selectedKeys.size+' HWIDs reset','success');clearSelection();fetchKeys()}}async function bulkDelete(){const ok=await showModal('Bulk Delete','Delete '+selectedKeys.size+' keys?','Delete All','btn-danger');if(ok){for(const key of selectedKeys){await api('/delete','POST',{key})}toast(selectedKeys.size+' keys deleted','success');clearSelection();fetchKeys()}}function exportCSV(){let csv='Key,Note,Status,HWID,Expires\\n';const now=Date.now();allKeys.forEach(k=>{csv+=k.key+','+(k.note||'')+','+(now>k.expires?'Expired':'Active')+','+(k.hwid||'Open')+','+new Date(k.expires).toISOString()+'\\n'});const blob=new Blob([csv],{type:'text/csv'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='keys_'+Date.now()+'.csv';a.click();toast('CSV exported','success')}if(authToken)fetchKeys();</script></body></html>`;

app.get('/admin', (req, res) => res.send(DASHBOARD_HTML));

// --- LINKVERTISE KEY GENERATION ---

// Page shown after completing Linkvertise
const GETKEY_HTML = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Get Your Key</title>
    <style>
        :root { --bg: #0f172a; --card: #1e293b; --text: #e2e8f0; --accent: #3b82f6; --success: #10b981; }
        body { background: var(--bg); color: var(--text); font-family: sans-serif; margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
        .container { background: var(--card); padding: 40px; border-radius: 16px; text-align: center; max-width: 500px; }
        h1 { color: var(--success); margin-bottom: 20px; }
        .key-box { background: #0f172a; padding: 20px; border-radius: 8px; margin: 20px 0; font-family: monospace; font-size: 1.5rem; color: var(--accent); cursor: pointer; border: 2px dashed var(--accent); }
        .key-box:hover { background: #1a2744; }
        .info { color: #94a3b8; font-size: 0.9rem; margin-top: 15px; }
        .copy-btn { background: var(--accent); color: white; border: none; padding: 12px 30px; border-radius: 8px; font-size: 1rem; cursor: pointer; margin-top: 15px; }
        .copy-btn:hover { background: #2563eb; }
        .expires { color: #f59e0b; margin-top: 10px; }
    </style>
</head>
<body>
    <div class="container">
        <h1>✅ Key Generated!</h1>
        <p>Your temporary access key:</p>
        <div class="key-box" onclick="copyKey()" id="keyDisplay">GENERATING...</div>
        <button class="copy-btn" onclick="copyKey()">📋 Copy Key</button>
        <p class="expires" id="expiresInfo"></p>
        <p class="info">This key is linked to your device (HWID).<br>Use it in your script's getgenv().Key</p>
    </div>
    <script>
        const urlParams = new URLSearchParams(window.location.search);
        const key = urlParams.get('key');
        const hours = urlParams.get('hours') || 24;
        
        if (key) {
            document.getElementById('keyDisplay').textContent = key;
            document.getElementById('expiresInfo').textContent = '⏰ Expires in ' + hours + ' hours';
        } else {
            document.getElementById('keyDisplay').textContent = 'ERROR: No key generated';
        }
        
        function copyKey() {
            navigator.clipboard.writeText(document.getElementById('keyDisplay').textContent);
            document.querySelector('.copy-btn').textContent = '✓ Copied!';
            setTimeout(() => document.querySelector('.copy-btn').textContent = '📋 Copy Key', 2000);
        }
    </script>
</body>
</html>
`;

// Generate key endpoint - called after Linkvertise completion
app.get('/getkey', async (req, res) => {
    try {
        // Generate a temporary key
        const newKey = await Key.create({
            key: "KEY_" + Math.random().toString(36).substr(2, 8).toUpperCase(),
            note: "Linkvertise - " + new Date().toISOString().split('T')[0],
            expires: Date.now() + (LINKVERTISE_KEY_HOURS * 60 * 60 * 1000)
        });

        // Redirect to key display page
        res.redirect('/showkey?key=' + newKey.key + '&hours=' + LINKVERTISE_KEY_HOURS);
    } catch (e) {
        console.error("Key generation error:", e);
        res.status(500).send("Error generating key. Please try again.");
    }
});

// Show key page
app.get('/showkey', (req, res) => {
    res.send(GETKEY_HTML);
});

// --- SERVER START ---
app.listen(port, () => {
    console.log("Server Online!");
    console.log("Listening on port: " + port);
});