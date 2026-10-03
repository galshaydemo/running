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
const NO_GPS = { km: 0, kcal: 0, kmh: 0, acc: null, error: '' }

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
  const [weight, setWeight] = useState(70)
  const [walkKmh, setWalkKmh] = useState(5)
  const [runKmh, setRunKmh] = useState(9)
  const [useGps, setUseGps] = useState(false)
  const [gps, setGps] = useState(NO_GPS)
  const lastPt = useRef(null)
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
  const final = useGps ? gps : planStats

  const stepRef = useRef(step)
  stepRef.current = step
  const liveRef = useRef({})
  liveRef.current = { paused, weight, run: current?.type === 'run' }

  // GPS tracking: accumulate distance/calories from real positions
  useEffect(() => {
    if (!started || done || !useGps) return
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
  }, [started, done, useGps])

  // keep the phone screen on during the workout
  useEffect(() => {
    if (!started || done || !navigator.wakeLock) return
    let lock
    const get = () => navigator.wakeLock.request('screen').then((l) => (lock = l)).catch(() => {})
    get()
    const vis = () => document.visibilityState === 'visible' && get()
    document.addEventListener('visibilitychange', vis)
    return () => { document.removeEventListener('visibilitychange', vis); lock?.release() }
  }, [started, done])

  useEffect(() => {
    if (!started || paused || done) return
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
  }, [started, paused, done, plan])

  const start = () => { setGps(NO_GPS); lastPt.current = null; setStep(0); setLeft(plan[0].secs); setPaused(false); setStarted(true) }
  const reset = () => { setStarted(false); setPaused(false); setStep(0) }
  const skip = () => {
    const next = step + 1
    setStep(next)
    setLeft(plan[next]?.secs ?? 0)
  }

  const num = (set, min, max) => (e) => set(Math.max(min, Math.min(max, Number(e.target.value) || min)))

  if (!started) {
    return (
      <main className="card">
        <h1>🏃 Run / Walk Planner</h1>
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
      </main>
    )
  }

  if (done) {
    return (
      <main className="card done">
        <h1>🎉 Workout complete!</h1>
        <p>{rounds} rounds · {fmt(total)}{useGps ? ' · GPS' : ''}</p>
        <div className="stats">
          <Stat label="Distance" value={`${final.km.toFixed(2)} km`} />
          <Stat label="Calories" value={`${Math.round(final.kcal)} kcal`} />
          <Stat label="Avg pace" value={`${paceStr(useGps ? shownAvg : avgKmh)} /km`} />
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
        <button onClick={reset}>Stop</button>
      </div>
    </main>
  )
}
