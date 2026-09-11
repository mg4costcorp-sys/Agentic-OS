import { ArrowUpRight, ChevronDown, Database, LockKeyhole } from "lucide-react";
const SOURCES = [
  {
    id: "mercury",
    name: "Mercury",
    image: "mercury.svg",
    label: "Your money",
    description: "Balances, transactions and cash flow.",
    feeds: ["Bank balance", "Monthly spending", "Runway"],
    url: "https://mercury.com",
  },
  {
    id: "stripe",
    name: "Stripe",
    image: "stripe.svg",
    label: "Your revenue",
    description: "Payments, subscriptions and invoices.",
    feeds: ["Income", "Subscriptions", "Money owed"],
    url: "https://stripe.com",
  },
  {
    id: "skool",
    name: "Skool",
    image: "skool.png",
    label: "Your community",
    description: "Members, growth and community activity.",
    feeds: ["Paid members", "Community growth", "Activity"],
    url: "https://www.skool.com",
  },
];
export function ConnectionsPanel() {
  return (
    <>
      <div className="biz-section-heading">
        <div>
          <h2>Everything, in one place.</h2>
          <p>A few good connections. A clearer picture.</p>
        </div>
        <span className="biz-connections-count">0 of 3 connected</span>
      </div>
      <div className="biz-source-grid">
        {SOURCES.map((source) => (
          <section className={`biz-card biz-source source-${source.id}`} key={source.id}>
            <div className="biz-source-top">
              <img
                src={`/business-sources/${source.image}`}
                alt={`${source.name} logo`}
                width={44}
                height={44}
              />
              <span className="biz-source-status">
                <i />
                Not connected
              </span>
            </div>
            <span className="biz-source-category">{source.label}</span>
            <h3>{source.name}</h3>
            <p>{source.description}</p>
            <div className="biz-source-feeds">
              {source.feeds.map((feed) => (
                <span key={feed}>{feed}</span>
              ))}
            </div>
            <details>
              <summary>
                Connection details
                <ChevronDown size={13} />
              </summary>
              <div className="biz-source-details">
                <p>
                  Setup is not enabled in this preview. These cards show the planned data sources
                  for this dashboard.
                </p>
                <a href={source.url} target="_blank" rel="noopener noreferrer">
                  Visit {source.name}
                  <ArrowUpRight size={12} />
                </a>
              </div>
            </details>
          </section>
        ))}
      </div>
      <div className="biz-source-current">
        <span className="biz-source-current-icon">
          <Database size={17} />
        </span>
        <div>
          <strong>Currently using sample data</strong>
          <p>Your video tracker is saved separately in this browser.</p>
        </div>
        <span className="biz-source-current-label">
          <LockKeyhole size={12} />
          No accounts linked
        </span>
      </div>
    </>
  );
}
