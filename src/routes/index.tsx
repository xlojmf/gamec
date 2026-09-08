import { createFileRoute, Link } from '@tanstack/react-router'
import { MILESTONES, ART_TRACK } from '#/data/milestones'

export const Route = createFileRoute('/')({ component: Home })

const statusLabel = { done: 'done', next: 'next up', todo: 'planned' } as const

function Home() {
  const done = MILESTONES.filter((m) => m.status === 'done').length

  return (
    <main className="landing">
      <section className="hero">
        <p className="hero-kicker">an unofficial fan project · three.js · tanstack start · boardgame.io</p>
        <h1>
          The island of <span className="accent">CATAN</span>
        </h1>
        <p className="hero-sub">
          A 3D browser adaptation of the classic settler’s game — roll, build, trade and race to
          ten victory points on a procedurally generated hex island.
        </p>
        <div className="hero-actions">
          <Link to="/game" className="btn btn-primary">
            ▶ Enter the island
          </Link>
          <Link to="/rules" className="btn">
            📖 Read the rules
          </Link>
          <a className="btn" href="/PRD.md" target="_blank" rel="noreferrer">
            📋 PRD
          </a>
        </div>
        <p className="hero-progress">
          build progress · {done}/{MILESTONES.length} milestones
        </p>
      </section>

      <section className="grid">
        <div>
          <h2>Roadmap</h2>
          <ul className="milestones">
            {MILESTONES.map((m) => (
              <li key={m.id} className={`ms ms-${m.status}`}>
                <span className="ms-id">{m.id}</span>
                <span className="ms-body">
                  <strong>{m.title}</strong>
                  <small>{m.detail}</small>
                </span>
                <span className="ms-status">{statusLabel[m.status]}</span>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h2>Art direction · GPT Astra</h2>
          <p className="muted">
            Look &amp; feel is driven by generated art that drops into asset slots through a
            manifest — the procedural placeholder island you see today is the fallback.
          </p>
          <ul className="milestones">
            {ART_TRACK.map((m) => (
              <li key={m.id} className={`ms ms-${m.status}`}>
                <span className="ms-id">{m.id}</span>
                <span className="ms-body">
                  <strong>{m.title}</strong>
                  <small>{m.detail}</small>
                </span>
                <span className="ms-status">{statusLabel[m.status]}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <footer className="landing-footer">
        Fan re-implementation for personal &amp; educational use. Catan™ is a trademark of Catan
        Studio / Asmodee — this project is not affiliated.
      </footer>
    </main>
  )
}
