import { createFileRoute, Link } from '@tanstack/react-router'
import { RULES } from '#/data/rules'

export const Route = createFileRoute('/rules')({ component: RulesPage })

function RulesPage() {
  return (
    <main className="rules">
      <header className="rules-head">
        <Link to="/" className="muted">
          ⟵ back
        </Link>
        <h1>Rules of the Island</h1>
        <p className="muted">
          Base game, 3–4 players · the implementation contract for milestones M6–M11 · full PRD
          in <code>PRD.md</code>
        </p>
      </header>

      {RULES.map((section) => (
        <section key={section.id} id={section.id} className="rule-section">
          <h2>{section.title}</h2>
          {section.paragraphs?.map((p, i) => (
            <p key={i}>{p}</p>
          ))}
          {section.bullets && (
            <ul>
              {section.bullets.map((b, i) => (
                <li key={i}>{b}</li>
              ))}
            </ul>
          )}
          {section.table && (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    {section.table.headers.map((h) => (
                      <th key={h}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {section.table.rows.map((row, i) => (
                    <tr key={i}>
                      {row.map((cell, j) => (
                        <td key={j}>{cell}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ))}
    </main>
  )
}
