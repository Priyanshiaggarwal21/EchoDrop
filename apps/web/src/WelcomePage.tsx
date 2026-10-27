import React, { useEffect, useRef, useState } from 'react';
import './welcome.css';

const steps = [
  ['Organize with clarity', 'Bring your projects, files and context into one focused workspace.'],
  ['Collaborate effortlessly', 'Keep your people connected and your work moving together.'],
  ['Move files, your way', 'Share and receive files across devices and networks.'],
  ['Test and build with confidence', 'Connect your development workflow, from first idea to final build.'],
  ['Keep your progress safe', 'Keep the history and context you need to pick up where you left off.'],
];
const capabilities = [
  ['Organize', 'Keep all your projects, files and context in one place.', 'M3 7h7l2 2h9v11H3z M3 7V4h7l2 3'],
  ['Collaborate', 'Work together with clarity and control.', 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M16 4a4 4 0 0 1 0 8 M22 21v-2a4 4 0 0 0-3-3.87 M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0'],
  ['Transfer', 'Share and receive files across devices and networks.', 'M3 7h18m-5-5 5 5-5 5 M21 17H3m5-5-5 5 5 5'],
  ['Develop', 'Set up, integrate and move faster.', 'm7 6-6 6 6 6 M17 6l6 6-6 6 M14 3l-4 18'],
  ['Test', 'Find issues early with an integrated testing lab.', 'M9 3h6 M10 3v7l-6 9a1 1 0 0 0 1 2h14a1 1 0 0 0 1-2l-6-9V3 M7 16h10'],
  ['Stay on Track', 'Preserve progress with project history and continuity tools.', 'M3 11a9 9 0 1 1 2.5 7 M3 4v7h7 M12 7v5l3 2'],
];

function WelcomeBackdrop() {
  return <div className="welcome-backdrop" aria-hidden="true">
    {/* Pearl white base mesh */}
    <div className="welcome-light-mesh" />

    {/* Midnight navy base mesh */}
    <div className="welcome-dark-mesh" />

    {/* ── Pearl Aurora light wave geometry ──────────────────────────────
        Three layered wave bands flowing bottom-left → top-right:
        (1) Wide soft azure/ice fill  (2) Royal blue/cyan tinted  (3) Soft violet accent
        Plus crisp 1-2px edge lines matching the reference exactly.
    ─────────────────────────────────────────────────────────────────── */}
    <svg className="welcome-light-flow" viewBox="0 0 1440 900" preserveAspectRatio="xMidYMid slice">
      <defs>
        <linearGradient id="pa-azure" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0"   stopColor="#EAF1FF" stopOpacity="0"/>
          <stop offset=".22" stopColor="#D6E6FF" stopOpacity=".8"/>
          <stop offset=".5"  stopColor="#EAF1FF" stopOpacity=".92"/>
          <stop offset=".75" stopColor="#D6E6FF" stopOpacity=".6"/>
          <stop offset="1"   stopColor="#FFFFFF"  stopOpacity="0"/>
        </linearGradient>
        <linearGradient id="pa-royal" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0"   stopColor="#2456A6" stopOpacity="0"/>
          <stop offset=".35" stopColor="#2456A6" stopOpacity=".2"/>
          <stop offset=".6"  stopColor="#16B3C6" stopOpacity=".32"/>
          <stop offset=".8"  stopColor="#2456A6" stopOpacity=".14"/>
          <stop offset="1"   stopColor="#EAF1FF"  stopOpacity="0"/>
        </linearGradient>
        <linearGradient id="pa-violet" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0"   stopColor="#8B6CE6" stopOpacity="0"/>
          <stop offset=".42" stopColor="#8B6CE6" stopOpacity=".24"/>
          <stop offset=".7"  stopColor="#16B3C6" stopOpacity=".2"/>
          <stop offset="1"   stopColor="#D6E6FF"  stopOpacity="0"/>
        </linearGradient>
        <linearGradient id="pa-edge-c" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0"   stopColor="#16B3C6" stopOpacity="0"/>
          <stop offset=".48" stopColor="#16B3C6" stopOpacity=".6"/>
          <stop offset="1"   stopColor="#EAF1FF"  stopOpacity="0"/>
        </linearGradient>
        <linearGradient id="pa-edge-r" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0"   stopColor="#2456A6" stopOpacity="0"/>
          <stop offset=".52" stopColor="#2456A6" stopOpacity=".38"/>
          <stop offset="1"   stopColor="#8B6CE6"  stopOpacity="0"/>
        </linearGradient>
        <filter id="pa-glow"><feGaussianBlur stdDeviation="30"/></filter>
        <filter id="pa-soft"><feGaussianBlur stdDeviation="18"/></filter>
      </defs>
      {/* Band 1 – wide azure glow */}
      <path d="M-120 820 C160 900 280 570 510 630 S820 848 1050 588 S1255 205 1565 -38"
        fill="none" stroke="url(#pa-azure)" strokeWidth="185" filter="url(#pa-glow)" opacity=".95"/>
      {/* Band 2 – mid azure */}
      <path d="M-55 868 C215 945 330 618 560 678 S875 888 1098 628 S1295 248 1605 8"
        fill="none" stroke="url(#pa-azure)" strokeWidth="88" filter="url(#pa-soft)" opacity=".72"/>
      {/* Band 3 – royal blue / cyan */}
      <path d="M-80 800 C160 874 300 534 558 594 S876 824 1098 564 S1282 162 1568 -55"
        fill="none" stroke="url(#pa-royal)" strokeWidth="115" filter="url(#pa-soft)" opacity=".82"/>
      {/* Band 4 – violet accent */}
      <path d="M195 898 C472 800 618 502 858 522 S1138 762 1358 482 S1478 182 1602 82"
        fill="none" stroke="url(#pa-violet)" strokeWidth="95" filter="url(#pa-soft)" opacity=".68"/>
      {/* Crisp cyan edge */}
      <path d="M-80 812 C160 882 300 542 558 602 S876 832 1098 572 S1282 172 1568 -48"
        fill="none" stroke="url(#pa-edge-c)" strokeWidth="1.5" opacity=".88"/>
      {/* Crisp royal edge */}
      <path d="M-40 842 C198 912 338 572 598 632 S918 852 1140 592 S1322 192 1605 -28"
        fill="none" stroke="url(#pa-edge-r)" strokeWidth="1" opacity=".72"/>
      {/* Dashed secondary */}
      <path d="M2 862 C242 932 382 602 642 662 S962 872 1182 612 S1362 212 1645 -18"
        fill="none" stroke="url(#pa-edge-c)" strokeWidth="0.8" strokeDasharray="8 5" opacity=".48"/>
    </svg>

    {/* ── Aurora Blend dark wave geometry ───────────────────────────────
        EXACT SAME wave composition as light mode:
        identical SVG paths, curvature, direction, positions, layering, widths, blur, and edge lines.
        Theme-specific colors: midnight navy, royal/electric blue, cyan, turquoise, and violet/purple.
    ─────────────────────────────────────────────────────────────────── */}
    <svg className="welcome-dark-flow" viewBox="0 0 1440 900" preserveAspectRatio="xMidYMid slice">
      <defs>
        <linearGradient id="dk-wave-glow" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0"   stopColor="#001a42" stopOpacity="0"/>
          <stop offset=".22" stopColor="#003974" stopOpacity=".65"/>
          <stop offset=".5"  stopColor="#0064d5" stopOpacity=".75"/>
          <stop offset=".75" stopColor="#003974" stopOpacity=".55"/>
          <stop offset="1"   stopColor="#001026" stopOpacity="0"/>
        </linearGradient>
        <linearGradient id="dk-wave-royal" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0"   stopColor="#001a42" stopOpacity="0"/>
          <stop offset=".3"  stopColor="#087ee2" stopOpacity=".72"/>
          <stop offset=".58" stopColor="#00caff" stopOpacity=".8"/>
          <stop offset=".8"  stopColor="#0064d5" stopOpacity=".5"/>
          <stop offset="1"   stopColor="#001a42" stopOpacity="0"/>
        </linearGradient>
        <linearGradient id="dk-wave-cyan" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0"   stopColor="#001a42" stopOpacity="0"/>
          <stop offset=".35" stopColor="#0068da" stopOpacity=".55"/>
          <stop offset=".6"  stopColor="#00d6e4" stopOpacity=".78"/>
          <stop offset=".82" stopColor="#16b3c6" stopOpacity=".45"/>
          <stop offset="1"   stopColor="#001026" stopOpacity="0"/>
        </linearGradient>
        <linearGradient id="dk-wave-violet" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0"   stopColor="#001a42" stopOpacity="0"/>
          <stop offset=".38" stopColor="#a043ff" stopOpacity=".7"/>
          <stop offset=".68" stopColor="#8b6ce6" stopOpacity=".55"/>
          <stop offset=".88" stopColor="#00d6e4" stopOpacity=".3"/>
          <stop offset="1"   stopColor="#001026" stopOpacity="0"/>
        </linearGradient>
        <linearGradient id="dk-edge-c" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0"   stopColor="#00ccff" stopOpacity="0"/>
          <stop offset=".48" stopColor="#6af0ff" stopOpacity=".95"/>
          <stop offset="1"   stopColor="#00d6e4" stopOpacity="0"/>
        </linearGradient>
        <linearGradient id="dk-edge-r" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0"   stopColor="#0064d5" stopOpacity="0"/>
          <stop offset=".52" stopColor="#168aff" stopOpacity=".85"/>
          <stop offset="1"   stopColor="#a043ff" stopOpacity="0"/>
        </linearGradient>
        <filter id="dk-glow"><feGaussianBlur stdDeviation="30"/></filter>
        <filter id="dk-soft"><feGaussianBlur stdDeviation="18"/></filter>
      </defs>
      {/* Band 1 – wide navy/blue glow (exact same path & width 185) */}
      <path d="M-120 820 C160 900 280 570 510 630 S820 848 1050 588 S1255 205 1565 -38"
        fill="none" stroke="url(#dk-wave-glow)" strokeWidth="185" filter="url(#dk-glow)" opacity=".95"/>
      {/* Band 2 – mid electric blue (exact same path & width 88) */}
      <path d="M-55 868 C215 945 330 618 560 678 S875 888 1098 628 S1295 248 1605 8"
        fill="none" stroke="url(#dk-wave-royal)" strokeWidth="88" filter="url(#dk-soft)" opacity=".78"/>
      {/* Band 3 – royal blue / cyan / turquoise (exact same path & width 115) */}
      <path d="M-80 800 C160 874 300 534 558 594 S876 824 1098 564 S1282 162 1568 -55"
        fill="none" stroke="url(#dk-wave-cyan)" strokeWidth="115" filter="url(#dk-soft)" opacity=".82"/>
      {/* Band 4 – violet / purple accent (exact same path & width 95) */}
      <path d="M195 898 C472 800 618 502 858 522 S1138 762 1358 482 S1478 182 1602 82"
        fill="none" stroke="url(#dk-wave-violet)" strokeWidth="95" filter="url(#dk-soft)" opacity=".72"/>
      {/* Crisp cyan edge (exact same path & width 1.5) */}
      <path d="M-80 812 C160 882 300 542 558 602 S876 832 1098 572 S1282 172 1568 -48"
        fill="none" stroke="url(#dk-edge-c)" strokeWidth="1.5" opacity=".92"/>
      {/* Crisp royal edge (exact same path & width 1) */}
      <path d="M-40 842 C198 912 338 572 598 632 S918 852 1140 592 S1322 192 1605 -28"
        fill="none" stroke="url(#dk-edge-r)" strokeWidth="1" opacity=".78"/>
      {/* Dashed secondary (exact same path & width 0.8) */}
      <path d="M2 862 C242 932 382 602 642 662 S962 872 1182 612 S1362 212 1645 -18"
        fill="none" stroke="url(#dk-edge-c)" strokeWidth="0.8" strokeDasharray="8 5" opacity=".52"/>
    </svg>
  </div>;
}

export function WelcomePage({ onEnter, theme, onThemeChange, motion }: {
  onEnter: () => void; theme: string; onThemeChange: (theme: string) => void; motion: string;
}) {
  const [active, setActive] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const menuFirstItem = useRef<HTMLAnchorElement>(null);
  const stepButtons = useRef<(HTMLButtonElement | null)[]>([]);

  // Resolve effective theme for the icon: 'dark' if dark or system-dark, else 'light'
  const [sysDark, setSysDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches);
  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => setSysDark(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);
  const effectiveDark = theme === 'dark' || (theme === 'system' && sysDark);

  function toggleTheme() {
    // Cycle: if currently dark → light, if currently light → dark.
    // System is treated as its resolved value.
    onThemeChange(effectiveDark ? 'light' : 'dark');
  }
  useEffect(() => {
    if (!('IntersectionObserver' in window)) return;
    const observer = new IntersectionObserver(entries => entries.forEach(entry => {
      if (entry.isIntersecting) { entry.target.classList.add('is-revealed'); observer.unobserve(entry.target); }
    }), { threshold: .12 });
    const sections = root.current?.querySelectorAll('[data-reveal]');
    sections?.forEach(section => { section.classList.add('will-reveal'); observer.observe(section); });
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (menuOpen) menuFirstItem.current?.focus();
  }, [menuOpen]);
  function jump(event: React.MouseEvent<HTMLAnchorElement>, id: string) {
    event.preventDefault(); setMenuOpen(false);
    const target = document.getElementById(id);
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ behavior: motion === 'reduce' || matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' });
  }
  const enter = () => { window.scrollTo({ top: 0, behavior: 'instant' }); onEnter(); };
  function closeMenu() {
    setMenuOpen(false);
    menuButton.current?.focus();
  }
  return <div className="welcome-page" ref={root}>
    <WelcomeBackdrop />
    <header className="welcome-header">
      <div className="welcome-nav-inner">
        <a className="welcome-brand" href="#welcome-main" onClick={event => jump(event, 'welcome-main')}>EchoDrop</a>
        <button className="welcome-menu-toggle" ref={menuButton} aria-label={menuOpen ? 'Close navigation' : 'Open navigation'} aria-expanded={menuOpen} aria-controls="welcome-navigation" onClick={() => setMenuOpen(open => !open)}><span aria-hidden="true">{menuOpen ? '×' : '☰'}</span></button>
        <nav id="welcome-navigation" aria-label="Welcome" aria-modal={menuOpen || undefined} className={menuOpen ? 'is-open' : ''} onKeyDown={event => {
          if (event.key === 'Escape') { event.preventDefault(); closeMenu(); return; }
          if (event.key !== 'Tab') return;
          const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('a, button, select'));
          const next = event.shiftKey ? items[items.length - 1] : items[0];
          if (next && ((event.shiftKey && document.activeElement === items[0]) || (!event.shiftKey && document.activeElement === items[items.length - 1]))) { event.preventDefault(); next.focus(); }
        }}>
          <a ref={menuFirstItem} href="#why-echodrop" onClick={event => { jump(event, 'why-echodrop'); closeMenu(); }}>Why EchoDrop</a>
          <a href="#capabilities" onClick={event => { jump(event, 'capabilities'); closeMenu(); }}>Features</a>
          <a href="#for-teams" onClick={event => { jump(event, 'for-teams'); closeMenu(); }}>For Teams</a>
          <button
            className="welcome-theme-toggle"
            aria-label={effectiveDark ? 'Switch to light mode' : 'Switch to dark mode'}
            aria-pressed={effectiveDark}
            onClick={toggleTheme}
          >
            {effectiveDark ? '☀' : '☽'}
          </button>
          <button className="welcome-nav-enter" onClick={() => { closeMenu(); enter(); }}>Enter EchoDrop <span aria-hidden="true">→</span></button>
        </nav>
      </div>
    </header>
    <main id="welcome-main" tabIndex={-1} inert={menuOpen || undefined} aria-hidden={menuOpen || undefined}>
      <section className="welcome-hero welcome-container" aria-labelledby="welcome-title">
        <div className="welcome-hero-copy" id="why-echodrop" tabIndex={-1}>
          <p className="welcome-eyebrow">YOUR PROJECTS, IN SYNC</p>
          <h1 id="welcome-title">Build together.<br/><span>Go further.</span></h1>
          <p className="welcome-description">EchoDrop brings your people, files, tools and progress together — so you can focus on building great things, without the chaos.</p>
          <div className="welcome-actions"><button className="welcome-primary" onClick={enter}>Enter EchoDrop <span aria-hidden="true">→</span></button><a className="welcome-explore" href="#capabilities" onClick={event => jump(event, 'capabilities')}>Explore how it works <span aria-hidden="true">↓</span></a></div>
          <p className="welcome-note">No setup required. Start at your own pace.</p>
        </div>
        <div className="welcome-timeline" aria-label="Explore your workflow">
          <div className="welcome-timeline-track" aria-hidden="true"><span style={{ transform: `translateY(${active * 100}%)` }}/></div>
          <ol>{steps.map(([title, description], index) => <li key={title} className={active === index ? 'is-active' : ''}>
            <button ref={element => { stepButtons.current[index] = element; }} aria-pressed={active === index} aria-describedby={`welcome-step-${index}`} onPointerEnter={event => { if (event.pointerType === 'mouse') setActive(index); }} onFocus={() => setActive(index)} onClick={() => setActive(index)} onKeyDown={event => {
              const next = event.key === 'ArrowDown' ? (index + 1) % steps.length : event.key === 'ArrowUp' ? (index + steps.length - 1) % steps.length : event.key === 'Home' ? 0 : event.key === 'End' ? steps.length - 1 : null;
              if (next !== null) { event.preventDefault(); setActive(next); stepButtons.current[next]?.focus(); }
            }}><span className="welcome-marker" aria-hidden="true"/><span className="welcome-step-number" aria-hidden="true">0{index + 1}</span><span>{title}</span></button>
            <p id={`welcome-step-${index}`} className="welcome-step-description">{description}</p>
          </li>)}</ol>
        </div>
      </section>
      <section id="capabilities" className="welcome-capabilities welcome-container" tabIndex={-1} aria-labelledby="capabilities-title" data-reveal>
        <p className="welcome-eyebrow">WHAT YOU CAN DO</p>
        <div className="welcome-section-intro"><h2 id="capabilities-title">Everything you need<br/>for your projects —<br/><span>in one place.</span></h2><p>From organizing ideas to delivering final builds, EchoDrop connects the parts of your work so you can stay focused and keep moving forward.</p></div>
        <div className="welcome-capability-grid">{capabilities.map(([title, description, path], index) => <article className="welcome-capability" key={title} id={index === 1 ? 'for-teams' : undefined} tabIndex={0} aria-labelledby={`welcome-capability-${index}`}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={path}/></svg>
          <h3 id={`welcome-capability-${index}`}>{title}</h3><p>{description}</p>
        </article>)}</div>
      </section>
      <section className="welcome-closing welcome-container" aria-label="Enter EchoDrop" data-reveal><p className="welcome-eyebrow">READY TO GET STARTED?</p><button className="welcome-primary" onClick={enter}>Enter EchoDrop <span aria-hidden="true">→</span></button></section>
    </main>
  </div>;
}
