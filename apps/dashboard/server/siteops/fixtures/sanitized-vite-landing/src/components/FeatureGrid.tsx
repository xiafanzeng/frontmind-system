import "./FeatureGrid.css";

const features = [
  {
    number: "01",
    title: "See the whole brief",
    copy: "Keep the goal, audience, references, and open questions beside the work they shape.",
  },
  {
    number: "02",
    title: "Make decisions visible",
    copy: "Capture approvals and tradeoffs as they happen, so the team never rebuilds old context.",
  },
  {
    number: "03",
    title: "Hand off with confidence",
    copy: "Package the final direction, assets, and owners in a clean launch-ready project view.",
  },
];

export function FeatureGrid() {
  return (
    <section className="features" id="work" aria-labelledby="features-title">
      <div className="features-heading">
        <span className="eyebrow">A simple working rhythm</span>
        <h2 id="features-title">Clarity at every handoff.</h2>
      </div>
      <div className="feature-grid">
        {features.map((feature) => (
          <article key={feature.number}>
            <span>{feature.number}</span>
            <h3>{feature.title}</h3>
            <p>{feature.copy}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
