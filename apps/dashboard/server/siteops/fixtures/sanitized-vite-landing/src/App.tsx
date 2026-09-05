import "./App.css";
import "./components/layout.css";
import { FeatureGrid } from "./components/FeatureGrid";
import { Footer } from "./components/Footer";
import { Header } from "./components/Header";
import { Hero } from "./components/Hero";

export default function App() {
  return (
    <div className="site-shell" data-template="sanitized-studio-landing">
      <Header />
      <main>
        <Hero />
        <FeatureGrid />
        <section className="proof-band" aria-label="Studio outcomes">
          <p>One calm workspace</p>
          <strong>12 hrs</strong>
          <span>saved by each project team every week</span>
        </section>
        <section className="closing" id="contact">
          <span className="eyebrow">A clearer next step</span>
          <h2>Turn a scattered brief into work everyone can see.</h2>
          <a className="primary-action" href="#top">
            Start a sample project
          </a>
        </section>
      </main>
      <Footer />
    </div>
  );
}
