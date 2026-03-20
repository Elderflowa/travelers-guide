import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react'

const SYNC_KEYS = [
  'tv_chars', 'tv_teams', 'tv_weapons_owned',
  'tv_daily', 'tv_weekly', 'tv_monthly',
  'tv_active_team', 'tv_ev_dismissed', 'tv_plants_ts', 'tv_crystal_ts',
]
const PASS_KEY  = 'tv_sync_pass'
const API       = '/api'

async function sha256(str) {
  const msg = str.trim()
  // crypto.subtle only works in secure contexts (HTTPS / localhost on some browsers)
  if (crypto?.subtle?.digest) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(msg))
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('')
  }
  // Pure-JS SHA-256 fallback for plain HTTP (local network access)
  const K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
             0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
             0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
             0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
             0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
             0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
             0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
             0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]
  let h = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]
  const bytes = new TextEncoder().encode(msg)
  const len = bytes.length
  const bitLen = len * 8
  // Padding
  const padLen = ((len + 9 + 63) & ~63)
  const padded = new Uint8Array(padLen)
  padded.set(bytes)
  padded[len] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(padLen - 4, bitLen & 0xffffffff, false)
  view.setUint32(padLen - 8, Math.floor(bitLen / 0x100000000), false)
  const rot = (x, n) => (x >>> n) | (x << (32 - n))
  for (let off = 0; off < padLen; off += 64) {
    const w = new Uint32Array(64)
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4, false)
    for (let i = 16; i < 64; i++) {
      const s0 = rot(w[i-15],7) ^ rot(w[i-15],18) ^ (w[i-15] >>> 3)
      const s1 = rot(w[i-2],17) ^ rot(w[i-2],19)  ^ (w[i-2] >>> 10)
      w[i] = (w[i-16] + s0 + w[i-7] + s1) >>> 0
    }
    let [a,b,c,d,e,f,g,hh] = h
    for (let i = 0; i < 64; i++) {
      const S1   = rot(e,6) ^ rot(e,11) ^ rot(e,25)
      const ch   = (e & f) ^ (~e & g)
      const tmp1 = (hh + S1 + ch + K[i] + w[i]) >>> 0
      const S0   = rot(a,2) ^ rot(a,13) ^ rot(a,22)
      const maj  = (a & b) ^ (a & c) ^ (b & c)
      const tmp2 = (S0 + maj) >>> 0
      hh=g; g=f; f=e; e=(d+tmp1)>>>0; d=c; c=b; b=a; a=(tmp1+tmp2)>>>0
    }
    h = h.map((v,i) => (v + [a,b,c,d,e,f,g,hh][i]) >>> 0)
  }
  return h.map(v => v.toString(16).padStart(8,'0')).join('')
}

function collectData() {
  const out = {}
  for (const k of SYNC_KEYS) {
    const v = localStorage.getItem(k)
    if (v !== null) out[k] = v
  }
  return out
}

function applyData(data) {
  if (!data) return
  for (const k of SYNC_KEYS) {
    if (k in data) localStorage.setItem(k, data[k])
  }
}

function clearData() {
  for (const k of SYNC_KEYS) localStorage.removeItem(k)
}

const SyncContext = createContext(null)

