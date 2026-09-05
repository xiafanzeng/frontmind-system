import {
  Check,
  CheckCircle2,
  Clock3,
  FileCheck2,
  Image as ImageIcon,
  LoaderCircle,
  Save,
  ShieldCheck,
} from "lucide-react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Link, useLocation } from "wouter";

import { usePublisherGateway, usePublisherQuery } from "../PublishingContext";
import {
  PublishingBreadcrumbs,
  PublishingError,
  PublishingLoading,
  PublishingPage,
} from "../components/PublishingUi";
import {
  publisherHtmlToPlainText,
  publisherPlainTextToHtml,
  sanitizePublisherEditorHtml,
} from "../editorContent";
import type {
  ArticleDetail,
  ArticleImage,
  PublisherEditorContent,
} from "../types";
import { publishingDateTime } from "../types";

const TipTapArticleEditor = lazy(
  () => import("../components/TipTapArticleEditor"),
);

export type ArticleEditorSurfaceProps = {
  value: PublisherEditorContent;
  images: readonly ArticleImage[];
  onChange: (value: PublisherEditorContent) => void;
  onUploadImage: (file: File) => Promise<ArticleImage>;
};

/** A second lazy boundary keeps TipTap out of every non-editor publishing page. */
export function ArticleEditorSurface({
  value,
  images,
  onChange,
  onUploadImage,
}: ArticleEditorSurfaceProps) {
  return (
    <Suspense
      fallback={
        <div className="publishing-editor-loading" role="status">
          正在加载富文本编辑器…
        </div>
      }
    >
      <TipTapArticleEditor
        value={value}
        images={images}
        onChange={onChange}
        onUploadImage={onUploadImage}
      />
    </Suspense>
  );
}

