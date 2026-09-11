import { useState } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
export const Route = createFileRoute('/')({ component: Home })
function Home() {
  const [players, setPlayers] = useState<3 | 4>(4)
  return (
    <main className="island-home">
      <nav className="home-nav" aria-label="Main navigation">
        <a href="/" className="island-wordmark"><img src="/assets/astra/ui/crest.svg" alt="" />CATAN <small>THE ISLAND</small></a>
        <div><Link to="/rules">How to play</Link><Link to="/online" search={{}} className="btn btn-small">Gather your friends ↗</Link></div>
      </nav>
      <section className="island-hero">
        <img className="island-hero-art" src="/assets/astra/concept/island.png" alt="A handcrafted hexagonal island with forests, golden fields and little settlements in a turquoise sea" fetchPriority="high" />
        <div className="island-hero-shade" />
        <div className="island-hero-copy">
          <p className="eyebrow">A little island. Endless possibilities.</p>
          <h1>Make yourself<br /><em>at home.</em></h1>
          <p>Lay the first road. Find a good neighbor.<br />Turn a handful of resources into a world of your own.</p>
          <div className="home-play-card">
            <div className="home-play-heading"><span>YOUR TABLE</span><span>3–4 PLAYERS · 10 POINTS TO WIN</span></div>
            <div className="count-picker" role="radiogroup" aria-label="Number of local players">
              <span>Local players</span>
              {[3, 4].map(n => <button key={n} role="radio" aria-checked={players === n} className={`count-chip ${players === n ? 'count-chip-active' : ''}`} onClick={() => setPlayers(n as 3 | 4)}>{n}</button>)}
            </div>
            <Link to="/game" search={{ players }} className="btn btn-primary home-start">Set sail · Play locally <span>→</span></Link>
            <Link to="/online" search={{}} className="home-online">Friends in different places? <strong>Play online ↗</strong></Link>
          </div>
          <p className="home-caption">One shared screen for local play. Private hands online.</p>
        </div>
        <span className="hero-edition">THE TABLETOP COLLECTION <span>01 / THE ISLAND</span></span>
      </section>
      <section className="home-how" aria-label="The adventure in three steps">
        <div className="home-how-intro"><p className="eyebrow">Simple beginnings</p><h2>Every great island<br />starts with a road.</h2><Link to="/rules">Learn the rules →</Link></div>
        {[['01', 'Gather', 'Roll the dice. Your forests, fields and hills produce the resources that bring your plans to life.', 'wood'], ['02', 'Trade', 'Make a deal with your neighbors, or take your goods to a harbor. A little cooperation goes a long way.', 'grain'], ['03', 'Build', 'Connect settlements, raise cities and claim the longest road. Reach ten points on your turn to win.', 'ore']].map(([n,title,body,icon]) => <article key={n}><span className="how-number">{n}</span><img src={`/assets/astra/ui/${icon}.svg`} alt="" /><h3>{title}</h3><p>{body}</p></article>)}
      </section>
      <footer className="home-footer"><span>Made for evenings around a table.</span><small>Unofficial, non-commercial fan project. Catan™ belongs to Catan Studio / Asmodee. Not affiliated.</small></footer>
    </main>
  )
}
