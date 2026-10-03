import { useEffect, useMemo, useRef, useState } from 'react'

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
const version=2;
const loadHistory = () => {
  try { return JSON.parse(localStorage.getItem(KEY)) || [] } catch { return [] }
}
const storeHistory = (h) => {
  try { localStorage.setItem(KEY, JSON.stringify(h)) } catch {}
}
const NO_GPS = { km: 0, kcal: 0, kmh: 0, acc: null, error: '' }

function speak(text) {
  try {
    const u = new SpeechSynthesisUtterance(text)
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

const Stat = ({ label, value }) => (
  <div className="stat"><b>{value}</b><span>{label}</span></div>
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
    if (!navigator.geolocation) { setGps((g) => ({ ...g, error: 'GPS not supported' })); return }
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
      `${mins} ${mins === 1 ? 'minute' : 'minutes'}. Distance ${shown.km.toFixed(2)} kilometers. ` +
      `${Math.round(shown.kcal)} calories burned. ` +
      (pace ? `Pace ${pm} minutes ${ps} seconds per kilometer.` : '')
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
      plan: `${walkMin}/${runMin} min × ${rounds}`,
    }
    setHistory((h) => { const n = [entry, ...h]; storeHistory(n); return n })
  }, [ended])

  const removeEntry = (id) => setHistory((h) => { const n = h.filter((e) => e.id !== id); storeHistory(n); return n })
  const clearHistory = () => {
    if (window.confirm('Delete all saved workouts?')) { storeHistory([]); setHistory([]) }
  }

  const start = () => { setGps(NO_GPS); lastPt.current = null; setStep(0); setLeft(plan[0].secs); setPaused(false); setStopped(false); savedRef.current = false; lastSpoken.current = 0; if (voice) speak(' '); setStarted(true) }
  const reset = () => { setStarted(false); setPaused(false); setStopped(false); setStep(0) }
  const skip = () => {
    const next = step + 1
    setStep(next)
    setLeft(plan[next]?.secs ?? 0)
  }

  const num = (set, min, max) => (e) => set(Math.max(min, Math.min(max, Number(e.target.value) || min)))

  if (!started) {
    return (
      <main className="card">
        <h1>🏃 Run / Walk Planner <small className="ver">v{__APP_VERSION__}</small></h1>
        <label>Walking (minutes)
          <input type="number" min="1" value={walkMin} onChange={num(setWalkMin, 1, 60)} />
        </label>
        <label>Running (minutes)
          <input type="number" min="1" value={runMin} onChange={num(setRunMin, 1, 60)} />
        </label>
        <label>Rounds
          <input type="number" min="1" value={rounds} onChange={num(setRounds, 1, 50)} />
        </label>
        <label>Weight (kg)
          <input type="number" min="30" value={weight} onChange={num(setWeight, 30, 250)} />
        </label>
        <label>Walking speed (km/h)
          <input type="number" min="1" step="0.5" value={walkKmh} onChange={num(setWalkKmh, 1, 10)} />
        </label>
        <label>Running speed (km/h)
          <input type="number" min="4" step="0.5" value={runKmh} onChange={num(setRunKmh, 4, 25)} />
        </label>
        <label>Voice update every minute
          <input type="checkbox" className="chk" checked={voice} onChange={(e) => setVoice(e.target.checked)} />
        </label>
        <label>Track with GPS
          <input type="checkbox" className="chk" checked={useGps} onChange={(e) => setUseGps(e.target.checked)} />
        </label>
        <p className="summary">
          {walkMin} min walk → {runMin} min run, × {rounds} = <b>{fmt(total)}</b> total
        </p>
        <div className="stats">
          <Stat label="Distance" value={`${planStats.km.toFixed(2)} km`} />
          <Stat label="Calories" value={`${Math.round(planStats.kcal)} kcal`} />
          <Stat label="Avg pace" value={`${paceStr(avgKmh)} /km`} />
        </div>
        <div className="timeline">
          {plan.map((s, i) => (
            <span key={i} className={s.type} style={{ flexGrow: s.secs }} />
          ))}
        </div>
        <button className="primary" onClick={start}>Start</button>
        {history.length > 0 && (
          <section className="history">
            <h2>History</h2>
            {history.map((e) => (
              <div key={e.id} className="entry">
                <div>
                  <b>{new Date(e.date).toLocaleDateString()} {new Date(e.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</b>
                  <small>{e.completed ? '✅ completed' : '⏹ stopped'} · {e.plan}{e.gps ? ' · GPS' : ''}</small>
                  <small>{fmt(e.secs)} · {e.km.toFixed(2)} km · {Math.round(e.kcal)} kcal · {paceStr(e.kmh)} /km</small>
                </div>
                <button aria-label="Delete" onClick={() => removeEntry(e.id)}>✕</button>
              </div>
            ))}
            <button onClick={clearHistory}>Clear history</button>
          </section>
        )}
      </main>
    )
  }

  if (ended) {
    return (
      <main className="card done">
        <h1>{done ? '🎉 Workout complete!' : '💾 Workout saved'}</h1>
        <p>{fmt(elapsed)}{done ? ` · ${rounds} rounds` : ' (stopped early)'}{useGps ? ' · GPS' : ''}</p>
        <div className="stats">
          <Stat label="Distance" value={`${shown.km.toFixed(2)} km`} />
          <Stat label="Calories" value={`${Math.round(shown.kcal)} kcal`} />
          <Stat label="Avg pace" value={`${paceStr(shownAvg)} /km`} />
        </div>
        <button className="primary" onClick={reset}>Back to plan</button>
      </main>
    )
  }

  return (
    <main className={`card ${current.type}`}>
      <div className="phase">{current.type === 'walk' ? '🚶 WALK' : '🏃 RUN'}</div>
      <div className="time">{fmt(left)}</div>
      <p>Round {Math.floor(step / 2) + 1} of {rounds}</p>
      <div className="stats">
        <Stat label="Distance" value={`${shown.km.toFixed(2)} km`} />
        <Stat label="Calories" value={`${Math.round(shown.kcal)} kcal`} />
        <Stat label="Pace now" value={`${paceStr(useGps ? gps.kmh : current.type === 'run' ? runKmh : walkKmh)} /km`} />
        <Stat label="Avg pace" value={`${paceStr(shownAvg)} /km`} />
      </div>
      {useGps && (
        <p className="small">
          {gps.error ? `GPS: ${gps.error}` : gps.acc === null ? 'GPS: waiting for signal…' : `GPS accuracy ±${gps.acc} m${gps.acc > 30 ? ' (weak, ignored)' : ''}`}
        </p>
      )}
      <div className="bar"><i style={{ width: `${(elapsed / total) * 100}%` }} /></div>
      <p className="small">{fmt(elapsed)} / {fmt(total)}</p>
      <div className="row">
        <button onClick={() => setPaused(!paused)}>{paused ? 'Resume' : 'Pause'}</button>
        <button onClick={skip}>Skip</button>
        <button onClick={() => setStopped(true)}>Stop &amp; save</button>
      </div>
    </main>
  )
}