export default function PublishingArticleEditorPage({
  articleId,
}: {
  articleId: string;
}) {
  const gateway = usePublisherGateway();
  const [, navigate] = useLocation();
  const load = useCallback(
    (signal: AbortSignal) => gateway.getArticle(articleId, signal),
    [articleId, gateway],
  );
  const query = usePublisherQuery(load);
  const [article, setArticle] = useState<ArticleDetail>();
  const [title, setTitle] = useState("");
  const [content, setContent] = useState<PublisherEditorContent>({
    html: "",
    text: "",
    json: { type: "doc", content: [] },
  });
  const [images, setImages] = useState<ArticleImage[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [savedSignature, setSavedSignature] = useState("");
  const saveRequest = useRef(0);
  const previewObjectUrls = useRef(new Set<string>());

  useEffect(
    () => () => {
      if (typeof URL.revokeObjectURL === "function") {
        previewObjectUrls.current.forEach((url) => URL.revokeObjectURL(url));
      }
      previewObjectUrls.current.clear();
    },
    [],
  );

  useEffect(() => {
    if (!query.data) return;
    const html = sanitizePublisherEditorHtml(
      query.data.bodyHtml ?? publisherPlainTextToHtml(query.data.bodyText),
      query.data.images,
    );
    setArticle(query.data);
    setTitle(query.data.title);
    setContent({
      html,
      text: query.data.bodyText || publisherHtmlToPlainText(html),
      json: query.data.editorJson ?? { type: "doc", content: [] },
    });
    setImages(query.data.images);
    query.data.images.forEach((image) => {
      if (image.previewUrlIsObject && image.previewUrl) {
        previewObjectUrls.current.add(image.previewUrl);
      }
    });
    setSavedSignature(
      JSON.stringify([query.data.title, html, query.data.images]),
    );
  }, [query.data]);

  const signature = JSON.stringify([title, content.html, images]);
  const dirty = Boolean(article) && signature !== savedSignature;

  const saveNow = useCallback(async () => {
    if (!article || !dirty) return article;
    const request = ++saveRequest.current;
    const submittedSignature = signature;
    setSaving(true);
    setSaveError("");
    try {
      const bodyHtml = sanitizePublisherEditorHtml(content.html, images);
      const bodyText = publisherHtmlToPlainText(bodyHtml);
      const saved = await gateway.saveArticle({
        articleId: article.id,
        expectedRevision: article.revision,
        title,
        bodyText,
        bodyHtml,
        editorJson: content.json,
        images,
      });
      if (request === saveRequest.current) {
        setArticle(saved);
        setSavedSignature(submittedSignature);
      }
      return saved;
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "保存失败";
      if (request === saveRequest.current) setSaveError(message);
      throw reason;
    } finally {
      if (request === saveRequest.current) setSaving(false);
    }
  }, [article, content, dirty, gateway, images, signature, title]);

  useEffect(() => {
    if (!dirty || saving) return;
    const timer = window.setTimeout(
      () => void saveNow().catch(() => undefined),
      800,
    );
    return () => window.clearTimeout(timer);
  }, [dirty, saveNow, saving, signature]);

  const freezeAndContinue = async () => {
    if (!article) return;
    setSaveError("");
    try {
      const saved = (await saveNow()) ?? article;
      const frozen = await gateway.freezeArticle(saved.id, saved.revision);
      setArticle(frozen);
      setSavedSignature(
        JSON.stringify([
          frozen.title,
          sanitizePublisherEditorHtml(
            frozen.bodyHtml ?? publisherPlainTextToHtml(frozen.bodyText),
            frozen.images,
          ),
          frozen.images,
        ]),
      );
      navigate(
        `/publishing/media?articleVersion=${encodeURIComponent(frozen.currentVersionId!)}`,
      );
    } catch (reason) {
      setSaveError(reason instanceof Error ? reason.message : "无法冻结版本");
    }
  };

  const updateAlt = (id: string, altText: string) => {
    setImages((current) =>
      current.map((image) => (image.id === id ? { ...image, altText } : image)),
    );
  };

  const uploadImage = useCallback(
    async (file: File) => {
      if (!article) throw new Error("稿件尚未就绪");
      const defaultAlt = file.name.replace(/\.[^.]+$/u, "").trim();
      const uploaded = await gateway.uploadArticleImage(
        article.id,
        file,
        defaultAlt,
      );
      if (uploaded.previewUrlIsObject && uploaded.previewUrl) {
        previewObjectUrls.current.add(uploaded.previewUrl);
      }
      setImages((current) => [
        ...current.filter((image) => image.id !== uploaded.id),
        uploaded,
      ]);
      return uploaded;
    },
    [article, gateway],
  );

  return (
    <PublishingPage
      title="稿件编辑"
      description="编辑正文并冻结可追溯版本"
      busy={query.loading || saving}
      actions={
        article ? (
          <>
            <button
              className="publishing-button publishing-button-secondary"
              type="button"
              onClick={() => void saveNow().catch(() => undefined)}
              disabled={!dirty || saving}
            >
              {saving ? (
                <LoaderCircle className="publishing-spin" size={16} />
              ) : (
                <Save size={16} />
              )}
              {saving ? "保存中…" : dirty ? "保存草稿" : "已保存"}
            </button>
            <button
              className="publishing-button publishing-button-primary"
              type="button"
              onClick={freezeAndContinue}
              disabled={saving || !title.trim() || !content.text.trim()}
            >
              <FileCheck2 size={17} />
              保存新版本
            </button>
          </>
        ) : undefined
      }
    >
      <PublishingBreadcrumbs
        items={[
          { label: "稿件", href: "/publishing/articles" },
          { label: article?.title || "编辑" },
        ]}
      />
      {query.loading ? <PublishingLoading label="正在读取稿件编辑器…" /> : null}
      {query.error ? (
        <PublishingError error={query.error} onRetry={query.reload} />
      ) : null}
      {article ? (
        <>
          <div className="publishing-editor-meta">
            <span className="publishing-save-state">
              {saveError ? (
                <>
                  <span className="is-error" /> {saveError}
                </>
              ) : saving ? (
                <>
                  <span className="is-saving" /> 自动保存中
                </>
              ) : (
                <>
                  <span className="is-saved" />{" "}
                  {dirty
                    ? "等待自动保存"
                    : `已保存于 ${publishingDateTime(article.updatedAt)}`}
                </>
              )}
            </span>
            <span>
              {content.text.replace(/\s/g, "").length.toLocaleString("zh-CN")}{" "}
              字 · {images.length} 张图片
            </span>
          </div>
          <div className="publishing-editor-layout">
            <section className="publishing-panel publishing-editor-card">
              <label className="publishing-title-field">
                <span>稿件标题</span>
                <input
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  aria-label="稿件标题"
                  maxLength={100}
                />
              </label>
              <ArticleEditorSurface
                value={content}
                images={images}
                onChange={setContent}
                onUploadImage={uploadImage}
              />
              {images.length ? (
                <section
                  className="publishing-editor-images"
                  aria-labelledby="publishing-editor-images-title"
                >
                  <h2 id="publishing-editor-images-title">
                    <ImageIcon size={18} />
                    正文图片与替代文本
                  </h2>
                  {images.map((image) => (
                    <label key={image.id} className="publishing-image-row">
                      <span className="publishing-image-preview">
                        <ImageIcon size={22} />
                        <small>
                          {image.width} × {image.height}
                        </small>
                      </span>
                      <span>
                        <strong>{image.fileName}</strong>
                        <small>描述图片内容，帮助媒体校验和无障碍阅读。</small>
                      </span>
                      <input
                        value={image.altText}
                        onChange={(event) =>
                          updateAlt(image.id, event.target.value)
                        }
                        aria-label={`${image.fileName} 的 Alt 文本`}
                      />
                    </label>
                  ))}
                </section>
              ) : null}
              <footer className="publishing-editor-count">
                {content.text.replace(/\s/g, "").length.toLocaleString("zh-CN")}{" "}
                字 · {images.length} 张图片 ·{" "}
                {article.importChecks.externalLinkCount} 个链接
              </footer>
            </section>
            <aside className="publishing-editor-inspector">
              <section className="publishing-panel">
                <h2>版本与发布准备</h2>
                <div className="publishing-version-current">
                  <span>当前版本</span>
                  <strong>v{article.currentVersion}</strong>
                  <code>
                    {article.currentVersionHash?.slice(0, 12) || "尚未冻结"}
                  </code>
                </div>
                <div className="publishing-check-list">
                  <p>
                    <ShieldCheck size={17} />
                    DOCX 导入检查 <strong>已通过</strong>
                  </p>
                  <p>
                    <CheckCircle2 size={17} />
                    正文结构 <strong>已通过</strong>
                  </p>
                  <p>
                    <ImageIcon size={17} />
                    图片 <strong>{images.length} 张</strong>
                  </p>
                </div>
              </section>
              <section className="publishing-panel">
                <h2>
                  版本历史{" "}
                  <small>最近 {Math.min(article.versions.length, 3)} 版</small>
                </h2>
                <ol className="publishing-version-list">
                  {article.versions.slice(0, 3).map((version) => (
                    <li key={version.id}>
                      <span>v{version.version}</span>
                      <div>
                        <strong>{version.frozen ? "已冻结" : "草稿"}</strong>
                        <small>
                          {publishingDateTime(version.createdAt)} ·{" "}
                          {version.createdBy}
                        </small>
                      </div>
                      {version.version === article.currentVersion ? (
                        <Check size={15} />
                      ) : (
                        <Clock3 size={15} />
                      )}
                    </li>
                  ))}
                </ol>
              </section>
              <button
                className="publishing-button publishing-button-accent publishing-button-block"
                type="button"
                onClick={freezeAndContinue}
                disabled={saving || !title.trim() || !content.text.trim()}
              >
                选择媒体
              </button>
              <Link
                className="publishing-button publishing-button-secondary publishing-button-block"
                href="/publishing/articles"
              >
                返回稿件列表
              </Link>
            </aside>
          </div>
        </>
      ) : null}
    </PublishingPage>
  );
}
