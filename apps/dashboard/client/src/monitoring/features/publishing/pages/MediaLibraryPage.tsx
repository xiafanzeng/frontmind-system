import {
  Check,
  ChevronDown,
  ExternalLink,
  Filter,
  Layers3,
  LoaderCircle,
  RefreshCw,
  Search,
  ShoppingBag,
  Trash2,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Link, useLocation, useSearch } from "wouter";
import { useAuth } from "@/_core/hooks/useAuth";
import {
  publishingDraftRequestKey,
  usePublishingFlow,
  usePublishingSummary,
} from "../PublishingFlowContext";
import {
  mediaSelectionBlocker,
  mediaShortlistKey,
  readMediaShortlist,
  saveMediaShortlist,
  switchMediaKind,
} from "../mediaShortlist";

import { usePublisherGateway, usePublisherQuery } from "../PublishingContext";
import {
  MediaMark,
  PublishingEmpty,
  PublishingError,
  PublishingLoading,
  PublishingPage,
  PublishingPagination,
  PublishingSteps,
  PublishingConfirmDialog,
} from "../components/PublishingUi";
import {
  DEFAULT_MEDIA_FILTERS,
  parseBatchQuery,
  readMediaRouteState,
  writeMediaRouteState,
} from "../queryState";
import {
  formatPublishingMoney,
  type MediaFilters,
  type MediaResource,
  type PublicationDraft,
  type PublisherMediaKind,
} from "../types";

function kindLabel(kind: MediaResource["kind"]) {
  return kind === "self_media"
    ? "自媒体"
    : kind === "news"
      ? "软文媒体"
      : "历史媒体";
}

function capabilityLabel(capability: MediaResource["capability"]) {
  if (capability === "image") return "支持图文";
  if (capability === "image_pending") return "图文能力";
  return "仅文字";
}

function percentage(value?: number) {
  return value === undefined ? "—" : `${value}%`;
}

function compactNumber(value?: number) {
  if (value === undefined) return "—";
  if (value >= 10_000)
    return `${(value / 10_000).toFixed(value >= 100_000 ? 0 : 1)}万`;
  return value.toLocaleString("zh-CN");
}