export function SyncProvider({ children }) {
  const [passHash,    setPassHash]    = useState(() => localStorage.getItem(PASS_KEY) || null)
  const [status,      setStatus]      = useState('idle')
  const [lastSync,    setLastSync]    = useState(null)
  const [showModal,   setShowModal]   = useState(false)
  // syncVersion bumps whenever localStorage data changes due to a sync event,
  // causing all tab components to remount and read fresh values
  const [syncVersion, setSyncVersion] = useState(0)
  const saveTimer = useRef(null)

  const bumpVersion = useCallback(() => setSyncVersion(v => v + 1), [])

  const headers = useCallback(() => ({
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${passHash}`,
  }), [passHash])

  // Load from backend → overwrite localStorage → bump version so UI re-reads
  const loadFromServer = useCallback(async (hash) => {
    const h = hash || passHash
    if (!h) return
    setStatus('syncing')
    try {
      const r = await fetch(`${API}/sync`, {
        headers: { Authorization: `Bearer ${h}` }
      })
      if (!r.ok) throw new Error(r.status)
      const { data, updatedAt } = await r.json()
      if (data) {
        applyData(data)
        setLastSync(updatedAt)
        bumpVersion()   // ← triggers remount of all tab components
      }
      setStatus('ok')
    } catch {
      setStatus('offline')
    }
  }, [passHash, bumpVersion])

  // Save localStorage → backend (debounced)
  const saveToServer = useCallback(async () => {
    if (!passHash) return
    setStatus('syncing')
    try {
      const r = await fetch(`${API}/sync`, {
        method: 'PUT',
        headers: headers(),
        body: JSON.stringify({ data: collectData() }),
      })
      if (!r.ok) throw new Error(r.status)
      const { updatedAt } = await r.json()
      setLastSync(updatedAt)
      setStatus('ok')
    } catch {
      setStatus('offline')
    }
  }, [passHash, headers])

  const scheduleSave = useCallback(() => {
    if (!passHash) return
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(saveToServer, 3000)
  }, [passHash, saveToServer])

  // Login: hash passphrase, store, load data from server
  const setPassphrase = useCallback(async (plaintext) => {
    if (!plaintext.trim()) return
    const hash = await sha256(plaintext)
    localStorage.setItem(PASS_KEY, hash)
    setPassHash(hash)
    setShowModal(false)
    await loadFromServer(hash)
  }, [loadFromServer])

  // Logout: clear passphrase + wipe all synced data from localStorage + bump version
  const clearPassphrase = useCallback(() => {
    localStorage.removeItem(PASS_KEY)
    setPassHash(null)
    setStatus('idle')
    setLastSync(null)
    clearData()       // ← wipe stale data so next user starts fresh
    bumpVersion()     // ← triggers remount so UI reflects empty state
  }, [bumpVersion])

  // On mount: if stored passphrase exists, load from server immediately
  useEffect(() => {
    if (passHash) loadFromServer(passHash)
  }, []) // eslint-disable-line

  // Auto-save every 60s
  useEffect(() => {
    if (!passHash) return
    const t = setInterval(saveToServer, 60000)
    return () => clearInterval(t)
  }, [passHash, saveToServer])

  // Save on page hide
  useEffect(() => {
    const handler = () => { if (passHash) saveToServer() }
    const onVisibility = () => { if (document.visibilityState === 'hidden') handler() }
    window.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('beforeunload', handler)
    return () => {
      window.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('beforeunload', handler)
    }
  }, [passHash, saveToServer])

  return (
    <SyncContext.Provider value={{ passHash, status, lastSync, syncVersion, scheduleSave, saveToServer, setPassphrase, clearPassphrase, showModal, setShowModal }}>
      {children}
      {showModal && <PassphraseModal onSubmit={setPassphrase} onClose={() => setShowModal(false)}/>}
    </SyncContext.Provider>
  )
}

export function useSync() {
  return useContext(SyncContext)
}

// ── Passphrase Modal ──────────────────────────────────────────────────────────
function PassphraseModal({ onSubmit, onClose }) {
  const [val, setVal]   = useState('')
  const [show, setShow] = useState(false)

  return (
    <div style={{
      position:'fixed', inset:0, background:'rgba(0,0,0,0.7)', zIndex:1000,
      display:'flex', alignItems:'center', justifyContent:'center'
    }}>
      <div style={{
        background:'var(--panel)', border:'1px solid var(--border)', borderRadius:12,
        padding:'28px 32px', width:340, display:'flex', flexDirection:'column', gap:16
      }}>
        <div style={{fontSize:'1.05rem', fontWeight:700, color:'var(--text)'}}>Sync passphrase</div>
        <div style={{fontSize:'.78rem', color:'var(--text3)', lineHeight:1.5}}>
          Enter the same passphrase on all your devices to sync your data.
          It never leaves your device unencrypted — only a hash is sent.
        </div>
        <div style={{position:'relative'}}>
          <input
            type={show ? 'text' : 'password'}
            className="input"
            placeholder="e.g. teyvat-traveler-2025"
            value={val}
            onChange={e=>setVal(e.target.value)}
            onKeyDown={e=>e.key==='Enter'&&val.trim()&&onSubmit(val)}
            autoFocus
            style={{width:'100%', paddingRight:36}}
          />
          <button onClick={()=>setShow(s=>!s)} style={{
            position:'absolute', right:8, top:'50%', transform:'translateY(-50%)',
            background:'none', border:'none', cursor:'pointer', color:'var(--text3)', fontSize:'.8rem'
          }}>{show ? '🙈' : '👁'}</button>
        </div>
        <div style={{display:'flex', gap:8, justifyContent:'flex-end'}}>
          <button className="btn" onClick={onClose}
            style={{background:'transparent', border:'1px solid var(--border)', color:'var(--text2)'}}>
            Cancel
          </button>
          <button className="btn" onClick={()=>val.trim()&&onSubmit(val)}
            style={{background:'rgba(var(--accent),0.9)', color:'#fff'}}
            disabled={!val.trim()}>
            Connect
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Sync Status Badge ─────────────────────────────────────────────────────────
export function SyncBadge() {
  const { passHash, status, lastSync, saveToServer, clearPassphrase, setShowModal } = useSync()
  const [menuOpen,      setMenuOpen]      = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [importError,   setImportError]   = useState(null)
  const [exportJson,    setExportJson]    = useState(null)

  const menuRef   = React.useRef(null)
  const importRef = React.useRef(null)

  const TV_KEYS = ['tv_chars','tv_teams','tv_weapons_owned','tv_daily','tv_weekly',
                   'tv_monthly','tv_active_team','tv_cal','tv_theme',
                   'tv_crystal_ts','tv_plants_ts','tv_ev_dismissed']



  const handleImport = (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target.result)
        let count = 0
        TV_KEYS.forEach(k => {
          if (data[k] !== undefined) {
            localStorage.setItem(k, JSON.stringify(data[k]))
            count++
          }
        })
        setImportError(null)
        setMenuOpen(false)
        window.location.reload()
      } catch {
        setImportError('Invalid file — could not parse JSON')
      }
    }
    reader.readAsText(file)
    e.target.value = ''
  }

  // Close menu on outside click
  React.useEffect(() => {
    if (!menuOpen) return
    const handler = (e) => { if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false) }
    document.addEventListener('click', handler)
    return () => document.removeEventListener('click', handler)
  }, [menuOpen])

  const fmtTime = (iso) => {
    if (!iso) return ''
    return new Date(iso).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' })
  }

  const handleDelete = async () => {
    try {
      await fetch('/api/sync', {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${passHash}`
        }
      })
    } catch(e) {}
    clearPassphrase()
    setConfirmDelete(false)
    setMenuOpen(false)
  }

  const syncIcon  = { idle:'☁', syncing:'↻', ok:'✓', error:'⚠', offline:'✗' }[status] || '☁'
  const syncColor = { idle:'var(--text3)', syncing:'rgba(var(--accent),1)', ok:'rgba(var(--ok),0.9)', error:'#e57', offline:'#e57' }[status] || 'var(--text3)'
  const syncLabel = status==='ok' && lastSync ? `Synced ${fmtTime(lastSync)}` : status==='syncing' ? 'Syncing…' : status==='offline' ? 'Offline' : 'Sync'

  // ── Logged out ──
  if (!passHash) {
    return (
      <button onClick={()=>setShowModal(true)} style={{
        display:'flex', alignItems:'center', gap:5, fontSize:'.7rem',
        color:'var(--text3)', background:'transparent', border:'1px solid var(--border)',
        borderRadius:6, padding:'3px 9px', cursor:'pointer', whiteSpace:'nowrap'
      }}>
        Login
      </button>
    )
  }

  // ── Logged in ──
  return (
    <>
      {/* Export modal */}
      {exportJson && (
        <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.75)',zIndex:1001,display:'flex',alignItems:'center',justifyContent:'center'}}
          onClick={()=>setExportJson(null)}>
          <div style={{background:'var(--panel)',border:'1px solid var(--border)',borderRadius:12,padding:'24px 28px',width:460,display:'flex',flexDirection:'column',gap:14}}
            onClick={e=>e.stopPropagation()}>
            <div style={{fontSize:'1rem',fontWeight:700,color:'var(--text)'}}>Export data</div>
            <div style={{fontSize:'.75rem',color:'var(--text3)',lineHeight:1.5}}>
              Copy the JSON below and save it as a <code>.json</code> file to back up your data.
            </div>
            <textarea readOnly value={exportJson}
              onClick={e=>e.target.select()}
              style={{width:'100%',height:180,fontSize:'.65rem',fontFamily:'monospace',
                background:'var(--card)',color:'var(--text2)',border:'1px solid var(--border)',
                borderRadius:8,padding:8,resize:'none',boxSizing:'border-box'}}/>
            <div style={{display:'flex',gap:8,justifyContent:'flex-end'}}>
              <button className="btn" onClick={()=>setExportJson(null)}
                style={{background:'transparent',border:'1px solid var(--border)',color:'var(--text2)'}}>
                Close
              </button>
              <button className="btn" onClick={()=>navigator.clipboard.writeText(exportJson).then(()=>{}).catch(()=>{})}
                style={{background:'rgba(var(--accent),0.9)',color:'#fff',border:'none'}}>
                Copy to clipboard
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirmation modal */}
      {confirmDelete && (
        <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.75)',zIndex:1001,display:'flex',alignItems:'center',justifyContent:'center'}}>
          <div style={{background:'var(--panel)',border:'1px solid var(--border)',borderRadius:12,padding:'24px 28px',width:320,display:'flex',flexDirection:'column',gap:14}}>
            <div style={{fontSize:'1rem',fontWeight:700,color:'var(--text)'}}>Delete account data?</div>
            <div style={{fontSize:'.78rem',color:'var(--text3)',lineHeight:1.6}}>
              This will permanently delete all your synced data from the server and log you out.
              Local data stays until you clear it manually.
            </div>
            <div style={{display:'flex',gap:8,justifyContent:'flex-end'}}>
              <button className="btn" onClick={()=>setConfirmDelete(false)}
                style={{background:'transparent',border:'1px solid var(--border)',color:'var(--text2)'}}>
                Cancel
              </button>
              <button className="btn" onClick={handleDelete}
                style={{background:'rgba(var(--danger),0.85)',color:'#fff',border:'1px solid rgba(var(--danger),0.4)'}}>
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Badge row */}
      <div ref={menuRef} style={{position:'relative',display:'flex',alignItems:'center',gap:6}}>
        {/* Logout button */}
        <button onClick={clearPassphrase} style={{
          fontSize:'.7rem', color:'var(--text3)', background:'transparent',
          border:'1px solid var(--border)', borderRadius:6,
          padding:'3px 9px', cursor:'pointer', whiteSpace:'nowrap'
        }}>
          Logout
        </button>

        {/* Gear icon button */}
        <button onClick={()=>setMenuOpen(o=>!o)} style={{
          display:'flex', alignItems:'center', justifyContent:'center',
          width:26, height:26, borderRadius:6, cursor:'pointer',
          background: menuOpen ? 'var(--hover)' : 'transparent',
          border:'1px solid var(--border)', color:'var(--text3)', flexShrink:0,
          transition:'background .13s'
        }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
          </svg>
        </button>

        {/* Dropdown menu */}
        {menuOpen && (
          <div style={{
            position:'absolute', top:'calc(100% + 6px)', right:0, zIndex:200,
            background:'var(--panel)', border:'1px solid var(--border)',
            borderRadius:8, minWidth:160, boxShadow:'0 4px 16px rgba(0,0,0,0.2)',
            overflow:'hidden', display:'flex', flexDirection:'column'
          }}>
            {/* Sync now */}
            <button onClick={()=>{saveToServer();setMenuOpen(false)}} style={{
              display:'flex', alignItems:'center', gap:10, padding:'10px 14px',
              background:'transparent', border:'none', cursor:'pointer',
              color:syncColor, fontSize:'.78rem', textAlign:'left',
              transition:'background .1s'
            }}
            onMouseEnter={e=>e.currentTarget.style.background='var(--hover)'}
            onMouseLeave={e=>e.currentTarget.style.background='transparent'}>
              <span style={{animation:status==='syncing'?'spin 1s linear infinite':'none',display:'inline-block'}}>{syncIcon}</span>
              {syncLabel}
            </button>

            <div style={{height:1,background:'var(--border)',margin:'0 10px'}}/>

            {/* Export data */}
            <button onClick={async ()=>{
              const data = {}
              TV_KEYS.forEach(k => { try { const v = localStorage.getItem(k); if(v!==null) data[k]=JSON.parse(v) } catch{} })
              try {
                const res = await fetch('/api/export', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${passHash}` },
                  body: JSON.stringify({ data })
                })
                if (res.ok) {
                  const blob = await res.blob()
                  const url = URL.createObjectURL(blob)
                  const a = document.createElement('a')
                  a.href = url
                  a.download = `travelers-guide-${new Date().toISOString().slice(0,10)}.json`
                  document.body.appendChild(a)
                  a.click()
                  document.body.removeChild(a)
                  URL.revokeObjectURL(url)
                  setMenuOpen(false)
                  return
                }
              } catch {}
              // Fallback: show modal
              setExportJson(JSON.stringify(data, null, 2))
              setMenuOpen(false)
            }} style={{
              display:'flex', alignItems:'center', gap:10, padding:'10px 14px',
              background:'transparent', border:'none', cursor:'pointer',
              color:'var(--text2)', fontSize:'.78rem', textAlign:'left',
              transition:'background .1s'
            }}
            onMouseEnter={e=>e.currentTarget.style.background='var(--hover)'}
            onMouseLeave={e=>e.currentTarget.style.background='transparent'}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
              </svg>
              Export data
            </button>

            {/* Import data */}
            <input ref={importRef} type="file" accept=".json" onChange={handleImport}
              style={{display:'none'}}/>
            <button onClick={()=>importRef.current?.click()} style={{
              display:'flex', alignItems:'center', gap:10, padding:'10px 14px',
              background:'transparent', border:'none', cursor:'pointer',
              color:'var(--text2)', fontSize:'.78rem', textAlign:'left',
              transition:'background .1s'
            }}
            onMouseEnter={e=>e.currentTarget.style.background='var(--hover)'}
            onMouseLeave={e=>e.currentTarget.style.background='transparent'}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
              </svg>
              Import data
            </button>
            {importError && <div style={{fontSize:'.7rem',color:'#e57',padding:'4px 14px 8px'}}>{importError}</div>}

            <div style={{height:1,background:'var(--border)',margin:'0 10px'}}/>

            {/* Delete user */}
            <button onClick={()=>{setMenuOpen(false);setConfirmDelete(true)}} style={{
              display:'flex', alignItems:'center', gap:10, padding:'10px 14px',
              background:'transparent', border:'none', cursor:'pointer',
              color:'rgba(var(--danger),0.85)', fontSize:'.78rem', textAlign:'left',
              transition:'background .1s'
            }}
            onMouseEnter={e=>e.currentTarget.style.background='var(--hover)'}
            onMouseLeave={e=>e.currentTarget.style.background='transparent'}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/>
              </svg>
              Delete user
            </button>
          </div>
        )}
      </div>
    </>
  )
}
