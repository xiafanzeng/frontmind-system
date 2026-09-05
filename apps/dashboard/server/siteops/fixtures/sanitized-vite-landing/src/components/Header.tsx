export function Header() {
  return (
    <header className="header" id="top">
      <a className="brand" href="#top" aria-label="Northstar Studio home">
        <img src="/brand-mark.svg" alt="" width="40" height="40" />
        <span>Northstar</span>
      </a>
      <nav aria-label="Primary navigation">
        <a href="#work">Workspace</a>
        <a href="#contact">Contact</a>
      </nav>
      <a className="header-action" href="#contact">
        Plan a project
      </a>
    </header>
  );
}
