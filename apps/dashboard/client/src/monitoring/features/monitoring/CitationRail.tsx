import { ExternalLink, Link2 } from "lucide-react";

import type { RunAttempt } from "../../domain";
import { safeExternalUrl, visibleSourcesForAttempt } from "./selectors";
import type { SourceScope } from "./types";

export default function CitationRail({
  attempt,
  scope,
  onScopeChange,
}: {
  attempt: RunAttempt;
  scope: SourceScope;
  onScopeChange: (scope: SourceScope) => void;
}) {
  const sources = visibleSourcesForAttempt(attempt, scope);
  return (
    <aside className="fm-citation-rail" aria-label="引用信源">
      <header>
        <div>
          <Link2 size={16} />
          <h4>引用信源</h4>
        </div>
        <span>{sources.length}</span>
      </header>
      <div className="fm-rail-scopes" role="group" aria-label="引用信源筛选">
        <button
          type="button"
          className={scope === "all" ? "active" : ""}
          aria-pressed={scope === "all"}
          onClick={() => onScopeChange("all")}
        >
          全部来源
        </button>
        <button
          type="button"
          className={scope === "cited" ? "active" : ""}
          aria-pressed={scope === "cited"}
          onClick={() => onScopeChange("cited")}
        >
          真实引用
        </button>
        <button
          type="button"
          className={scope === "discovered" ? "active" : ""}
          aria-pressed={scope === "discovered"}
          onClick={() => onScopeChange("discovered")}
        >
          未引用发现
        </button>
      </div>
      <div className="fm-citation-list">
        {sources.length ? (
          sources.map((source, index) => {
            const safeUrl = safeExternalUrl(source.url);
            const isProvenCitation =
              attempt.citationProvenance === "explicit" &&
              source.isCited === true &&
              (!source.citationProvenance ||
                source.citationProvenance === "explicit");
            return (
              <article key={source.id} className="fm-citation-card">
                <span className="fm-citation-index">{index + 1}</span>
                <div>
                  <strong>{source.title || "未命名来源"}</strong>
                  <small>
                    {source.siteName || source.domain || "未知信源"}
                    {source.publishedAt
                      ? ` · 发布于 ${source.publishedAt}`
                      : ""}
                  </small>
                  <span
                    className={`fm-source-proof ${isProvenCitation ? "cited" : "discovered"}`}
                  >
                    {isProvenCitation ? "真实引用" : "发现来源"}
                  </span>
                  {source.citedText && <p>{source.citedText}</p>}
                  {safeUrl && (
                    <a href={safeUrl} target="_blank" rel="noopener noreferrer">
                      查看来源 <ExternalLink size={12} />
                    </a>
                  )}
                </div>
              </article>
            );
          })
        ) : (
          <div className="fm-rail-empty">
            <Link2 size={22} />
            <strong>该回答没有引用信源</strong>
            <span>平台未返回可验证的 citationList。</span>
          </div>
        )}
      </div>
      {attempt.citationProvenance &&
        attempt.citationProvenance !== "explicit" && (
          <p className="fm-provenance-note">
            当前引用来自兼容数据，无法确认是否为模型正文中的显式引用。
          </p>
        )}
    </aside>
  );
}
