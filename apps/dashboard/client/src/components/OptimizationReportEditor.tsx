import {
  BarChart3,
  FileImage,
  FileText,
  Loader2,
  Plus,
  Trash2,
  UploadCloud,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { PortalCard } from "@/components/PortalShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { DashboardPayload } from "@shared/dashboard";

type OptimizationReport = NonNullable<DashboardPayload["optimizationReport"]>;
type QuestionReport = NonNullable<
  OptimizationReport["questionReports"]
>[number];
type AnswerSample = QuestionReport["before"];
type AnswerScreenshot = AnswerSample["screenshots"][number];
type AfterEffect = NonNullable<QuestionReport["afterEffect"]>;
type AfterEffectDimension = AfterEffect["dimensions"][number];
type AfterEffectPlatform = AfterEffect["platforms"][number];
type GapClosure = AfterEffect["gapClosures"][number];

interface OptimizationReportEditorProps {
  userId: number;
  report: DashboardPayload["optimizationReport"];
  questions: DashboardPayload["questions"];
  disabled: boolean;
  onChange: (report: DashboardPayload["optimizationReport"]) => void;
}

function newId(prefix: string) {
  const suffix =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${suffix}`;
}

function emptyOptimizationReport(): OptimizationReport {
  return {
    period: "",
    title: "",
    subtitle: "",
    executiveSummary: [],
    kpis: [],
    platforms: [],
    journeys: [],
    competitorTiers: [],
    sourceMix: [],
    risks: [],
    roadmap: [],
    reportRecords: [],
    questionBaselines: [],
    questionReports: [],
  };
}

function emptyAnswerSample(): AnswerSample {
  return {
    platform: "",
    capturedAt: "",
    content: "",
    screenshots: [],
  };
}

function emptyAfterEffect(): AfterEffect {
  return {
    released: false,
    totalScore: null,
    grade: "",
    summary: "",
    dimensions: [],
    platforms: [],
    gapFillSummary: "",
    gapClosures: [],
  };
}

function questionReportFromQuestion(
  question: DashboardPayload["questions"][number],
): QuestionReport {
  return {
    id: question.id,
    category: question.groupTitle || question.groupId,
    question: question.question,
    summary: "",
    metrics: [],
    before: emptyAnswerSample(),
    expectedLogic: "",
    gaps: [],
    after: emptyAnswerSample(),
    improvements: [],
    analysis: "",
    evidence: [],
    afterEffect: emptyAfterEffect(),
  };
}

function fieldClass() {
  return "h-11 w-full rounded-xl border border-[#dcd2e3] bg-white px-3 text-sm text-[#221a33] outline-none focus:border-[#7c4b9c] focus:ring-2 focus:ring-[#7c4b9c]/15 disabled:cursor-not-allowed disabled:opacity-60";
}

function EditorLabel({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-2">
      <span className="text-xs font-semibold text-[#716a80]">{label}</span>
      {children}
    </label>
  );
}

function StringListEditor({
  title,
  itemLabel,
  values,
  disabled,
  onChange,
}: {
  title: string;
  itemLabel: string;
  values: readonly string[];
  disabled: boolean;
  onChange: (values: string[]) => void;
}) {
  return (
    <section className="rounded-xl border border-[#e8e1ee] bg-[#fbf9fd] p-4">
      <div className="flex items-center justify-between gap-3">
        <strong className="text-sm text-[#332842]">{title}</strong>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled || values.length >= 100}
          onClick={() => onChange([...values, ""])}
        >
          <Plus className="h-3.5 w-3.5" />
          添加
        </Button>
      </div>
      {values.length === 0 ? (
        <p className="mt-3 text-xs text-[#91899b]">尚未填写。</p>
      ) : (
        <div className="mt-3 space-y-2">
          {values.map((value, index) => (
            <div
              key={index}
              className="grid grid-cols-[minmax(0,1fr)_auto] gap-2"
            >
              <Textarea
                aria-label={`${itemLabel} ${index + 1}`}
                value={value}
                rows={2}
                maxLength={8_000}
                disabled={disabled}
                onChange={(event) =>
                  onChange(
                    values.map((item, itemIndex) =>
                      itemIndex === index ? event.target.value : item,
                    ),
                  )
                }
              />
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label={`删除${itemLabel} ${index + 1}`}
                disabled={disabled}
                onClick={() =>
                  onChange(values.filter((_, itemIndex) => itemIndex !== index))
                }
              >
                <Trash2 className="h-4 w-4 text-[#a33b58]" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

async function uploadReportScreenshot(userId: number, file: File) {
  const response = await fetch(`/api/dashboard/report-assets/${userId}`, {
    method: "PUT",
    credentials: "include",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-File-Name": encodeURIComponent(file.name),
      "X-File-Content-Type": file.type || "application/octet-stream",
    },
    body: file,
  });
  if (!response.ok) {
    const message = await response
      .json()
      .then((value) => value?.error?.message || "答案截图上传失败")
      .catch(() => "答案截图上传失败");
    throw new Error(message);
  }
  return (await response.json()) as {
    id: string;
    url: string;
    filename: string;
  };
}

function ScreenshotEditor({
  userId,
  phase,
  screenshots,
  disabled,
  onChange,
}: {
  userId: number;
  phase: "before" | "after";
  screenshots: readonly AnswerScreenshot[];
  disabled: boolean;
  onChange: (screenshots: AnswerScreenshot[]) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const phaseLabel = phase === "before" ? "优化前" : "优化后";

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    const selected = Array.from(files);
    const invalid = selected.find(
      (file) =>
        !["image/png", "image/jpeg", "image/webp"].includes(file.type) ||
        file.size > 12 * 1024 * 1024,
    );
    if (invalid) {
      toast.error("答案截图不可用", {
        description: "仅支持 12MB 以内的 PNG、JPG 或 WEBP 图片。",
      });
      return;
    }
    setUploading(true);
    try {
      const uploaded = [];
      for (const file of selected) {
        const result = await uploadReportScreenshot(userId, file);
        uploaded.push({
          id: result.id,
          url: result.url,
          alt: `${phaseLabel}答案截图`,
        });
      }
      onChange([...screenshots, ...uploaded]);
      toast.success(`${phaseLabel}答案截图已上传`, {
        description: `已加入 ${uploaded.length} 张图片，点击“发布修改”后用户可见。`,
      });
    } catch (error) {
      toast.error("答案截图上传失败", {
        description: error instanceof Error ? error.message : "请稍后重试",
      });
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    <section className="rounded-xl border border-[#e8e1ee] bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <strong className="text-sm text-[#332842]">
            {phaseLabel}答案截图
          </strong>
          <p className="mt-1 text-xs text-[#91899b]">
            可上传多张真实回答截图，发布后由用户点击查看。
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled || uploading || screenshots.length >= 20}
            onClick={() => inputRef.current?.click()}
          >
            {uploading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <UploadCloud className="h-3.5 w-3.5" />
            )}
            上传图片
          </Button>
          <input
            ref={inputRef}
            hidden
            multiple
            type="file"
            accept="image/png,image/jpeg,image/webp"
            aria-label={`上传${phaseLabel}答案截图`}
            onChange={(event) => void upload(event.target.files)}
          />
        </div>
      </div>

      {screenshots.length > 0 && (
        <div className="mt-4 space-y-3">
          {screenshots.map((screenshot, index) => (
            <div
              key={screenshot.id || index}
              className="grid gap-2 rounded-xl border border-[#eee8f2] bg-[#fbf9fd] p-3 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto]"
            >
              <Input
                aria-label={`${phaseLabel}截图 ${index + 1} 地址`}
                value={screenshot.url}
                maxLength={4_000}
                disabled
                readOnly
              />
              <Input
                aria-label={`${phaseLabel}截图 ${index + 1} 替代文本`}
                value={screenshot.alt}
                maxLength={500}
                disabled={disabled}
                placeholder="图片说明"
                onChange={(event) =>
                  onChange(
                    screenshots.map((item, itemIndex) =>
                      itemIndex === index
                        ? { ...item, alt: event.target.value }
                        : item,
                    ),
                  )
                }
              />
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label={`删除${phaseLabel}截图 ${index + 1}`}
                disabled={disabled}
                onClick={() =>
                  onChange(
                    screenshots.filter((_, itemIndex) => itemIndex !== index),
                  )
                }
              >
                <Trash2 className="h-4 w-4 text-[#a33b58]" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function AnswerEditor({
  userId,
  phase,
  sample,
  disabled,
  onChange,
}: {
  userId: number;
  phase: "before" | "after";
  sample: AnswerSample;
  disabled: boolean;
  onChange: (sample: AnswerSample) => void;
}) {
  const phaseLabel = phase === "before" ? "优化前" : "优化后";
  return (
    <section className="space-y-4 rounded-2xl border border-[#e5ddea] bg-[#fbf9fd] p-4 sm:p-5">
      <div className="flex items-center gap-2">
        <FileText className="h-4 w-4 text-[#5b2a86]" />
        <h4 className="font-semibold text-[#332842]">{phaseLabel}真实答案</h4>
      </div>
      <EditorLabel label={`${phaseLabel}答案正文`}>
        <Textarea
          aria-label={`${phaseLabel}答案正文`}
          value={sample.content}
          rows={10}
          maxLength={100_000}
          disabled={disabled}
          placeholder="粘贴管理员核验过的真实模型回答，支持 Markdown"
          onChange={(event) =>
            onChange({ ...sample, content: event.target.value })
          }
        />
      </EditorLabel>
      <ScreenshotEditor
        userId={userId}
        phase={phase}
        screenshots={sample.screenshots}
        disabled={disabled}
        onChange={(screenshots) => onChange({ ...sample, screenshots })}
      />
    </section>
  );
}

function EffectDimensionEditor({
  dimensions,
  disabled,
  onChange,
}: {
  dimensions: readonly AfterEffectDimension[];
  disabled: boolean;
  onChange: (dimensions: AfterEffectDimension[]) => void;
}) {
  return (
    <section className="rounded-xl border border-[#e8e1ee] bg-[#fbf9fd] p-4">
      <div className="flex items-center justify-between gap-3">
        <strong className="text-sm text-[#332842]">语义资产维度评分</strong>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled || dimensions.length >= 20}
          onClick={() =>
            onChange([
              ...dimensions,
              {
                id: newId("effect-dimension"),
                label: "",
                score: 0,
                maxScore: 100,
                summary: "",
              },
            ])
          }
        >
          <Plus className="h-3.5 w-3.5" />
          添加维度
        </Button>
      </div>
      <div className="mt-3 space-y-3">
        {dimensions.map((dimension, index) => (
          <div
            key={dimension.id}
            className="rounded-xl border border-[#e8e1ee] bg-white p-3"
          >
            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_110px_110px_auto]">
              <Input
                aria-label={`效果维度 ${index + 1} 名称`}
                value={dimension.label}
                maxLength={255}
                disabled={disabled}
                placeholder="维度名称"
                onChange={(event) =>
                  onChange(
                    dimensions.map((item, itemIndex) =>
                      itemIndex === index
                        ? { ...item, label: event.target.value }
                        : item,
                    ),
                  )
                }
              />
              <Input
                aria-label={`效果维度 ${index + 1} 得分`}
                type="number"
                min={0}
                max={100}
                value={dimension.score}
                disabled={disabled}
                onChange={(event) =>
                  onChange(
                    dimensions.map((item, itemIndex) =>
                      itemIndex === index
                        ? { ...item, score: Number(event.target.value) }
                        : item,
                    ),
                  )
                }
              />
              <Input
                aria-label={`效果维度 ${index + 1} 满分`}
                type="number"
                min={1}
                max={100}
                value={dimension.maxScore}
                disabled={disabled}
                onChange={(event) =>
                  onChange(
                    dimensions.map((item, itemIndex) =>
                      itemIndex === index
                        ? { ...item, maxScore: Number(event.target.value) }
                        : item,
                    ),
                  )
                }
              />
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label={`删除效果维度 ${index + 1}`}
                disabled={disabled}
                onClick={() =>
                  onChange(
                    dimensions.filter((_, itemIndex) => itemIndex !== index),
                  )
                }
              >
                <Trash2 className="h-4 w-4 text-[#a33b58]" />
              </Button>
            </div>
            <Textarea
              aria-label={`效果维度 ${index + 1} 总结`}
              className="mt-2"
              value={dimension.summary}
              rows={2}
              maxLength={4_000}
              disabled={disabled}
              placeholder="该维度的真实复测结论"
              onChange={(event) =>
                onChange(
                  dimensions.map((item, itemIndex) =>
                    itemIndex === index
                      ? { ...item, summary: event.target.value }
                      : item,
                  ),
                )
              }
            />
          </div>
        ))}
      </div>
    </section>
  );
}

function EffectPlatformEditor({
  platforms,
  disabled,
  onChange,
}: {
  platforms: readonly AfterEffectPlatform[];
  disabled: boolean;
  onChange: (platforms: AfterEffectPlatform[]) => void;
}) {
  const patch = (index: number, value: Partial<AfterEffectPlatform>) =>
    onChange(
      platforms.map((item, itemIndex) =>
        itemIndex === index ? { ...item, ...value } : item,
      ),
    );

  return (
    <section className="rounded-xl border border-[#e8e1ee] bg-[#fbf9fd] p-4">
      <div className="flex items-center justify-between gap-3">
        <strong className="text-sm text-[#332842]">平台优化后复测</strong>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled || platforms.length >= 100}
          onClick={() =>
            onChange([
              ...platforms,
              {
                platform: "",
                responseCount: 0,
                mentionRate: null,
                averageRank: null,
                factAccuracy: null,
                propositionHitRate: null,
                citationCount: 0,
                referenceCount: 0,
                verdict: "",
              },
            ])
          }
        >
          <Plus className="h-3.5 w-3.5" />
          添加平台
        </Button>
      </div>
      <div className="mt-3 space-y-3">
        {platforms.map((platform, index) => (
          <div
            key={`${platform.platform}-${index}`}
            className="space-y-3 rounded-xl border border-[#e8e1ee] bg-white p-3"
          >
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              <Input
                aria-label={`平台复测 ${index + 1} 平台`}
                value={platform.platform}
                disabled={disabled}
                placeholder="平台"
                onChange={(event) =>
                  patch(index, { platform: event.target.value })
                }
              />
              <Input
                aria-label={`平台复测 ${index + 1} 有效回答`}
                type="number"
                min={0}
                value={platform.responseCount}
                disabled={disabled}
                placeholder="有效回答"
                onChange={(event) =>
                  patch(index, { responseCount: Number(event.target.value) })
                }
              />
              <Input
                aria-label={`平台复测 ${index + 1} 品牌提及`}
                value={platform.mentionRate ?? ""}
                disabled={disabled}
                placeholder="品牌提及，例如 80%"
                onChange={(event) =>
                  patch(index, { mentionRate: event.target.value || null })
                }
              />
              <Input
                aria-label={`平台复测 ${index + 1} 平均位次`}
                value={platform.averageRank ?? ""}
                disabled={disabled}
                placeholder="平均位次"
                onChange={(event) =>
                  patch(index, { averageRank: event.target.value || null })
                }
              />
              <Input
                aria-label={`平台复测 ${index + 1} 事实准确`}
                value={platform.factAccuracy ?? ""}
                disabled={disabled}
                placeholder="事实准确，例如 92%"
                onChange={(event) =>
                  patch(index, { factAccuracy: event.target.value || null })
                }
              />
              <Input
                aria-label={`平台复测 ${index + 1} 主张命中`}
                value={platform.propositionHitRate ?? ""}
                disabled={disabled}
                placeholder="主张命中，例如 75%"
                onChange={(event) =>
                  patch(index, {
                    propositionHitRate: event.target.value || null,
                  })
                }
              />
              <Input
                aria-label={`平台复测 ${index + 1} 答案引用`}
                type="number"
                min={0}
                value={platform.citationCount}
                disabled={disabled}
                placeholder="答案引用"
                onChange={(event) =>
                  patch(index, { citationCount: Number(event.target.value) })
                }
              />
              <Input
                aria-label={`平台复测 ${index + 1} 信源记录`}
                type="number"
                min={0}
                value={platform.referenceCount}
                disabled={disabled}
                placeholder="信源记录"
                onChange={(event) =>
                  patch(index, { referenceCount: Number(event.target.value) })
                }
              />
            </div>
            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
              <Textarea
                aria-label={`平台复测 ${index + 1} 判断`}
                value={platform.verdict}
                rows={2}
                maxLength={8_000}
                disabled={disabled}
                placeholder="该平台的优化后真实判断"
                onChange={(event) =>
                  patch(index, { verdict: event.target.value })
                }
              />
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label={`删除平台复测 ${index + 1}`}
                disabled={disabled}
                onClick={() =>
                  onChange(
                    platforms.filter((_, itemIndex) => itemIndex !== index),
                  )
                }
              >
                <Trash2 className="h-4 w-4 text-[#a33b58]" />
              </Button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function GapClosureEditor({
  closures,
  disabled,
  onChange,
}: {
  closures: readonly GapClosure[];
  disabled: boolean;
  onChange: (closures: GapClosure[]) => void;
}) {
  const patch = (index: number, value: Partial<GapClosure>) =>
    onChange(
      closures.map((item, itemIndex) =>
        itemIndex === index ? { ...item, ...value } : item,
      ),
    );

  return (
    <section className="rounded-xl border border-[#e8e1ee] bg-[#fbf9fd] p-4">
      <div className="flex items-center justify-between gap-3">
        <strong className="text-sm text-[#332842]">差距填补明细</strong>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled || closures.length >= 500}
          onClick={() =>
            onChange([
              ...closures,
              { topic: "", beforeGap: "", result: "", status: "filled" },
            ])
          }
        >
          <Plus className="h-3.5 w-3.5" />
          添加明细
        </Button>
      </div>
      <div className="mt-3 space-y-3">
        {closures.map((closure, index) => (
          <div
            key={`${closure.topic}-${index}`}
            className="rounded-xl border border-[#e8e1ee] bg-white p-3"
          >
            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_150px_auto]">
              <Input
                aria-label={`差距填补 ${index + 1} 主题`}
                value={closure.topic}
                maxLength={500}
                disabled={disabled}
                placeholder="知识事实或回答差距主题"
                onChange={(event) =>
                  patch(index, { topic: event.target.value })
                }
              />
              <select
                aria-label={`差距填补 ${index + 1} 状态`}
                className={fieldClass()}
                value={closure.status}
                disabled={disabled}
                onChange={(event) =>
                  patch(index, {
                    status: event.target.value as GapClosure["status"],
                  })
                }
              >
                <option value="filled">已填补</option>
                <option value="partial">部分填补</option>
                <option value="open">仍需补强</option>
              </select>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label={`删除差距填补 ${index + 1}`}
                disabled={disabled}
                onClick={() =>
                  onChange(
                    closures.filter((_, itemIndex) => itemIndex !== index),
                  )
                }
              >
                <Trash2 className="h-4 w-4 text-[#a33b58]" />
              </Button>
            </div>
            <div className="mt-2 grid gap-2 md:grid-cols-2">
              <Textarea
                aria-label={`差距填补 ${index + 1} 优化前差距`}
                value={closure.beforeGap}
                rows={3}
                maxLength={8_000}
                disabled={disabled}
                placeholder="优化前差距"
                onChange={(event) =>
                  patch(index, { beforeGap: event.target.value })
                }
              />
              <Textarea
                aria-label={`差距填补 ${index + 1} 本轮结果`}
                value={closure.result}
                rows={3}
                maxLength={8_000}
                disabled={disabled}
                placeholder="本轮填补结果"
                onChange={(event) =>
                  patch(index, { result: event.target.value })
                }
              />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function AfterEffectEditor({
  effect,
  disabled,
  onChange,
}: {
  effect: AfterEffect;
  disabled: boolean;
  onChange: (effect: AfterEffect) => void;
}) {
  return (
    <section className="space-y-4 rounded-2xl border border-[#d8e6df] bg-[#f7fcf9] p-4 sm:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <BarChart3 className="h-4 w-4 text-[#237a57]" />
            <h4 className="font-semibold text-[#244638]">优化后效果</h4>
          </div>
          <p className="mt-1 text-xs leading-5 text-[#61766c]">
            开放前必须填写总评分、至少一个平台复测结果，以及差距填补总结或明细。
          </p>
        </div>
        <label className="inline-flex items-center gap-2 rounded-xl border border-[#bdd8cb] bg-white px-3 py-2 text-sm font-semibold text-[#245b43]">
          <input
            aria-label="向用户开放优化后效果"
            type="checkbox"
            checked={effect.released}
            disabled={disabled}
            onChange={(event) =>
              onChange({ ...effect, released: event.target.checked })
            }
          />
          向用户开放
        </label>
      </div>

      <div className="grid gap-3 sm:grid-cols-[160px_140px_minmax(0,1fr)]">
        <EditorLabel label="语义资产总评分">
          <Input
            aria-label="优化后语义资产总评分"
            type="number"
            min={0}
            max={100}
            value={effect.totalScore ?? ""}
            disabled={disabled}
            placeholder="0-100"
            onChange={(event) =>
              onChange({
                ...effect,
                totalScore:
                  event.target.value === "" ? null : Number(event.target.value),
              })
            }
          />
        </EditorLabel>
        <EditorLabel label="等级">
          <Input
            aria-label="优化后语义资产等级"
            value={effect.grade}
            maxLength={20}
            disabled={disabled}
            placeholder="等级"
            onChange={(event) =>
              onChange({ ...effect, grade: event.target.value })
            }
          />
        </EditorLabel>
        <EditorLabel label="评分总结">
          <Input
            aria-label="优化后语义资产评分总结"
            value={effect.summary}
            maxLength={20_000}
            disabled={disabled}
            placeholder="评分结论"
            onChange={(event) =>
              onChange({ ...effect, summary: event.target.value })
            }
          />
        </EditorLabel>
      </div>

      <EffectDimensionEditor
        dimensions={effect.dimensions}
        disabled={disabled}
        onChange={(dimensions) => onChange({ ...effect, dimensions })}
      />
      <EffectPlatformEditor
        platforms={effect.platforms}
        disabled={disabled}
        onChange={(platforms) => onChange({ ...effect, platforms })}
      />

      <EditorLabel label="知识事实与模型回答差距填补总结">
        <Textarea
          aria-label="差距填补总结"
          value={effect.gapFillSummary}
          rows={4}
          maxLength={20_000}
          disabled={disabled}
          placeholder="总结本轮对知识事实与模型回答差距的填补结果"
          onChange={(event) =>
            onChange({ ...effect, gapFillSummary: event.target.value })
          }
        />
      </EditorLabel>
      <GapClosureEditor
        closures={effect.gapClosures}
        disabled={disabled}
        onChange={(gapClosures) => onChange({ ...effect, gapClosures })}
      />
    </section>
  );
}

function QuestionReportEditor({
  userId,
  report,
  disabled,
  onChange,
}: {
  userId: number;
  report: QuestionReport;
  disabled: boolean;
  onChange: (report: QuestionReport) => void;
}) {
  const effect = report.afterEffect ?? emptyAfterEffect();
  return (
    <div className="space-y-5">
      <section className="grid gap-3 rounded-2xl border border-[#e5ddea] bg-white p-4 sm:grid-cols-2 sm:p-5">
        <EditorLabel label="问题 ID">
          <Input aria-label="报告问题 ID" value={report.id} disabled />
        </EditorLabel>
        <EditorLabel label="问题类别">
          <Input
            aria-label="报告问题类别"
            value={report.category}
            disabled={disabled}
            maxLength={120}
            onChange={(event) =>
              onChange({ ...report, category: event.target.value })
            }
          />
        </EditorLabel>
        <div className="sm:col-span-2">
          <EditorLabel label="正式问题">
            <Textarea
              aria-label="报告正式问题"
              value={report.question}
              rows={2}
              disabled
            />
          </EditorLabel>
        </div>
      </section>

      <div className="grid gap-4 xl:grid-cols-2">
        <AnswerEditor
          userId={userId}
          phase="before"
          sample={report.before}
          disabled={disabled}
          onChange={(before) => onChange({ ...report, before })}
        />
        <AnswerEditor
          userId={userId}
          phase="after"
          sample={report.after}
          disabled={disabled}
          onChange={(after) => onChange({ ...report, after })}
        />
      </div>

      <section className="space-y-4 rounded-2xl border border-[#e5ddea] bg-white p-4 sm:p-5">
        <EditorLabel label="标准应答逻辑">
          <Textarea
            aria-label="标准应答逻辑"
            value={report.expectedLogic}
            rows={6}
            maxLength={20_000}
            disabled={disabled}
            onChange={(event) =>
              onChange({ ...report, expectedLogic: event.target.value })
            }
          />
        </EditorLabel>
        <div className="grid gap-4 lg:grid-cols-2">
          <StringListEditor
            title="与应答逻辑的差距"
            itemLabel="应答差距"
            values={report.gaps}
            disabled={disabled}
            onChange={(gaps) => onChange({ ...report, gaps })}
          />
          <StringListEditor
            title="本轮已填补"
            itemLabel="已填补项"
            values={report.improvements}
            disabled={disabled}
            onChange={(improvements) => onChange({ ...report, improvements })}
          />
        </div>
        <EditorLabel label="改善分析">
          <Textarea
            aria-label="改善分析"
            value={report.analysis}
            rows={5}
            maxLength={20_000}
            disabled={disabled}
            onChange={(event) =>
              onChange({ ...report, analysis: event.target.value })
            }
          />
        </EditorLabel>
      </section>

      <AfterEffectEditor
        effect={effect}
        disabled={disabled}
        onChange={(afterEffect) => onChange({ ...report, afterEffect })}
      />
    </div>
  );
}

export default function OptimizationReportEditor({
  userId,
  report,
  questions,
  disabled,
  onChange,
}: OptimizationReportEditorProps) {
  const questionReports = report?.questionReports ?? [];
  const availableQuestions = useMemo(
    () =>
      questions.filter(
        (question) => !questionReports.some((item) => item.id === question.id),
      ),
    [questionReports, questions],
  );
  const [selectedQuestionId, setSelectedQuestionId] = useState(
    questionReports[0]?.id ?? "",
  );
  const [questionToAdd, setQuestionToAdd] = useState(
    availableQuestions[0]?.id ?? "",
  );

  useEffect(() => {
    if (questionReports.some((item) => item.id === selectedQuestionId)) return;
    setSelectedQuestionId(questionReports[0]?.id ?? "");
  }, [questionReports, selectedQuestionId]);

  useEffect(() => {
    if (availableQuestions.some((item) => item.id === questionToAdd)) return;
    setQuestionToAdd(availableQuestions[0]?.id ?? "");
  }, [availableQuestions, questionToAdd]);

  if (!report) {
    return (
      <PortalCard className="p-5 sm:p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <FileText className="h-5 w-5 text-[#5b2a86]" />
              <h3 className="font-semibold text-[#171321]">进度报告内容维护</h3>
            </div>
            <p className="mt-2 text-sm leading-6 text-[#716a80]">
              当前尚未创建进度报告。创建后可按正式问题维护真实答案、截图、分析和优化后效果。
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            disabled={disabled}
            onClick={() => onChange(emptyOptimizationReport())}
          >
            <Plus className="h-4 w-4" />
            创建报告结构
          </Button>
        </div>
      </PortalCard>
    );
  }

  const selectedReport =
    questionReports.find((item) => item.id === selectedQuestionId) ??
    questionReports[0];

  const patchQuestionReport = (next: QuestionReport) => {
    onChange({
      ...report,
      questionReports: questionReports.map((item) =>
        item.id === next.id ? next : item,
      ),
    });
  };

  const addQuestion = () => {
    const question = questions.find((item) => item.id === questionToAdd);
    if (!question) return;
    const next = questionReportFromQuestion(question);
    onChange({
      ...report,
      questionReports: [...questionReports, next],
    });
    setSelectedQuestionId(next.id);
  };

  return (
    <PortalCard className="overflow-hidden">
      <div className="border-b border-[#e8e1ee] bg-[linear-gradient(135deg,#fbf8fd,#f5eff8)] p-5 sm:p-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <FileText className="h-5 w-5 text-[#5b2a86]" />
              <h3 className="font-semibold text-[#171321]">进度报告内容维护</h3>
            </div>
            <p className="mt-2 text-sm leading-6 text-[#716a80]">
              所有内容随看板版本统一预览和发布；用户端不会回退到示例答案或固定分析。
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={disabled}
            onClick={() => onChange(null)}
          >
            <Trash2 className="h-4 w-4 text-[#a33b58]" />
            移除报告
          </Button>
        </div>

        <div className="mt-5 grid gap-3 md:grid-cols-2">
          <EditorLabel label="报告标题">
            <Input
              aria-label="进度报告标题"
              value={report.title}
              maxLength={500}
              disabled={disabled}
              placeholder="填写用户可见的报告标题"
              onChange={(event) =>
                onChange({ ...report, title: event.target.value })
              }
            />
          </EditorLabel>
          <EditorLabel label="报告周期">
            <Input
              aria-label="进度报告周期"
              value={report.period}
              maxLength={500}
              disabled={disabled}
              placeholder="填写实际报告周期"
              onChange={(event) =>
                onChange({ ...report, period: event.target.value })
              }
            />
          </EditorLabel>
        </div>
      </div>

      <div className="space-y-5 p-5 sm:p-6">
        <section className="grid gap-3 rounded-2xl border border-[#e5ddea] bg-[#fbf9fd] p-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
          <EditorLabel label="当前维护的问题">
            <select
              aria-label="当前维护的报告问题"
              className={fieldClass()}
              value={selectedReport?.id ?? ""}
              disabled={disabled || questionReports.length === 0}
              onChange={(event) => setSelectedQuestionId(event.target.value)}
            >
              {questionReports.length === 0 && (
                <option value="">尚未添加问题</option>
              )}
              {questionReports.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.question}
                </option>
              ))}
            </select>
          </EditorLabel>
          <EditorLabel label="从正式问题目录添加">
            <select
              aria-label="添加进度报告问题"
              className={fieldClass()}
              value={questionToAdd}
              disabled={disabled || availableQuestions.length === 0}
              onChange={(event) => setQuestionToAdd(event.target.value)}
            >
              {availableQuestions.length === 0 && (
                <option value="">没有可添加的问题</option>
              )}
              {availableQuestions.map((question) => (
                <option key={question.id} value={question.id}>
                  {question.question}
                </option>
              ))}
            </select>
          </EditorLabel>
          <Button
            type="button"
            className="self-end"
            variant="outline"
            disabled={disabled || !questionToAdd}
            onClick={addQuestion}
          >
            <Plus className="h-4 w-4" />
            添加问题
          </Button>
        </section>

        {selectedReport ? (
          <>
            <div className="flex justify-end">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={disabled}
                onClick={() => {
                  const next = questionReports.filter(
                    (item) => item.id !== selectedReport.id,
                  );
                  onChange({ ...report, questionReports: next });
                }}
              >
                <Trash2 className="h-4 w-4 text-[#a33b58]" />
                移除此问题报告
              </Button>
            </div>
            <QuestionReportEditor
              userId={userId}
              report={selectedReport}
              disabled={disabled}
              onChange={patchQuestionReport}
            />
          </>
        ) : (
          <div className="rounded-2xl border border-dashed border-[#d9cde1] p-8 text-center text-sm text-[#81778a]">
            请从该用户的正式问题目录添加需要维护的报告问题。
          </div>
        )}
      </div>
    </PortalCard>
  );
}
