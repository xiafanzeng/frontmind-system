import productPreview from "../assets/product-preview.svg";
import "./Hero.css";

export function Hero() {
  return (
    <section className="hero" aria-labelledby="hero-title">
      <div className="hero-copy">
        <span className="eyebrow">A focused studio workspace</span>
        <h1 id="hero-title">
          Move from brief to launch without losing the thread.
        </h1>
        <p>
          Northstar keeps decisions, deliverables, and the next useful action in
          one shared view for small creative teams.
        </p>
        <div className="hero-actions">
          <a className="primary-action" href="#contact">
            Build a project view
          </a>
          <a className="secondary-action" href="#work">
            Explore the workflow
          </a>
        </div>
        <ul aria-label="Product assurances">
          <li>No setup call</li>
          <li>Local-first fixture assets</li>
        </ul>
      </div>
      <div className="hero-visual" aria-label="Example project workspace">
        <div className="visual-note">Today · 3 priorities</div>
        <img src={productPreview} alt="A sample project planning interface" />
      </div>
    </section>
  );
}