export default function PublishingMediaLibraryPage({
  draftId: routeDraftId,
}: {
  draftId?: string;
}) {
  const gateway = usePublisherGateway();
  const flow = usePublishingFlow();
  const draftId =
    routeDraftId ??
    flow?.resources?.find((resource) => resource.kind === "publication_draft")
      ?.id;
  const [location, navigate] = useLocation();
  const search = useSearch();
  const { user } = useAuth();
  const accountShortlistKey = mediaShortlistKey(user?.id, search);
  const shortlistKey =
    flow && accountShortlistKey
      ? `${accountShortlistKey}:task:${flow.taskId ?? "new"}`
      : accountShortlistKey;
  const pathname = location || "/publishing/media";
  const routeState = useMemo(() => readMediaRouteState(search), [search]);
  const { filters } = routeState;
  const articleVersionId =
    routeState.articleVersionId ??
    flow?.resources?.find((resource) => resource.kind === "article_version")
      ?.id;
  const [queryDraft, setQueryDraft] = useState(filters.query);
  const [batchQueryDraft, setBatchQueryDraft] = useState(
    filters.batchQuery ?? "",
  );
  const [recommendationDraft, setRecommendationDraft] = useState({
    industry: "",
    product: "",
    region: "",
    audience: "",
    keywords: "",
    budget: "",
    format: "",
  });
  const selectionScope = useMemo(
    () => ({ gateway, shortlistKey, draftId, articleVersionId }),
    [gateway, shortlistKey, draftId, articleVersionId],
  );
  const [selection, setSelection] = useState(() => ({
    scope: selectionScope,
    items: readMediaShortlist(shortlistKey),
  }));
  const selected = useMemo(
    () =>
      selection.scope === selectionScope
        ? selection.items
        : new Map<string, MediaResource>(),
    [selection, selectionScope],
  );
  const setSelected = useCallback(
    (items: Map<string, MediaResource>) =>
      setSelection({ scope: selectionScope, items }),
    [selectionScope],
  );
  const [draftState, setDraftState] = useState<{
    scope: typeof selectionScope;
    value?: PublicationDraft;
  }>();
  const draft =
    draftState?.scope === selectionScope ? draftState.value : undefined;
  const setDraft = useCallback(
    (value?: PublicationDraft) =>
      setDraftState({ scope: selectionScope, value }),
    [selectionScope],
  );
  const [selectionError, setSelectionError] = useState("");
  const [selectionBusy, setSelectionBusy] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [articleChooserOpen, setArticleChooserOpen] = useState(false);
  const [chosenVersion, setChosenVersion] = useState("");
  const [boundDraft, setBoundDraft] = useState<PublicationDraft>();
  const selectionInFlight = useRef(false);
  const selectionGeneration = useRef(0);
  useEffect(() => {
    selectionGeneration.current += 1;
    selectionInFlight.current = false;
    setSelectionBusy(false);
    setSelectionError("");
    setArticleChooserOpen(false);
    setBoundDraft(undefined);
    return () => {
      selectionGeneration.current += 1;
    };
  }, [selectionScope]);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [batchOpen, setBatchOpen] = useState(Boolean(filters.batchQuery));
  const [businessFiltersOpen, setBusinessFiltersOpen] = useState(false);
  const observedCatalogRevision = useRef<string | undefined>(undefined);
  const [catalogRevisionChange, setCatalogRevisionChange] = useState<{
    previous: string;
    current: string;
  }>();

  const loadMedia = useCallback(
    (signal: AbortSignal) => gateway.listMedia(filters, signal),
    [filters, gateway],
  );
  const loadFacets = useCallback(
    (signal: AbortSignal) => gateway.getMediaFacets(filters, signal),
    [filters, gateway],
  );
  const loadArticles = useCallback(
    (signal: AbortSignal) => gateway.listArticles(signal),
    [gateway],
  );
  const loadDraft = useCallback(
    (signal: AbortSignal) =>
      draftId ? gateway.getDraft(draftId, signal) : Promise.resolve(undefined),
    [draftId, gateway],
  );
  const mediaQuery = usePublisherQuery(
    loadMedia,
    `media:${JSON.stringify(filters)}`,
  );
  const facetsQuery = usePublisherQuery(
    loadFacets,
    `media-facets:${filters.kind}`,
  );
  const articlesQuery = usePublisherQuery(loadArticles, "article-choices");
  const draftQuery = usePublisherQuery(loadDraft, `draft:${draftId ?? "none"}`);

  useEffect(() => {
    const canonical = writeMediaRouteState(pathname, filters, articleVersionId);
    const current = search
      ? `${pathname}?${search.replace(/^\?/u, "")}`
      : pathname;
    if (canonical !== current) navigate(canonical, { replace: true });
  }, [articleVersionId, filters, navigate, pathname, search]);

  useEffect(() => {
    if (
      facetsQuery.data?.catalog.kindComplete === false &&
      filters.kind === "self_media"
    ) {
      navigate(
        writeMediaRouteState(
          pathname,
          { ...filters, kind: "news", page: 1 },
          articleVersionId,
        ),
        { replace: true },
      );
    }
  }, [
    articleVersionId,
    facetsQuery.data?.catalog.kindComplete,
    filters,
    navigate,
    pathname,
  ]);

  useEffect(() => {
    if (!draftQuery.data) {
      setDraft(undefined);
      setSelected(draftId ? new Map() : readMediaShortlist(shortlistKey));
      return;
    }
    setDraft(draftQuery.data);
    if (flow) setBoundDraft(draftQuery.data);
    setSelected(
      new Map(draftQuery.data.items.map((item) => [item.media.id, item.media])),
    );
  }, [draftId, draftQuery.data, shortlistKey, setDraft, setSelected]);

  const persistedSelection = flow?.selections?.mediaSelection;
  useEffect(() => {
    if (!flow || draftId || !Array.isArray(persistedSelection)) return;
    const rows = persistedSelection.filter((row): row is MediaResource =>
      Boolean(
        row &&
          typeof row === "object" &&
          typeof row.id === "string" &&
          typeof row.priceTenThousandths === "string",
      ),
    );
    setSelected(new Map(rows.slice(0, 20).map((row) => [row.id, row])));
  }, [draftId, persistedSelection, setSelected]);

  useEffect(() => {
    if (selection.scope === selectionScope && !draftId && !draft)
      saveMediaShortlist(shortlistKey, selected);
  }, [draftId, draft, selected, shortlistKey, selection.scope, selectionScope]);

  useEffect(() => {
    const revision = mediaQuery.data?.catalog.activeRevision;
    if (!revision) return;
    if (!observedCatalogRevision.current) {
      observedCatalogRevision.current = revision;
      return;
    }
    if (observedCatalogRevision.current === revision) return;
    setCatalogRevisionChange({
      previous: observedCatalogRevision.current,
      current: revision,
    });
    observedCatalogRevision.current = revision;
  }, [mediaQuery.data?.catalog.activeRevision]);

  const selectedValues = useMemo(() => [...selected.values()], [selected]);
  const selectedTotal = useMemo(
    () =>
      selectedValues
        .reduce((sum, media) => sum + BigInt(media.priceTenThousandths), 0n)
        .toString(),
    [selectedValues],
  );
  const selectedCounts = useMemo(
    () => ({
      news: selectedValues.filter((media) => media.kind === "news").length,
      self_media: selectedValues.filter((media) => media.kind === "self_media")
        .length,
    }),
    [selectedValues],
  );

  const navigateFilters = (
    next: MediaFilters,
    nextPath = pathname,
    nextVersion = articleVersionId,
  ) => {
    navigate(writeMediaRouteState(nextPath, next, nextVersion));
    void flow?.saveSelections({ mediaFilters: next }).catch(() => undefined);
  };
  const applySmartRecommendation = (
    event: React.FormEvent<HTMLFormElement>,
  ) => {
    event.preventDefault();
    const terms = [
      recommendationDraft.industry,
      recommendationDraft.product,
      recommendationDraft.region,
      recommendationDraft.audience,
      recommendationDraft.keywords,
      recommendationDraft.budget,
      recommendationDraft.format,
    ]
      .map((value) => value.trim())
      .filter(Boolean);
    navigateFilters({
      ...filters,
      query: terms.join(" "),
      recommended: "true",
      page: 1,
    });
  };

  useEffect(() => setQueryDraft(filters.query), [filters.query]);
  useEffect(
    () => setBatchQueryDraft(filters.batchQuery ?? ""),
    [filters.batchQuery],
  );

  useEffect(() => {
    if (queryDraft === filters.query) return;
    const timeout = window.setTimeout(() => {
      navigateFilters({ ...filters, query: queryDraft, page: 1 });
    }, 300);
    return () => window.clearTimeout(timeout);
  }, [filters, queryDraft]);

  useEffect(() => {
    const current = filters.batchQuery ?? "";
    if (batchQueryDraft === current) return;
    const timeout = window.setTimeout(() => {
      navigateFilters({ ...filters, batchQuery: batchQueryDraft, page: 1 });
    }, 300);
    return () => window.clearTimeout(timeout);
  }, [batchQueryDraft, filters]);

  const updateFilter = <K extends keyof MediaFilters>(
    key: K,
    value: MediaFilters[K],
  ) => {
    navigateFilters({
      ...filters,
      [key]: value,
      page: key === "page" ? Number(value) : 1,
    });
  };

  const setKind = (kind: PublisherMediaKind) =>
    navigateFilters(switchMediaKind(filters, kind, DEFAULT_MEDIA_FILTERS));

  const persistMediaIds = async (
    mediaIds: string[],
    optimistic: Map<string, MediaResource>,
  ) => {
    if (draftId && !draft) return;
    if ((!articleVersionId || flow) && !draft) {
      if (flow) {
        if (selectionInFlight.current) return;
        selectionInFlight.current = true;
        const generation = selectionGeneration.current;
        setSelectionBusy(true);
        try {
          await flow.saveSelections({
            mediaSelection: [...optimistic.values()],
            mediaFilters: filters,
          });
          if (generation === selectionGeneration.current) {
            setSelected(optimistic);
            setSelectionError("");
          }
        } catch (reason) {
          if (generation === selectionGeneration.current)
            setSelectionError(
              reason instanceof Error
                ? reason.message
                : "媒体选择未能保存，请重试",
            );
        } finally {
          if (generation === selectionGeneration.current) {
            selectionInFlight.current = false;
            setSelectionBusy(false);
          }
        }
      } else {
        setSelected(optimistic);
        setSelectionError("");
        saveMediaShortlist(shortlistKey, optimistic);
      }
      return;
    }
    if (selectionInFlight.current) return;
    selectionInFlight.current = true;
    const generation = selectionGeneration.current;
    setSelectionBusy(true);
    setSelectionError("");
    setSelected(optimistic);
    try {
      if (draft) {
        const saved = await gateway.updateDraftMedia(
          draft.id,
          mediaIds,
          draft.revision,
        );
        if (generation !== selectionGeneration.current) return;
        setDraft(saved);
        setSelected(
          new Map(saved.items.map((item) => [item.media.id, item.media])),
        );
      } else {
        const taskId = flow ? await flow.ensureTask() : undefined;
        const requestKey = taskId
          ? await publishingDraftRequestKey(taskId, articleVersionId!, mediaIds)
          : undefined;
        const saved = requestKey
          ? await gateway.createDraft(articleVersionId!, mediaIds, requestKey)
          : await gateway.createDraft(articleVersionId!, mediaIds);
        if (generation !== selectionGeneration.current) return;
        saveMediaShortlist(shortlistKey, new Map());
        setDraft(saved);
        setSelected(
          new Map(saved.items.map((item) => [item.media.id, item.media])),
        );
        navigateFilters(
          filters,
          `/publishing/drafts/${saved.id}/media`,
          articleVersionId,
        );
      }
    } catch (reason) {
      if (generation !== selectionGeneration.current) return;
      if (draft)
        setSelected(
          new Map(draft.items.map((item) => [item.media.id, item.media])),
        );
      else setSelected(optimistic);
      setSelectionError(
        reason instanceof Error ? reason.message : "所选媒体未能保存",
      );
    } finally {
      if (generation === selectionGeneration.current) {
        selectionInFlight.current = false;
        setSelectionBusy(false);
      }
    }
  };

  const toggle = (media: MediaResource) => {
    if (selectionInFlight.current || selectionBusy) return;
    setBoundDraft(undefined);
    const next = new Map(selected);
    if (next.has(media.id)) {
      next.delete(media.id);
      void persistMediaIds([...next.keys()], next);
      return;
    }
    const blocker = mediaSelectionBlocker(media, articleHasImages);
    if (blocker) {
      setSelectionError(blocker);
      return;
    }
    if (next.size >= 20) {
      setSelectionError("一次最多选择 20 家媒体");
      return;
    }
    next.set(media.id, media);
    void persistMediaIds([...next.keys()], next);
  };

  const clearSelection = () => {
    if (!selected.size || selectionBusy) return;
    void persistMediaIds([], new Map());
  };

  const refreshChangedCatalog = () => {
    setCatalogRevisionChange(undefined);
    if (filters.page === 1) {
      mediaQuery.reload();
      return;
    }
    navigateFilters({ ...filters, page: 1 });
  };

  const pageCount = mediaQuery.data
    ? Math.max(1, Math.ceil(mediaQuery.data.total / mediaQuery.data.pageSize))
    : 1;
  useEffect(() => {
    if (!mediaQuery.data || filters.page <= pageCount) return;
    navigateFilters({ ...filters, page: pageCount });
  }, [filters, mediaQuery.data, pageCount]);
  const currentKindCount =
    filters.kind === "self_media"
      ? mediaQuery.data?.catalog.selfMediaCount
      : mediaQuery.data?.catalog.newsCount;
  const frozenArticles =
    articlesQuery.data?.filter((article) => article.currentVersionId) ?? [];
  const selectedArticle = articlesQuery.data?.find((article) =>
    draft
      ? article.id === draft.articleId
      : article.currentVersionId === articleVersionId,
  );
  const articleHasImages = draft
    ? draft.articleContainsImages
    : Boolean(selectedArticle?.imageCount);
  usePublishingSummary({
    title: "当前投放选择",
    items: [
      {
        label: "已选媒体",
        value: `${selected.size} 家 · 软文 ${selectedCounts.news} / 自媒体 ${selectedCounts.self_media}`,
      },
      { label: "预估合计", value: formatPublishingMoney(selectedTotal) },
      {
        label: "当前稿件",
        value:
          (boundDraft ?? draft)?.articleTitle ??
          selectedArticle?.title ??
          "待选择冻结稿件",
      },
      {
        label: "状态",
        value: selectionBusy
          ? "正在保存"
          : boundDraft
            ? "稿件已绑定，等待交接"
            : "选择中",
      },
      ...selectedValues.map((media) => ({
        label: media.name,
        value: formatPublishingMoney(media.priceTenThousandths),
      })),
    ],
    note: selectionError || "最终报价与发布能力在预检时重新核对。",
  });

  const chooseArticle = () => {
    setDrawerOpen(false);
    const currentVersion = draft?.articleVersionId ?? articleVersionId;
    setChosenVersion(
      frozenArticles.some(
        (article) => article.currentVersionId === currentVersion,
      )
        ? currentVersion!
        : "",
    );
    setArticleChooserOpen(true);
  };
  const bindArticle = async () => {
    if (!chosenVersion || selectionInFlight.current) return;
    if (!selected.size) {
      setArticleChooserOpen(false);
      navigateFilters(
        { ...filters, page: 1 },
        "/publishing/media",
        chosenVersion,
      );
      return;
    }
    selectionInFlight.current = true;
    const generation = selectionGeneration.current;
    setSelectionBusy(true);
    setSelectionError("");
    try {
      // A new draft also clears titles from the previously selected article.
      const mediaIds = [...selected.keys()];
      const taskId = flow ? await flow.ensureTask() : undefined;
      const requestKey = taskId
        ? await publishingDraftRequestKey(taskId, chosenVersion, mediaIds)
        : undefined;
      if (generation !== selectionGeneration.current) return;
      const saved = requestKey
        ? await gateway.createDraft(chosenVersion, mediaIds, requestKey)
        : await gateway.createDraft(chosenVersion, mediaIds);
      if (generation !== selectionGeneration.current) return;
      saveMediaShortlist(shortlistKey, new Map());
      setDraft(saved);
      setArticleChooserOpen(false);
      if (flow) {
        setBoundDraft(saved);
        await flow.record({
          id: `media-bound:${saved.id}`,
          label: `已选择 ${saved.items.length} 家媒体并绑定稿件`,
          detail: `${saved.articleTitle} · v${saved.articleVersion}`,
          resources: [
            { kind: "article_version", id: saved.articleVersionId },
            { kind: "publication_draft", id: saved.id },
          ],
        });
      } else navigate(`/publishing/drafts/${saved.id}/titles`);
    } catch (error) {
      if (generation !== selectionGeneration.current) return;
      setSelectionError(
        error instanceof Error ? error.message : "稿件绑定失败，请重试",
      );
    } finally {
      if (generation === selectionGeneration.current) {
        selectionInFlight.current = false;
        setSelectionBusy(false);
      }
    }
  };
  const continueSelection = () => {
    if (flow && draft) setBoundDraft(draft);
    else if (draft) navigate(`/publishing/drafts/${draft.id}/titles`);
    else chooseArticle();
  };
  const handoff = async () => {
    if (!flow || !boundDraft || selectionInFlight.current) return;
    selectionInFlight.current = true;
    setSelectionBusy(true);
    setSelectionError("");
    try {
      await flow.handoff({
        targetAgentId: "publishing",
        title: `发布 · ${boundDraft.articleTitle}`,
        resources: [
          { kind: "article_version", id: boundDraft.articleVersionId },
          { kind: "publication_draft", id: boundDraft.id },
        ],
        idempotencyKey: `media-publishing-${boundDraft.id}`,
        route: `/publishing/drafts/${boundDraft.id}/titles`,
      });
    } catch (reason) {
      setSelectionError(
        reason instanceof Error ? reason.message : "交接未完成，请重试",
      );
    } finally {
      selectionInFlight.current = false;
      setSelectionBusy(false);
    }
  };
  const activeFilterCount = [
    filters.platform,
    filters.taxonomy,
    filters.mediaType,
    filters.area,
    filters.recommended,
    filters.priceMin,
    filters.priceMax,
    filters.includeType,
    filters.publishSpeed,
    filters.entryType,
    filters.linkType,
    filters.pcWeight,
    filters.includeRate,
    filters.successRate,
    filters.authenticated,
    filters.festival,
  ].filter(Boolean).length;
  const recommendedCount = facetCount(
    facetsQuery.data?.recommendedOptions,
    "true",
  );
  const authenticatedCount = facetCount(
    facetsQuery.data?.authenticatedOptions,
    "true",
  );
  const festivalCount = facetCount(
    facetsQuery.data?.festivalPublishableOptions,
    "true",
  );

  return (
    <PublishingPage
      title="媒体库"
      description={
        filters.kind === "self_media"
          ? "按平台、账号影响力与报价挑选自媒体，加入清单后统一配置稿件。"
          : "按媒体、频道、收录表现与报价筛选软文资源，加入清单后统一配置稿件。"
      }
      busy={mediaQuery.loading || mediaQuery.refreshing || selectionBusy}
      actions={
        mediaQuery.data ? (
          <span className="publishing-catalog-count">
            {mediaQuery.data.catalog.stale
              ? "媒体目录待更新"
              : "媒体目录已同步"}
          </span>
        ) : undefined
      }
    >
      {articleVersionId || draft ? <PublishingSteps current={2} /> : null}

      <section className="publishing-context-bar" aria-label="发布稿件">
        <div>
          <span>当前稿件</span>
          {draft ? (
            <strong>
              {draft.articleTitle} <small>v{draft.articleVersion}</small>
            </strong>
          ) : (
            <strong>{selectedArticle?.title ?? "尚未选择"}</strong>
          )}
          <button
            type="button"
            className="publishing-button publishing-button-secondary"
            onClick={chooseArticle}
            disabled={selectionBusy || Boolean(draftId && !draft)}
          >
            {draft || articleVersionId ? "更换稿件" : "选择稿件"}
          </button>
        </div>
        {!articleVersionId && !draft ? (
          <p>可以先选媒体，再选择稿件；确认发布前统一核对报价。</p>
        ) : null}
        <Link href="/publishing/articles">管理稿件</Link>
      </section>

      {flow && (
        <button
          type="button"
          className="publishing-button publishing-button-secondary publishing-business-filter-trigger"
          aria-expanded={businessFiltersOpen}
          onClick={() => setBusinessFiltersOpen((value) => !value)}
        >
          <Filter size={15} />
          按业务需求筛选
        </button>
      )}
      {(!flow || businessFiltersOpen) && (
        <form
          className="publishing-media-recommendation"
          aria-label="按业务需求筛选媒体"
          onSubmit={applySmartRecommendation}
        >
          <div className="publishing-media-recommendation-copy">
            <strong>按业务需求筛选媒体</strong>
            <span>组合行业与产品关键词，查找目录中的推荐媒体。</span>
          </div>
          {[
            ["industry", "行业"],
            ["product", "产品或服务"],
            ["region", "目标地区"],
            ["audience", "目标受众"],
            ["keywords", "行业词或品牌词"],
            ["budget", "预算（可选）"],
            ["format", "图文要求（可选）"],
          ].map(([key, label]) => (
            <input
              key={key}
              aria-label={label}
              placeholder={label}
              value={
                recommendationDraft[key as keyof typeof recommendationDraft]
              }
              onChange={(event) =>
                setRecommendationDraft((current) => ({
                  ...current,
                  [key]: event.target.value,
                }))
              }
            />
          ))}
          <button
            className="publishing-button publishing-button-primary"
            type="submit"
            disabled={
              !Object.values(recommendationDraft).some((value) => value.trim())
            }
          >
            <Search size={15} />
            应用筛选
          </button>
        </form>
      )}

      <section
        className="publishing-media-workbench"
        aria-label="媒体筛选工作台"
      >
        <nav className="publishing-kind-tabs" aria-label="媒体类型">
          <button
            type="button"
            className={filters.kind === "news" ? "is-active" : ""}
            aria-pressed={filters.kind === "news"}
            onClick={() => setKind("news")}
          >
            软文媒体 <span>{facetsQuery.data?.kinds.news ?? "—"}</span>
          </button>
          <button
            type="button"
            className={filters.kind === "self_media" ? "is-active" : ""}
            aria-pressed={filters.kind === "self_media"}
            disabled={facetsQuery.data?.catalog.kindComplete === false}
            title={
              facetsQuery.data?.catalog.kindComplete === false
                ? "双媒体目录尚未完成同步"
                : undefined
            }
            onClick={() => setKind("self_media")}
          >
            自媒体 <span>{facetsQuery.data?.kinds.self_media ?? "—"}</span>
          </button>
        </nav>

        <div className="publishing-media-search-row">
          <label className="publishing-search-field">
            <Search size={18} />
            <span className="publishing-visually-hidden">搜索媒体</span>
            <input
              value={queryDraft}
              onChange={(event) => setQueryDraft(event.target.value)}
              placeholder="搜索媒体名称、平台或资源 ID"
            />
          </label>
          <button
            className={`publishing-button publishing-button-secondary ${batchOpen ? "is-active" : ""}`}
            type="button"
            onClick={() => setBatchOpen((value) => !value)}
          >
            <Layers3 size={16} />
            批量搜索
            {parseBatchQuery(filters.batchQuery ?? "").length
              ? ` (${parseBatchQuery(filters.batchQuery ?? "").length})`
              : ""}
          </button>
          <label className="publishing-sort-field">
            排序
            <select
              value={filters.sort}
              onChange={(event) =>
                updateFilter("sort", event.target.value as MediaFilters["sort"])
              }
            >
              <option value="recommended">综合推荐</option>
              <option value="price_asc">价格从低到高</option>
              <option value="price_desc">价格从高到低</option>
              <option value="success_desc">通过率优先</option>
              <option value="include_desc">收录率优先</option>
              <option value="weight_desc">百度权重优先</option>
              <option value="updated_desc">最近更新</option>
            </select>
          </label>
        </div>

        {batchOpen ? (
          <label className="publishing-batch-search">
            <span>
              批量搜索 <small>每行一个媒体名称或资源 ID，最多 50 项</small>
            </span>
            <textarea
              value={batchQueryDraft}
              onChange={(event) => setBatchQueryDraft(event.target.value)}
              rows={3}
              placeholder={"中国财经时报网\n100023\n科技商业观察"}
            />
            <b>{parseBatchQuery(batchQueryDraft).length} / 50</b>
          </label>
        ) : null}

        <div className="publishing-filter-groups">
          <FilterLine label="平台">
            <FilterSelect
              label="全部平台"
              value={filters.platform}
              options={facetsQuery.data?.platforms}
              onChange={(value) => updateFilter("platform", value)}
            />
          </FilterLine>
          <FilterLine label="频道分类">
            <FilterSelect
              label="全部频道"
              value={filters.taxonomy}
              options={facetsQuery.data?.taxonomies}
              onChange={(value) => updateFilter("taxonomy", value)}
            />
          </FilterLine>
          <FilterLine label="媒体类别">
            <FilterSelect
              label="全部类别"
              value={filters.mediaType}
              options={facetsQuery.data?.mediaTypes}
              onChange={(value) => updateFilter("mediaType", value)}
            />
          </FilterLine>
          <FilterLine label="覆盖区域">
            <FilterSelect
              label="全部地区"
              value={filters.area}
              options={facetsQuery.data?.areas}
              onChange={(value) => updateFilter("area", value)}
            />
          </FilterLine>
          <FilterLine label="价格">
            <div className="publishing-filter-pills">
              {[
                { label: "不限", min: "", max: "" },
                { label: "¥100 以下", min: "", max: "100" },
                { label: "¥100–300", min: "100", max: "300" },
                { label: "¥300 以上", min: "300", max: "" },
              ].map((option) => (
                <button
                  key={option.label}
                  type="button"
                  className={
                    filters.priceMin === option.min &&
                    filters.priceMax === option.max
                      ? "is-active"
                      : ""
                  }
                  onClick={() =>
                    navigateFilters({
                      ...filters,
                      priceMin: option.min,
                      priceMax: option.max,
                      page: 1,
                    })
                  }
                >
                  {option.label}
                </button>
              ))}
              <span className="publishing-price-range">
                <i>¥</i>
                <input
                  inputMode="decimal"
                  aria-label="最低价格"
                  value={filters.priceMin}
                  onChange={(event) =>
                    updateFilter(
                      "priceMin",
                      event.target.value.replace(/[^\d.]/gu, ""),
                    )
                  }
                  placeholder="最低"
                />
                <em>—</em>
                <input
                  inputMode="decimal"
                  aria-label="最高价格"
                  value={filters.priceMax}
                  onChange={(event) =>
                    updateFilter(
                      "priceMax",
                      event.target.value.replace(/[^\d.]/gu, ""),
                    )
                  }
                  placeholder="最高"
                />
              </span>
            </div>
          </FilterLine>
          {recommendedCount !== 0 || filters.recommended === "true" ? (
            <FilterLine label="媒体推荐">
              <div className="publishing-filter-pills">
                <button
                  type="button"
                  className={!filters.recommended ? "is-active" : ""}
                  onClick={() => updateFilter("recommended", "")}
                >
                  不限
                </button>
                <button
                  type="button"
                  className={filters.recommended === "true" ? "is-active" : ""}
                  disabled={
                    recommendedCount === 0 && filters.recommended !== "true"
                  }
                  onClick={() => updateFilter("recommended", "true")}
                >
                  平台推荐
                  {recommendedCount === undefined
                    ? ""
                    : ` (${recommendedCount})`}
                </button>
              </div>
            </FilterLine>
          ) : null}
        </div>

        <button
          className="publishing-advanced-toggle"
          type="button"
          aria-expanded={advancedOpen}
          onClick={() => setAdvancedOpen((value) => !value)}
        >
          <Filter size={16} />
          高级筛选{activeFilterCount ? <b>{activeFilterCount}</b> : null}
          <ChevronDown className={advancedOpen ? "is-open" : ""} size={16} />
        </button>
        {advancedOpen ? (
          <div className="publishing-advanced-grid">
            <FilterSelect
              label="收录类型"
              value={filters.includeType}
              options={facetsQuery.data?.includeTypes}
              onChange={(value) => updateFilter("includeType", value)}
            />
            <FilterSelect
              label="发布速度"
              value={filters.publishSpeed}
              options={facetsQuery.data?.publishSpeeds}
              onChange={(value) => updateFilter("publishSpeed", value)}
            />
            <FilterSelect
              label="入口类型"
              value={filters.entryType}
              options={facetsQuery.data?.entryTypes}
              onChange={(value) => updateFilter("entryType", value)}
            />
            <FilterSelect
              label="链接类型"
              value={filters.linkType}
              options={facetsQuery.data?.linkTypes}
              onChange={(value) => updateFilter("linkType", value)}
            />
            <ThresholdSelect
              label="百度权重"
              value={filters.pcWeight}
              options={facetsQuery.data?.pcWeightThresholds}
              onChange={(value) => updateFilter("pcWeight", value)}
            />
            <ThresholdSelect
              label="收录率"
              value={filters.includeRate}
              options={facetsQuery.data?.includeRateThresholds}
              onChange={(value) => updateFilter("includeRate", value)}
            />
            <ThresholdSelect
              label="通过率"
              value={filters.successRate}
              options={facetsQuery.data?.successRateThresholds}
              onChange={(value) => updateFilter("successRate", value)}
            />
            <label>
              <span>内容能力</span>
              <select
                value={filters.capability}
                onChange={(event) =>
                  updateFilter(
                    "capability",
                    event.target.value as MediaFilters["capability"],
                  )
                }
              >
                <option value="">不限</option>
                {capabilityFacetOptions(facetsQuery.data?.imageSupports).map(
                  (option) => (
                    <option key={option.value} value={option.value}>
                      {option.label} ({option.count})
                    </option>
                  ),
                )}
              </select>
            </label>
            <label className="publishing-check-filter">
              <input
                type="checkbox"
                checked={filters.authenticated === "true"}
                disabled={
                  authenticatedCount === 0 && filters.authenticated !== "true"
                }
                onChange={(event) =>
                  updateFilter(
                    "authenticated",
                    event.target.checked ? "true" : "",
                  )
                }
              />
              <span>
                已认证
                {authenticatedCount === undefined
                  ? ""
                  : ` (${authenticatedCount})`}
              </span>
            </label>
            <label className="publishing-check-filter">
              <input
                type="checkbox"
                checked={filters.festival === "true"}
                disabled={festivalCount === 0 && filters.festival !== "true"}
                onChange={(event) =>
                  updateFilter("festival", event.target.checked ? "true" : "")
                }
              />
              <span>
                节假日可发
                {festivalCount === undefined ? "" : ` (${festivalCount})`}
              </span>
            </label>
            <button
              className="publishing-filter-reset"
              type="button"
              onClick={() =>
                navigateFilters({
                  ...DEFAULT_MEDIA_FILTERS,
                  kind: filters.kind,
                })
              }
            >
              重置全部筛选
            </button>
          </div>
        ) : null}
      </section>

      {catalogRevisionChange ? (
        <div
          className="publishing-catalog-update"
          role="status"
          aria-live="polite"
        >
          <RefreshCw size={19} />
          <div>
            <strong>媒体目录已更新</strong>
            <p>
              已有新的媒体信息与报价。刷新后会回到第 1 页，
              并保留当前筛选与草稿中的已选媒体。
            </p>
          </div>
          <button
            className="publishing-button publishing-button-secondary"
            type="button"
            onClick={refreshChangedCatalog}
          >
            刷新目录并回到第一页
          </button>
        </div>
      ) : null}

      {selectionError ? (
        <p className="publishing-form-error" role="alert">
          {selectionError}
        </p>
      ) : null}
      {mediaQuery.loading ? (
        <PublishingLoading
          label={`正在加载${filters.kind === "self_media" ? "自媒体" : "软文媒体"}…`}
        />
      ) : null}
      {mediaQuery.refreshing ? (
        <p className="publishing-media-refresh" role="status">
          <LoaderCircle size={14} className="publishing-spin" />
          正在更新{filters.kind === "self_media" ? "自媒体" : "软文媒体"}…
        </p>
      ) : null}
      {mediaQuery.error ? (
        <PublishingError error={mediaQuery.error} onRetry={mediaQuery.reload} />
      ) : null}
      {mediaQuery.data && !mediaQuery.data.items.length ? (
        <PublishingEmpty
          title="没有匹配的媒体"
          description="调整搜索词或筛选条件后再试。"
          action={
            <button
              className="publishing-button publishing-button-secondary"
              type="button"
              onClick={() =>
                navigateFilters({
                  ...DEFAULT_MEDIA_FILTERS,
                  kind: filters.kind,
                })
              }
            >
              清空筛选
            </button>
          }
        />
      ) : null}
      {mediaQuery.data?.items.length ? (
        <>
          <section
            className="publishing-panel publishing-media-table publishing-media-table-detailed"
            aria-label="媒体目录"
          >
            <div className="publishing-media-head publishing-media-row">
              <span
                className="publishing-media-col-choice"
                aria-hidden="true"
              />
              <span className="publishing-media-col-resource">
                {filters.kind === "self_media" ? "账号 / 平台" : "媒体 / 频道"}
              </span>
              <span className="publishing-media-col-category">
                {filters.kind === "self_media" ? "类别 / 认证" : "类别 / 地区"}
              </span>
              <span className="publishing-media-col-price">发布报价</span>
              <span className="publishing-media-col-indexing">
                {filters.kind === "self_media" ? "账号影响力" : "收录与权重"}
              </span>
              <span className="publishing-media-col-delivery">
                通过率 / 时效
              </span>
              <span className="publishing-media-col-capability">能力</span>
              <span className="publishing-media-col-compact-details">详情</span>
            </div>
            {mediaQuery.data.items.map((media) => {
              const checked = selected.has(media.id);
              const blocker = mediaSelectionBlocker(media, articleHasImages);
              const selectionLimitReached = !checked && selected.size >= 20;
              const disabled =
                (!checked && Boolean(blocker)) ||
                selectionLimitReached ||
                selectionBusy ||
                Boolean(draftId && !draft);
              return (
                <div className="publishing-media-entry" key={media.id}>
                  <label
                    className={`publishing-media-row ${checked ? "is-selected" : ""} ${blocker || selectionLimitReached ? "is-disabled" : ""}`}
                    title={
                      selectionLimitReached
                        ? "已达到一次最多 20 家媒体的选择上限"
                        : undefined
                    }
                  >
                    <input
                      className="publishing-media-col-choice"
                      type="checkbox"
                      checked={checked}
                      disabled={disabled}
                      onChange={() => toggle(media)}
                      aria-label={`选择 ${media.name}`}
                    />
                    <span className="publishing-media-name publishing-media-col-resource">
                      <MediaMark
                        name={media.shortName}
                        id={media.id}
                        logoUrl={media.logoUrl}
                        logoSource={media.logoSource}
                        logoResolutionStatus={media.logoResolutionStatus}
                      />
                      <span>
                        <strong>
                          {media.name}
                          {media.recommended ? (
                            <b className="publishing-recommended">荐</b>
                          ) : null}
                        </strong>
                        <small>
                          {media.platform} · ID{" "}
                          {media.externalResourceId ?? media.id}
                          {media.caseUrl ? (
                            <a
                              href={media.caseUrl}
                              target="_blank"
                              rel="noreferrer"
                              onClick={(event) => event.stopPropagation()}
                            >
                              案例 <ExternalLink size={11} />
                            </a>
                          ) : null}
                        </small>
                        {Boolean(
                          media.recommendationTags?.length ||
                            media.platformRecommendationTags?.length,
                        ) ? (
                          <span className="publishing-media-tags">
                            {media.recommendationTags
                              ?.slice(0, 3)
                              .map((tag, index) => (
                                <span
                                  key={`media-${index}`}
                                  title={
                                    media.recommendationRemark || "媒体推荐标签"
                                  }
                                >
                                  {tag}
                                </span>
                              ))}
                            {media.platformRecommendationTags
                              ?.slice(0, 2)
                              .map((tag, index) => (
                                <span
                                  key={`platform-${index}`}
                                  className="is-platform"
                                  title="行业推荐标签"
                                >
                                  {tag}
                                </span>
                              ))}
                          </span>
                        ) : null}
                      </span>
                    </span>
                    <span
                      className="publishing-media-col-category"
                      data-label={
                        media.kind === "self_media"
                          ? "类别 / 认证"
                          : "类别 / 地区"
                      }
                    >
                      <strong>
                        {media.mediaType ||
                          media.taxonomy ||
                          kindLabel(media.kind)}
                      </strong>
                      {media.kind === "self_media" ? (
                        <small title={media.authenticationDescription}>
                          {media.authenticated === true
                            ? media.authenticationType || "已认证"
                            : media.authenticated === false
                              ? "未认证"
                              : "认证信息未提供"}
                        </small>
                      ) : (
                        <small>
                          {media.taxonomy || "—"} · {media.region || "—"}
                        </small>
                      )}
                    </span>
                    <strong
                      className="publishing-market-price publishing-media-col-price"
                      data-label="发布报价"
                    >
                      {formatPublishingMoney(media.priceTenThousandths)}
                      <small>元 / 篇</small>
                    </strong>
                    <span
                      className="publishing-media-col-indexing"
                      data-label={
                        media.kind === "self_media"
                          ? "账号影响力"
                          : "收录与权重"
                      }
                    >
                      {media.kind === "self_media" ? (
                        <>
                          <strong>粉丝 {compactNumber(media.followers)}</strong>
                          <small>点赞 {compactNumber(media.likes)}</small>
                        </>
                      ) : (
                        <>
                          <strong>
                            {media.includeType || "收录信息未提供"}
                          </strong>
                          <small>
                            收录率 {percentage(media.includeRate)} · 权重{" "}
                            {media.pcWeight ?? "—"}
                          </small>
                        </>
                      )}
                    </span>
                    <span
                      className="publishing-media-col-delivery"
                      data-label="通过率 / 时效"
                    >
                      <strong>{percentage(media.successRate)}</strong>
                      <small>{media.turnaround || "—"}</small>
                    </span>
                    <span
                      className="publishing-media-col-capability"
                      data-label="能力"
                    >
                      <span
                        className={`publishing-capability is-${media.capability}`}
                      >
                        {capabilityLabel(media.capability)}
                      </span>
                      <small>标题 ≤ {media.titleLimit} 字</small>
                    </span>
                    {media.remark ? (
                      <p className="publishing-media-remark">
                        备注：{media.remark}
                      </p>
                    ) : null}
                    {blocker ? (
                      <p className="publishing-media-remark is-danger">
                        {blocker}
                      </p>
                    ) : null}
                  </label>
                  <details className="publishing-media-compact-details">
                    <summary aria-label={`查看 ${media.name} 的详细指标`}>
                      详情 <ChevronDown size={14} />
                    </summary>
                    <dl>
                      {media.kind === "self_media" ? (
                        <>
                          <div>
                            <dt>粉丝</dt>
                            <dd>{compactNumber(media.followers)}</dd>
                          </div>
                          <div>
                            <dt>点赞</dt>
                            <dd>{compactNumber(media.likes)}</dd>
                          </div>
                          <div>
                            <dt>认证信息</dt>
                            <dd>
                              {media.authenticated === true
                                ? media.authenticationDescription ||
                                  media.authenticationType ||
                                  "已认证"
                                : media.authenticated === false
                                  ? "未认证"
                                  : "未提供"}
                            </dd>
                          </div>
                        </>
                      ) : null}
                      <div>
                        <dt>收录类型</dt>
                        <dd>{media.includeType || "—"}</dd>
                      </div>
                      <div>
                        <dt>收录率</dt>
                        <dd>{percentage(media.includeRate)}</dd>
                      </div>
                      <div>
                        <dt>百度权重</dt>
                        <dd>{media.pcWeight ?? "—"}</dd>
                      </div>
                      <div>
                        <dt>通过率</dt>
                        <dd>{percentage(media.successRate)}</dd>
                      </div>
                      <div>
                        <dt>发布时效</dt>
                        <dd>{media.turnaround || "—"}</dd>
                      </div>
                      <div>
                        <dt>入口 / 链接</dt>
                        <dd>
                          {media.entryType || "—"} · {media.linkType || "—"}
                        </dd>
                      </div>
                    </dl>
                  </details>
                </div>
              );
            })}
          </section>
          <footer className="publishing-media-footer">
            <span>
              当前类型共{" "}
              <strong>
                {(currentKindCount ?? mediaQuery.data.total).toLocaleString(
                  "zh-CN",
                )}
              </strong>{" "}
              家 · 筛选后 {mediaQuery.data.total.toLocaleString("zh-CN")} 家
            </span>
            <label>
              每页{" "}
              <select
                value={filters.pageSize}
                onChange={(event) =>
                  updateFilter("pageSize", Number(event.target.value))
                }
              >
                <option value={10}>10</option>
                <option value={20}>20</option>
                <option value={50}>50</option>
                <option value={100}>100</option>
              </select>
            </label>
            <PublishingPagination
              page={filters.page}
              pageCount={pageCount}
              onChange={(page) => updateFilter("page", page)}
            />
          </footer>
        </>
      ) : null}

      {flow && boundDraft ? (
        <section className="publishing-flow-result" aria-label="投放选择已保存">
          <Check size={20} />
          <div>
            <strong>稿件与媒体已准备好</strong>
            <p>
              {boundDraft.articleTitle} · v{boundDraft.articleVersion}，
              {boundDraft.items.length} 家媒体。继续配置标题并确认发布。
            </p>
            <button
              type="button"
              className="publishing-button publishing-button-primary"
              disabled={selectionBusy}
              onClick={() => void handoff()}
            >
              交给发布助手
            </button>
            {selectionError && <p role="alert">{selectionError}</p>}
          </div>
        </section>
      ) : null}
      {selected.size && !boundDraft ? (
        <aside className="publishing-selection-bar" aria-label="已选媒体">
          <button
            className="publishing-selection-summary"
            type="button"
            onClick={() => setDrawerOpen(true)}
          >
            <span className="publishing-selection-check">
              <Check size={17} />
            </span>
            <strong>已选 {selected.size} 家媒体</strong>
            <span>
              软文 {selectedCounts.news} · 自媒体 {selectedCounts.self_media}
            </span>
            <span>
              预计总价 <b>{formatPublishingMoney(selectedTotal)}</b>
            </span>
            <ShoppingBag size={17} />
          </button>
          <button
            className="publishing-button publishing-button-dark"
            type="button"
            onClick={clearSelection}
            disabled={selectionBusy || Boolean(draftId && !draft)}
            aria-label="清空已选媒体"
          >
            <Trash2 size={17} />
            清空
          </button>
          <button
            className="publishing-button publishing-button-accent"
            type="button"
            disabled={selectionBusy || Boolean(draftId && !draft)}
            onClick={continueSelection}
          >
            {selectionBusy ? (
              <LoaderCircle className="publishing-spin" size={17} />
            ) : null}
            {draft ? "下一步：配置标题" : "选择稿件并继续"}
          </button>
        </aside>
      ) : null}

      {drawerOpen ? (
        <div
          className="publishing-drawer-backdrop"
          role="presentation"
          onMouseDown={() => setDrawerOpen(false)}
        >
          <aside
            className="publishing-selection-drawer"
            role="dialog"
            aria-modal="true"
            aria-label="已选媒体明细"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <span>{draft ? "投放草稿" : "待选清单"}</span>
                <h2>
                  已选媒体 <b>{selected.size}</b>
                </h2>
              </div>
              <button
                type="button"
                aria-label="关闭已选媒体"
                onClick={() => setDrawerOpen(false)}
              >
                <X size={20} />
              </button>
            </header>
            <div className="publishing-drawer-summary">
              <span>
                软文媒体 <b>{selectedCounts.news}</b>
              </span>
              <span>
                自媒体 <b>{selectedCounts.self_media}</b>
              </span>
              <span>
                预计总价 <b>{formatPublishingMoney(selectedTotal)}</b>
              </span>
            </div>
            <div className="publishing-drawer-list">
              {selectedValues.map((media) => (
                <article key={media.id}>
                  <MediaMark
                    name={media.shortName}
                    id={media.id}
                    logoUrl={media.logoUrl}
                    logoSource={media.logoSource}
                    logoResolutionStatus={media.logoResolutionStatus}
                  />
                  <span>
                    <strong>{media.name}</strong>
                    <small>
                      {kindLabel(media.kind)} · {media.platform}
                    </small>
                  </span>
                  <b>{formatPublishingMoney(media.priceTenThousandths)}</b>
                  <button
                    type="button"
                    aria-label={`移除 ${media.name}`}
                    disabled={selectionBusy || Boolean(draftId && !draft)}
                    onClick={() => toggle(media)}
                  >
                    <X size={16} />
                  </button>
                </article>
              ))}
            </div>
            <footer>
              <button
                className="publishing-button publishing-button-secondary"
                type="button"
                onClick={clearSelection}
                disabled={selectionBusy || Boolean(draftId && !draft)}
              >
                清空全部
              </button>
              <button
                type="button"
                className="publishing-button publishing-button-accent"
                disabled={selectionBusy || !selected.size}
                onClick={continueSelection}
              >
                {draft ? "配置标题" : "选择稿件并继续"}
              </button>
            </footer>
          </aside>
        </div>
      ) : null}
      <PublishingConfirmDialog
        inline={Boolean(flow)}
        open={articleChooserOpen}
        title={draft ? "更换发布稿件" : "选择发布稿件"}
        description={
          draft
            ? "已选媒体将复制到新的投放草稿，标题重新配置，原草稿保留。"
            : "选择已确认的稿件版本，系统将重新核对媒体报价与内容要求。"
        }
        confirmLabel={
          selected.size
            ? flow
              ? "确认稿件与媒体"
              : "绑定稿件并配置标题"
            : "使用这篇稿件"
        }
        busy={selectionBusy}
        confirmDisabled={!chosenVersion}
        onCancel={() => setArticleChooserOpen(false)}
        onConfirm={() => void bindArticle()}
      >
        {articlesQuery.loading ? (
          <PublishingLoading label="正在加载稿件…" />
        ) : null}
        {articlesQuery.error ? (
          <PublishingError
            error={articlesQuery.error}
            onRetry={articlesQuery.reload}
          />
        ) : null}
        <label className="publishing-article-choice">
          <span>稿件及版本</span>
          <select
            aria-label="选择冻结稿件"
            value={chosenVersion}
            onChange={(event) => setChosenVersion(event.target.value)}
            disabled={selectionBusy || Boolean(draftId && !draft)}
          >
            <option value="">请选择稿件</option>
            {frozenArticles.map((article) => (
              <option
                key={article.currentVersionId}
                value={article.currentVersionId}
              >
                {article.title} · v{article.currentVersion}
              </option>
            ))}
          </select>
        </label>
        {!articlesQuery.loading && !frozenArticles.length ? (
          <p>
            暂时没有已确认版本的稿件。
            <Link href="/publishing/articles">前往稿件管理</Link>
          </p>
        ) : null}
        {selectionError ? (
          <p className="publishing-inline-error" role="alert">
            {selectionError}
          </p>
        ) : null}
      </PublishingConfirmDialog>
    </PublishingPage>
  );
}

