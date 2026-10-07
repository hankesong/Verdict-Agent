const symbols: Record<string, string> = {
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  wallet: '<path d="M20 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0 0 4h15v14H5a2 2 0 0 1-2-2V5m17 7h-6v5h6m-3-2.5h.1"/>',
  shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z"/><path d="m8 12 3 3 5-6"/>',
  parcel: '<path d="m12 3 9 5v9l-9 5-9-5V8zM3 8l9 5 9-5M12 13v9M7.5 5.5l9 5v4"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8m0-5v5h5m4-1v5l3 2"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
};
export const symbol = (name: string, cls = "") => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${symbols[name] ?? symbols.shield}</svg>`;
export function productShell(views: string) {
  return `<a class="skip-link" href="#main-content">跳到主要内容</a><aside class="sidebar" id="product-sidebar">
    <a class="brand" href="#wallet"><span class="brand-icon">${symbol("shield")}</span><span>verdict<span class="brand-dot">.</span></span></a>
    <button id="new-transfer" class="new-transfer">${symbol("plus")}<span>新建付款</span><span class="shortcut">↗</span></button>
    <div class="history-heading">最近操作 <span id="history-count">0</span></div><nav id="wallet-history" aria-label="最近操作"><p class="history-empty">暂无操作记录</p></nav>
    <div class="sidebar-bottom"><details class="workspace-tools"><summary>${symbol("shield")}<span>审计工具</span><span>⌄</span></summary><nav aria-label="审计工具"><button data-view="task">账户验收</button><button data-view="evidence">证据复验</button><button data-view="services">服务目录</button><button data-view="activity">Agent 活动</button><button data-view="monitor">外审监控台</button><button data-view="threats">威胁账本</button></nav></details><div class="workspace-label"><span class="workspace-avatar">V</span><div>我的工作空间<small>Verdict Agent</small></div><span class="local-dot"></span></div></div>
  </aside><div class="workspace"><header class="topbar"><div class="topbar-left"><button id="sidebar-toggle" class="icon-button" aria-label="切换侧栏" aria-controls="product-sidebar" aria-expanded="true">${symbol("panel")}</button><span class="breadcrumb">工作空间 <span>/</span> <b id="page-name">新建付款</b></span></div><div class="topbar-right"><div class="connection"><span id="connection-status">正在连接…</span><button id="reconnect" class="icon-button" aria-label="重新连接后端">↻</button></div><button id="wallet-open" class="wallet-connect-button">${symbol("wallet")}<span id="wallet-top-account">连接钱包</span></button></div></header>
  <main id="main-content" tabindex="-1"><div id="notice" role="alert" hidden></div><section class="page-heading"><div><div class="eyebrow">VERDICT / AUDIT</div><h1 id="heading"></h1><p id="intro" hidden></p></div><span class="environment" hidden></span></section><div class="stats" hidden><div id="service-count"></div><div id="run-status"></div><div id="run-caption"></div><div id="evidence-count"></div></div>${views}</main><footer class="product-footer"><span>© Verdict</span><span>交易审查 <i>·</i> 证据可溯</span></footer></div>`;
}
