import { useEffect, useMemo, useRef, useState } from 'react'
import { makeT } from './i18n.js'

const fmt = (s) => {
  const m = Math.floor(s / 60)
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

// ACSM metabolic equations: speed in km/h -> kcal per second
const kcalPerSec = (kmh, kg, running) => {
  const m = (kmh * 1000) / 60
  const vo2 = (running ? 0.2 : 0.1) * m + 3.5 // ml/kg/min
  return (vo2 * kg) / 200 / 60
}
const paceStr = (kmh) => {
  if (!kmh) return '--'
  const secs = Math.round(3600 / kmh)
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`
}

const haversine = (a, b) => {
  const R = 6371000, r = Math.PI / 180
  const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}
const KEY = 'run-walk-history'
const pref = (k, fallback) => {
  try { return localStorage.getItem(k) || fallback } catch { return fallback }
}
const savePref = (k, v) => { try { localStorage.setItem(k, v) } catch {} }
const loadHistory = () => {
  try { return JSON.parse(localStorage.getItem(KEY)) || [] } catch { return [] }
}
const storeHistory = (h) => {
  try { localStorage.setItem(KEY, JSON.stringify(h)) } catch {}
}
const NO_GPS = { km: 0, kcal: 0, kmh: 0, acc: null, error: '' }

function speak(text, lang = 'en') {
  try {
    const u = new SpeechSynthesisUtterance(text)
    u.lang = lang === 'he' ? 'he-IL' : 'en-US'
    u.rate = 0.95
    window.speechSynthesis.speak(u)
  } catch {}
}

function beep(freq = 880, ms = 200) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)()
    const o = ctx.createOscillator()
    o.frequency.value = freq
    o.connect(ctx.destination)
    o.start()
    setTimeout(() => { o.stop(); ctx.close() }, ms)
  } catch {}
  navigator.vibrate?.(200)
}

// number field that lets you type freely and clamps to the range when you leave it
function NumInput({ value, onChange, min, max, step = 1 }) {
  const [text, setText] = useState(String(value))
  useEffect(() => { setText(String(value)) }, [value])
  const commit = () => {
    const n = Number(text)
    const v = Math.max(min, Math.min(max, Number.isFinite(n) && text !== '' ? n : value))
    onChange(v)
    setText(String(v))
  }
  return (
    <input
      type="number" inputMode="decimal" min={min} max={max} step={step} value={text}
      onChange={(e) => {
        setText(e.target.value)
        const n = Number(e.target.value)
        if (e.target.value !== '' && n >= min && n <= max) onChange(n)
      }}
      onBlur={commit}
    />
  )
}

const Stat = ({ label, value }) => (
  <div className="stat"><b dir="ltr">{value}</b><span>{label}</span></div>
)

export default function App() {
  const [walkMin, setWalkMin] = useState(2)
  const [runMin, setRunMin] = useState(1)
  const [rounds, setRounds] = useState(8)
  const [weight, setWeight] = useState(85)
  const [walkKmh, setWalkKmh] = useState(5)
  const [runKmh, setRunKmh] = useState(9)
  const [useGps, setUseGps] = useState(true)
  const [gps, setGps] = useState(NO_GPS)
  const lastPt = useRef(null)
  const [lang, setLang] = useState(() => pref('lang', (navigator.language || '').startsWith('he') ? 'he' : 'en'))
  const [theme, setTheme] = useState(() =>
    pref('theme', window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark'))
  const t = useMemo(() => makeT(lang), [lang])
  useEffect(() => {
    const d = document.documentElement
    d.lang = lang
    d.dir = lang === 'he' ? 'rtl' : 'ltr'
    d.dataset.theme = theme
    document.title = t('title')
    savePref('lang', lang)
    savePref('theme', theme)
  }, [lang, theme, t])
  const [newVersion, setNewVersion] = useState(null)
  useEffect(() => {
    fetch(`./version.json?t=${Date.now()}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => { if (j.version && j.version !== __APP_VERSION__) setNewVersion(j.version) })
      .catch(() => {})
  }, [])
  const [history, setHistory] = useState(loadHistory)
  const [voice, setVoice] = useState(true)
  const lastSpoken = useRef(0)
  const [stopped, setStopped] = useState(false)
  const savedRef = useRef(false)
  const [started, setStarted] = useState(false)
  const [paused, setPaused] = useState(false)
  const [step, setStep] = useState(0)
  const [left, setLeft] = useState(0)

  // plan: walk first, then run, repeated
  const plan = useMemo(() => {
    const p = []
    for (let i = 0; i < rounds; i++) {
      p.push({ type: 'walk', secs: walkMin * 60 })
      p.push({ type: 'run', secs: runMin * 60 })
    }
    return p
  }, [walkMin, runMin, rounds])

  const total = plan.reduce((a, s) => a + s.secs, 0)
  const done = !!started && step >= plan.length
  const ended = done || stopped
  const current = plan[step]
  const elapsed = plan.slice(0, step).reduce((a, s) => a + s.secs, 0) + (current ? current.secs - left : 0)

  // stats for the first `upto` seconds of each phase type
  const stats = (steps, partial) => {
    let km = 0, kcal = 0
    steps.forEach((st, i) => {
      const secs = i === steps.length - 1 && partial !== undefined ? partial : st.secs
      const run = st.type === 'run'
      const v = run ? runKmh : walkKmh
      km += (v * secs) / 3600
      kcal += kcalPerSec(v, weight, run) * secs
    })
    return { km, kcal }
  }
  const planStats = stats(plan)
  const avgKmh = total ? (planStats.km / total) * 3600 : 0
  const live = current ? stats(plan.slice(0, step + 1), current.secs - left) : planStats
  const shown = useGps ? gps : live
  const shownAvg = elapsed ? (shown.km / elapsed) * 3600 : 0

  const stepRef = useRef(step)
  stepRef.current = step
  const liveRef = useRef({})
  liveRef.current = { paused, weight, run: current?.type === 'run' }

  // GPS tracking: accumulate distance/calories from real positions
  useEffect(() => {
    if (!started || ended || !useGps) return
    if (!navigator.geolocation) { setGps((g) => ({ ...g, error: t('gpsNS') })); return }
    const id = navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude: lat, longitude: lon, accuracy } = pos.coords
        const t = pos.timestamp
        const { paused, weight, run } = liveRef.current
        if (paused) { lastPt.current = null; return }
        setGps((g) => ({ ...g, acc: Math.round(accuracy), error: '' }))
        if (accuracy > 30) return
        const p = lastPt.current
        if (!p) { lastPt.current = { lat, lon, t }; return }
        const d = haversine(p, { lat, lon })
        const dt = (t - p.t) / 1000
        if (d < 3 || dt <= 0) return // jitter: wait for real movement
        lastPt.current = { lat, lon, t }
        const v = d / dt // m/s
        if (v > 8) return // GPS jump, ignore
        setGps((g) => ({
          ...g,
          km: g.km + d / 1000,
          kcal: g.kcal + kcalPerSec(v * 3.6, weight, run) * dt,
          kmh: g.kmh ? g.kmh * 0.7 + v * 3.6 * 0.3 : v * 3.6,
        }))
      },
      (err) => setGps((g) => ({ ...g, error: err.message })),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 }
    )
    return () => navigator.geolocation.clearWatch(id)
  }, [started, ended, useGps])

  // keep the phone screen on during the workout
  useEffect(() => {
    if (!started || ended || !navigator.wakeLock) return
    let lock
    const get = () => navigator.wakeLock.request('screen').then((l) => (lock = l)).catch(() => {})
    get()
    const vis = () => document.visibilityState === 'visible' && get()
    document.addEventListener('visibilitychange', vis)
    return () => { document.removeEventListener('visibilitychange', vis); lock?.release() }
  }, [started, ended])

  useEffect(() => {
    if (!started || paused || ended) return
    const id = setInterval(() => {
      setLeft((l) => {
        if (l > 1) { if (l <= 4) beep(660, 100); return l - 1 }
        const next = stepRef.current + 1
        beep(next >= plan.length ? 440 : 1000, 400)
        setStep(next)
        return plan[next]?.secs ?? 0
      })
    }, 1000)
    return () => clearInterval(id)
  }, [started, paused, ended, plan])

  // every full minute: announce distance, calories and pace
  useEffect(() => {
    if (!voice || !started || paused || ended || elapsed < 60 || elapsed % 60 !== 0) return
    if (lastSpoken.current === elapsed) return
    lastSpoken.current = elapsed
    const mins = elapsed / 60
    const pace = useGps ? (gps.kmh ? 3600 / gps.kmh : 0) : shownAvg ? 3600 / shownAvg : 0
    const pm = Math.floor(pace / 60), ps = Math.round(pace % 60)
    speak(
      t('speech', { m: mins, mw: t(mins === 1 ? 'minute' : 'minutes'), km: shown.km.toFixed(2), kcal: Math.round(shown.kcal) }) +
        (pace ? t('speechPace', { pm, ps }) : ''),
      lang
    )
  }, [elapsed])

  // save the workout once, when it completes or is stopped
  useEffect(() => {
    if (!ended || savedRef.current || elapsed < 5) return
    savedRef.current = true
    const entry = {
      id: Date.now(),
      date: new Date().toISOString(),
      secs: elapsed,
      km: shown.km,
      kcal: shown.kcal,
      kmh: shownAvg,
      gps: useGps,
      completed: done,
      plan: `${walkMin}/${runMin} × ${rounds}`,
    }
    setHistory((h) => { const n = [entry, ...h]; storeHistory(n); return n })
  }, [ended])

  const removeEntry = (id) => setHistory((h) => { const n = h.filter((e) => e.id !== id); storeHistory(n); return n })
  const clearHistory = () => {
    if (window.confirm(t('confirmClear'))) { storeHistory([]); setHistory([]) }
  }

  const start = () => { setGps(NO_GPS); lastPt.current = null; setStep(0); setLeft(plan[0].secs); setPaused(false); setStopped(false); savedRef.current = false; lastSpoken.current = 0; if (voice) speak(' ', lang); setStarted(true) }
  const reset = () => { setStarted(false); setPaused(false); setStopped(false); setStep(0) }
  const skip = () => {
    const next = step + 1
    setStep(next)
    setLeft(plan[next]?.secs ?? 0)
  }


  if (!started) {
    return (
      <main className="card">
        {newVersion && (
          <button className="primary" onClick={() => { location.href = `${location.pathname}?v=${newVersion}` }}>
            {t('newVer', { v: newVersion })}
          </button>
        )}
        <div className="toolbar">
          <button onClick={() => setLang(lang === 'he' ? 'en' : 'he')}>{lang === 'he' ? 'EN' : 'עברית'}</button>
          <button aria-label={t('theme')} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
            {theme === 'dark' ? '☀️' : '🌙'}
          </button>
        </div>
        <h1>🏃 {t('title')} <small className="ver">v{__APP_VERSION__}</small></h1>
        <label>{t('walkMin')}
          <NumInput value={walkMin} onChange={setWalkMin} min={1} max={60} />
        </label>
        <label>{t('runMin')}
          <NumInput value={runMin} onChange={setRunMin} min={1} max={60} />
        </label>
        <label>{t('rounds')}
          <NumInput value={rounds} onChange={setRounds} min={1} max={50} />
        </label>
        <label>{t('weight')}
          <NumInput value={weight} onChange={setWeight} min={30} max={250} />
        </label>
        <label>{t('walkSpeed')}
          <NumInput value={walkKmh} onChange={setWalkKmh} min={1} max={10} step={0.5} />
        </label>
        <label>{t('runSpeed')}
          <NumInput value={runKmh} onChange={setRunKmh} min={4} max={25} step={0.5} />
        </label>
        <label>{t('voice')}
          <input type="checkbox" className="chk" checked={voice} onChange={(e) => setVoice(e.target.checked)} />
        </label>
        <label>{t('gps')}
          <input type="checkbox" className="chk" checked={useGps} onChange={(e) => setUseGps(e.target.checked)} />
        </label>
        <p className="summary">
          {t('summary', { w: walkMin, r: runMin, n: rounds })} <b dir="ltr">{fmt(total)}</b> {t('total')}
        </p>
        <div className="stats">
          <Stat label={t('distance')} value={`${planStats.km.toFixed(2)} km`} />
          <Stat label={t('calories')} value={`${Math.round(planStats.kcal)} kcal`} />
          <Stat label={t('avgPace')} value={`${paceStr(avgKmh)} /km`} />
        </div>
        <div className="timeline">
          {plan.map((s, i) => (
            <span key={i} className={s.type} style={{ flexGrow: s.secs }} />
          ))}
        </div>
        <button className="primary" onClick={start}>{t('start')}</button>
        {history.length > 0 && (
          <section className="history">
            <h2>{t('history')}</h2>
            {history.map((e) => (
              <div key={e.id} className="entry">
                <div>
                  <b>{new Date(e.date).toLocaleDateString(lang === 'he' ? 'he-IL' : undefined)} {new Date(e.date).toLocaleTimeString(lang === 'he' ? 'he-IL' : [], { hour: '2-digit', minute: '2-digit' })}</b>
                  <small>{e.completed ? t('completed') : t('stoppedTag')} · {e.plan}{e.gps ? ' · GPS' : ''}</small>
                  <small dir="ltr">{fmt(e.secs)} · {e.km.toFixed(2)} km · {Math.round(e.kcal)} kcal · {paceStr(e.kmh)} /km</small>
                </div>
                <button aria-label={t('del')} onClick={() => removeEntry(e.id)}>✕</button>
              </div>
            ))}
            <button onClick={clearHistory}>{t('clear')}</button>
          </section>
        )}
      </main>
    )
  }

  if (ended) {
    return (
      <main className="card done">
        <h1>{done ? t('complete') : t('saved')}</h1>
        <p><bdi>{fmt(elapsed)}</bdi>{done ? ` · ${t('roundsN', { n: rounds })}` : ` ${t('stoppedEarly')}`}{useGps ? ' · GPS' : ''}</p>
        <div className="stats">
          <Stat label={t('distance')} value={`${shown.km.toFixed(2)} km`} />
          <Stat label={t('calories')} value={`${Math.round(shown.kcal)} kcal`} />
          <Stat label={t('avgPace')} value={`${paceStr(shownAvg)} /km`} />
        </div>
        <button className="primary" onClick={reset}>{t('back')}</button>
      </main>
    )
  }

  return (
    <main className={`card ${current.type}`}>
      <div className="phase">{current.type === 'walk' ? t('walkPhase') : t('runPhase')}</div>
      <div className="time" dir="ltr">{fmt(left)}</div>
      <p>{t('roundOf', { a: Math.floor(step / 2) + 1, b: rounds })}</p>
      <div className="stats">
        <Stat label={t('distance')} value={`${shown.km.toFixed(2)} km`} />
        <Stat label={t('calories')} value={`${Math.round(shown.kcal)} kcal`} />
        <Stat label={t('paceNow')} value={`${paceStr(useGps ? gps.kmh : current.type === 'run' ? runKmh : walkKmh)} /km`} />
        <Stat label={t('avgPace')} value={`${paceStr(shownAvg)} /km`} />
      </div>
      {useGps && (
        <p className="small">
          {gps.error ? `GPS: ${gps.error}` : gps.acc === null ? t('gpsWait') : `${t('gpsAcc', { a: gps.acc })}${gps.acc > 30 ? t('weak') : ''}`}
        </p>
      )}
      <div className="bar"><i style={{ width: `${(elapsed / total) * 100}%` }} /></div>
      <p className="small" dir="ltr">{fmt(elapsed)} / {fmt(total)}</p>
      <div className="row">
        <button onClick={() => setPaused(!paused)}>{paused ? t('resume') : t('pause')}</button>
        <button onClick={skip}>{t('skip')}</button>
        <button onClick={() => setStopped(true)}>{t('stop')}</button>
      </div>
    </main>
  )
}