function FilterLine({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="publishing-filter-line">
      <strong>{label}</strong>
      {children}
    </div>
  );
}

function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value?: string;
  options?: Array<{ value: string; label: string; count: number }>;
  onChange: (value: string) => void;
}) {
  return (
    <label className="publishing-inline-select">
      <span className="publishing-visually-hidden">{label}</span>
      <select
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">{label}</option>
        {options?.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label} ({option.count})
          </option>
        ))}
      </select>
    </label>
  );
}

function ThresholdSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value?: string;
  options?: Array<{ value: string; label: string; count: number }>;
  onChange: (value: string) => void;
}) {
  return (
    <label>
      <span>{label}</span>
      <select
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">不限</option>
        {options
          ?.filter((option) => option.count > 0)
          .map((option) => (
            <option key={option.value} value={option.value}>
              {option.label} ({option.count})
            </option>
          ))}
      </select>
    </label>
  );
}

function facetCount(
  options: Array<{ value: string; count: number }> | undefined,
  value: string,
) {
  if (!options) return undefined;
  return options.find((option) => option.value === value)?.count ?? 0;
}

function capabilityFacetOptions(
  options: Array<{ value: string; label: string; count: number }> | undefined,
) {
  return (options ?? [])
    .filter((option) => option.count > 0)
    .map((option) => ({
      ...option,
      value:
        option.value === "verified"
          ? "image"
          : option.value === "unsupported"
            ? "text"
            : "image_pending",
    }));
}
