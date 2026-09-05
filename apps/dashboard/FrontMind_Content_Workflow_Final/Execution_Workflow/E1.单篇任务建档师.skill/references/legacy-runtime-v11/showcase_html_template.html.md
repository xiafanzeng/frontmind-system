<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{{brand}} — FrontMind 全链路优化报告</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;600;700&family=Noto+Sans+SC:wght@400;500;700&display=swap" rel="stylesheet">
  <style>
    /* === 全局重置与基础 === */
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg-primary: #0B0B0F;
      --bg-card: rgba(255,255,255,0.05);
      --bg-card-hover: rgba(124,58,237,0.1);
      --accent: #7C3AED;
      --accent-light: #A78BFA;
      --text-primary: #FAFAFA;
      --text-secondary: #A0A0B0;
      --text-muted: #6B6B7B;
      --border: rgba(255,255,255,0.08);
      --radius: 16px;
      --font-heading: 'Outfit', 'Noto Sans SC', sans-serif;
      --font-body: 'Noto Sans SC', 'Outfit', sans-serif;
    }
    body {
      background: var(--bg-primary);
      color: var(--text-primary);
      font-family: var(--font-body);
      line-height: 1.7;
      min-height: 100vh;
    }
    a { color: var(--accent-light); text-decoration: none; }
    a:hover { text-decoration: underline; }

    /* === Hero 区 === */
    .hero {
      text-align: center;
      padding: 80px 24px 60px;
      background: linear-gradient(180deg, rgba(124,58,237,0.15) 0%, transparent 100%);
    }
    .hero h1 {
      font-family: var(--font-heading);
      font-size: clamp(2rem, 5vw, 3.5rem);
      font-weight: 700;
      margin-bottom: 12px;
      background: linear-gradient(135deg, var(--accent-light), var(--text-primary));
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .hero .subtitle {
      font-size: 1.1rem;
      color: var(--text-secondary);
      margin-bottom: 8px;
    }
    .hero .date {
      font-size: 0.9rem;
      color: var(--text-muted);
    }

    /* === 流程图区 === */
    .pipeline {
      display: flex;
      justify-content: center;
      align-items: center;
      gap: 0;
      padding: 40px 24px;
      overflow-x: auto;
    }
    .pipeline-node {
      display: flex;
      flex-direction: column;
      align-items: center;
      min-width: 100px;
    }
    .pipeline-node .dot {
      width: 40px; height: 40px;
      border-radius: 50%;
      background: var(--bg-card);
      border: 2px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      font-size: 0.8rem;
      transition: all 0.3s;
    }
    .pipeline-node.active .dot {
      background: var(--accent);
      border-color: var(--accent);
      box-shadow: 0 0 20px rgba(124,58,237,0.4);
    }
    .pipeline-node.skipped .dot {
      opacity: 0.3;
    }
    .pipeline-node .label {
      margin-top: 8px;
      font-size: 0.75rem;
      color: var(--text-secondary);
      text-align: center;
      max-width: 90px;
    }
    .pipeline-arrow {
      width: 40px;
      height: 2px;
      background: var(--border);
      flex-shrink: 0;
    }
    .pipeline-arrow.active {
      background: var(--accent);
    }

    /* === 容器 === */
    .container {
      max-width: 1100px;
      margin: 0 auto;
      padding: 0 24px;
    }

    /* === 卡片网格 === */
    .cards {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
      gap: 24px;
      padding: 40px 0;
    }
    .card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 28px;
      transition: background 0.3s, border-color 0.3s;
    }
    .card:hover {
      background: var(--bg-card-hover);
      border-color: rgba(124,58,237,0.3);
    }
    .card .agent-tag {
      display: inline-block;
      font-size: 0.7rem;
      font-weight: 600;
      color: var(--accent-light);
      background: rgba(124,58,237,0.15);
      padding: 4px 10px;
      border-radius: 6px;
      margin-bottom: 12px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .card h3 {
      font-family: var(--font-heading);
      font-size: 1.15rem;
      margin-bottom: 10px;
    }
    .card p {
      font-size: 0.9rem;
      color: var(--text-secondary);
      margin-bottom: 16px;
    }
    .card .file-list {
      list-style: none;
      padding: 0;
    }
    .card .file-list li {
      font-size: 0.8rem;
      color: var(--text-muted);
      padding: 4px 0;
      border-top: 1px solid var(--border);
    }
    .card .file-list li::before {
      content: '📄 ';
    }

    /* === 统计底栏 === */
    .stats {
      display: flex;
      justify-content: center;
      gap: 48px;
      padding: 60px 24px;
      border-top: 1px solid var(--border);
    }
    .stat-item {
      text-align: center;
    }
    .stat-item .number {
      font-family: var(--font-heading);
      font-size: 2.5rem;
      font-weight: 700;
      color: var(--accent-light);
    }
    .stat-item .label {
      font-size: 0.85rem;
      color: var(--text-secondary);
      margin-top: 4px;
    }

    /* === 页脚 === */
    footer {
      text-align: center;
      padding: 30px 24px;
      font-size: 0.8rem;
      color: var(--text-muted);
    }
  </style>
</head>
<body>

  <!-- Hero 区 -->
  <section class="hero">
    <h1>{{brand}}</h1>
    <p class="subtitle">FrontMind 全链路优化报告</p>
    <p class="date">执行日期：{{execution_date}} &nbsp;|&nbsp; 策略包版本：{{pack_version}}</p>
  </section>

  <!-- 流程图区 -->
  <section class="pipeline">
    {{#each pipeline_nodes}}
    <div class="pipeline-node {{status}}">
      <div class="dot">{{code}}</div>
      <div class="label">{{name}}</div>
    </div>
    {{#unless @last}}<div class="pipeline-arrow {{#if active}}active{{/if}}"></div>{{/unless}}
    {{/each}}
  </section>

  <!-- 产物展示区 -->
  <div class="container">
    <div class="cards">
      {{#each agents}}
      <div class="card">
        <span class="agent-tag">{{agent_code}}</span>
        <h3>{{agent_name}}</h3>
        <p>{{summary}}</p>
        <ul class="file-list">
          {{#each files}}
          <li>{{this}}</li>
          {{/each}}
        </ul>
      </div>
      {{/each}}
    </div>
  </div>

  <!-- 统计底栏 -->
  <section class="stats">
    <div class="stat-item">
      <div class="number">{{total_agents}}</div>
      <div class="label">执行 Agent</div>
    </div>
    <div class="stat-item">
      <div class="number">{{total_articles}}</div>
      <div class="label">完成文章</div>
    </div>
    <div class="stat-item">
      <div class="number">{{total_files}}</div>
      <div class="label">产出文件</div>
    </div>
    <div class="stat-item">
      <div class="number">{{total_images}}</div>
      <div class="label">生成配图</div>
    </div>
  </section>

  <footer>
    FrontMind Execution Workflow &copy; {{year}} &mdash; Powered by GEO Methodology
  </footer>

</body>
</html>
