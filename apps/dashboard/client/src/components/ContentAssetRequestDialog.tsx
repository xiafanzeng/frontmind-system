import {
  CheckCircle2,
  FileImage,
  Loader2,
  LockKeyhole,
  Send,
} from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import type { DeliveryTicketQuota } from "@shared/delivery-ticket";
import type { PreferredContentMedia } from "@shared/delivery-ticket";
import { DOMESTIC_CONTENT_ASSET_MEDIA_OPTIONS } from "@shared/delivery-catalog";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

export type ContentRequestPlanCode =
  | "basic"
  | "knowledge"
  | "advanced"
  | "luxury"
  | "unknown";

export type ContentAssetRequestType = {
  id: string;
  group: string;
  name: string;
  description: string;
};

export type ContentAssetRequestPayload = {
  assetTypeId: string;
  assetTypeName: string;
  assetGroup: string;
  topicDirection: string;
  preferredMedia: ContentAssetPreferredMedia | "";
  contentMaterials: string;
  materialUrls: string[];
  attachmentNotes: string;
  imagePurpose: string;
  copyrightAuthorization:
    | "owned"
    | "licensed"
    | "public"
    | "authorization_pending"
    | "";
  copyrightNote: string;
  attachmentFiles: File[];
};

export const CONTENT_ASSET_PREFERRED_MEDIA =
  DOMESTIC_CONTENT_ASSET_MEDIA_OPTIONS;

export type ContentAssetPreferredMedia = PreferredContentMedia;

export type ContentAssetRequestDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  assetType: ContentAssetRequestType;
  planCode: ContentRequestPlanCode;
  quota?: DeliveryTicketQuota | null;
  submittedCount?: number;
  preferredMediaOptions?: readonly PreferredContentMedia[];
  onSubmit?: (payload: ContentAssetRequestPayload) => void | Promise<void>;
  onSubmitSuccess?: (payload: ContentAssetRequestPayload) => void;
};

function optionalText(value: string) {
  return value.trim();
}

function parseReferenceLinks(value: string) {
  const candidates = Array.from(
    new Set(
      value
        .split(/[\r\n,，]+/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
  const invalid: string[] = [];
  const urls = candidates.filter((candidate) => {
    try {
      const url = new URL(candidate);
      const valid = url.protocol === "http:" || url.protocol === "https:";
      if (!valid) invalid.push(candidate);
      return valid;
    } catch {
      invalid.push(candidate);
      return false;
    }
  });
  return { urls, invalid };
}

export default function ContentAssetRequestDialog({
  open,
  onOpenChange,
  assetType,
  quota = null,
  preferredMediaOptions = CONTENT_ASSET_PREFERRED_MEDIA,
  onSubmit,
  onSubmitSuccess,
}: ContentAssetRequestDialogProps) {
  const [topicDirection, setTopicDirection] = useState("");
  const [preferredMedia, setPreferredMedia] = useState<
    ContentAssetPreferredMedia | ""
  >("");
  const [contentMaterials, setContentMaterials] = useState("");
  const [referenceLinks, setReferenceLinks] = useState("");
  const [attachmentNotes, setAttachmentNotes] = useState("");
  const [imagePurpose, setImagePurpose] = useState("");
  const [copyrightAuthorization, setCopyrightAuthorization] =
    useState<ContentAssetRequestPayload["copyrightAuthorization"]>("");
  const [copyrightNote, setCopyrightNote] = useState("");
  const [attachmentFiles, setAttachmentFiles] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");

  const isPlanLocked = !quota?.allowed;
  const quotaExhausted =
    !isPlanLocked &&
    typeof quota?.remaining === "number" &&
    quota.remaining <= 0;

  useEffect(() => {
    if (!open) return;
    setTopicDirection("");
    setPreferredMedia("");
    setContentMaterials("");
    setReferenceLinks("");
    setAttachmentNotes("");
    setImagePurpose("");
    setCopyrightAuthorization("");
    setCopyrightNote("");
    setAttachmentFiles([]);
    setSubmitError("");
  }, [assetType?.id, open]);

  const submitRequest = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isPlanLocked || quotaExhausted || submitting) return;
    const normalizedTopic = optionalText(topicDirection);
    if (!onSubmit) {
      setSubmitError("内容需求提交接口尚未连接，请稍后重试。");
      return;
    }

    const parsedLinks = parseReferenceLinks(referenceLinks);
    if (parsedLinks.invalid.length > 0) {
      setSubmitError(
        `以下参考链接格式不正确：${parsedLinks.invalid.slice(0, 3).join("、")}`,
      );
      return;
    }

    const payload: ContentAssetRequestPayload = {
      assetTypeId: assetType.id,
      assetTypeName: assetType.name,
      assetGroup: assetType.group,
      topicDirection: normalizedTopic,
      preferredMedia,
      contentMaterials: optionalText(contentMaterials),
      materialUrls: parsedLinks.urls,
      attachmentNotes: optionalText(attachmentNotes),
      imagePurpose: optionalText(imagePurpose),
      copyrightAuthorization,
      copyrightNote: optionalText(copyrightNote),
      attachmentFiles,
    };

    setSubmitting(true);
    setSubmitError("");
    try {
      await onSubmit(payload);
      onSubmitSuccess?.(payload);
      onOpenChange(false);
    } catch (error) {
      setSubmitError(
        error instanceof Error
          ? error.message
          : "内容需求暂时无法提交，请稍后重试。",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto border-[#e5ddeb] bg-[#fdfcfe] p-0 sm:max-w-2xl">
        <div className="border-b border-[#ece6f0] bg-[linear-gradient(135deg,#f8f2fb_0%,#fff_72%)] px-6 py-5 pr-12">
          <DialogHeader className="text-left">
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-[#5b2a86]/10 px-2.5 py-1 text-xs font-semibold text-[#5b2a86]">
                {assetType.group.split("：")[0]}
              </span>
              {quota?.allowed && (
                <span className="text-xs font-medium text-[#756c80]">
                  剩余 {quota.remaining} 次
                </span>
              )}
            </div>
            <DialogTitle className="text-xl font-semibold text-[#21162f]">
              {isPlanLocked ? "内容需求服务尚未解锁" : "提交内容需求工单"}
            </DialogTitle>
            <DialogDescription className="pt-1 text-sm leading-6 text-[#6d6478]">
              {assetType.name} · {assetType.description}
            </DialogDescription>
          </DialogHeader>
        </div>

        {isPlanLocked ? (
          <div className="grid gap-4 px-6 pb-6">
            <div className="flex gap-3 rounded-2xl border border-[#dfd4e7] bg-white p-4">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#f3edf7] text-[#5b2a86]">
                <LockKeyhole className="h-5 w-5" aria-hidden="true" />
              </span>
              <div>
                <h3 className="text-base font-semibold text-[#281c35]">
                  当前套餐尚未开放
                </h3>
                <p className="mt-1 text-sm leading-6 text-[#71687c]">
                  {quota?.reason ||
                    "当前账号暂不能提交内容需求，请联系管理员确认服务范围。"}
                </p>
              </div>
            </div>
            <p className="rounded-xl bg-[#f8f5fa] px-4 py-3 text-sm leading-6 text-[#645a70]">
              服务团队会核验话题、资料与图片，并由内容分发工程师完成内容制作和渠道登记；实际渠道和发布时间以工单结果为准。
            </p>
            <DialogFooter>
              <Button
                type="button"
                className="bg-[#5b2a86] text-white hover:bg-[#48216c]"
                onClick={() => onOpenChange(false)}
              >
                我知道了
              </Button>
            </DialogFooter>
          </div>
        ) : quotaExhausted ? (
          <div className="grid gap-4 px-6 pb-6">
            <div className="flex gap-3 rounded-2xl border border-[#eadcbc] bg-[#fffaf0] p-4">
              <CheckCircle2
                className="mt-0.5 h-5 w-5 shrink-0 text-[#9a6819]"
                aria-hidden="true"
              />
              <div>
                <h3 className="text-base font-semibold text-[#513b1c]">
                  本服务周期额度已用完
                </h3>
                <p className="mt-1 text-sm leading-6 text-[#786446]">
                  已提交的需求仍可继续查看处理进度。新需求可在下个服务周期提交，或联系管理员确认增购。
                </p>
              </div>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                关闭
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form className="grid gap-5 px-6 pb-6" onSubmit={submitRequest}>
            <div className="rounded-2xl border border-[#e6deeb] bg-white p-4">
              <div className="flex gap-3">
                <Send
                  className="mt-0.5 h-5 w-5 shrink-0 text-[#5b2a86]"
                  aria-hidden="true"
                />
                <div>
                  <h3 className="text-sm font-semibold text-[#2b2036]">
                    服务团队如何交付
                  </h3>
                  <p className="mt-1 text-sm leading-6 text-[#706778]">
                    交付管理员负责核验范围和协调异常，AI 内容分发工程师负责制作内容、完成渠道分发并登记公开结果。
                  </p>
                </div>
              </div>
            </div>

            <label className="grid gap-2 text-sm font-semibold text-[#372b43]">
              <span>
                话题方向
                <span className="ml-1 font-normal text-[#8a8291]">
                  {assetType ? "选填" : "必填"}
                </span>
              </span>
              <Input
                value={topicDirection}
                onChange={(event) => setTopicDirection(event.target.value)}
                placeholder="例如：围绕某项产品能力、客户案例或行业话题展开"
                className="h-11 border-[#ded5e5] bg-white"
              />
            </label>

            <label className="grid gap-2 text-sm font-semibold text-[#372b43]">
              <span>
                意向媒体
                <span className="ml-1 font-normal text-[#8a8291]">选填</span>
              </span>
              <select
                aria-label="意向媒体"
                value={preferredMedia}
                onChange={(event) =>
                  setPreferredMedia(
                    event.target.value as ContentAssetPreferredMedia | "",
                  )
                }
                className="h-11 rounded-md border border-[#ded5e5] bg-white px-3 font-normal text-[#372b43]"
              >
                <option value="">暂不指定</option>
                {preferredMediaOptions.map((media) => (
                  <option key={media} value={media}>
                    {media}
                  </option>
                ))}
              </select>
              <small className="font-normal leading-5 text-[#8a8291]">
                若有其他表单外意向媒体请联系管理员。
              </small>
            </label>

            <label className="grid gap-2 text-sm font-semibold text-[#372b43]">
              <span>
                参考链接
                <span className="ml-1 font-normal text-[#8a8291]">选填</span>
              </span>
              <Textarea
                aria-label="参考链接"
                value={referenceLinks}
                onChange={(event) => setReferenceLinks(event.target.value)}
                placeholder="每行一个链接，也可使用逗号分隔"
                className="min-h-20 resize-y border-[#ded5e5] bg-white leading-6"
              />
            </label>

            <label className="grid gap-2 text-sm font-semibold text-[#372b43]">
              <span>
                内容资料
                <span className="ml-1 font-normal text-[#8a8291]">选填</span>
              </span>
              <Textarea
                value={contentMaterials}
                onChange={(event) => setContentMaterials(event.target.value)}
                placeholder="可粘贴企业事实、产品资料、案例、参考链接、行业新闻或希望强调的观点。"
                className="min-h-28 resize-y border-[#ded5e5] bg-white leading-6"
              />
            </label>

            <div className="grid gap-2">
              <label
                className="text-sm font-semibold text-[#372b43]"
                htmlFor="content-request-files"
              >
                图片或附件
                <span className="ml-1 font-normal text-[#8a8291]">选填</span>
              </label>
              <label
                className="flex cursor-pointer items-center gap-3 rounded-xl border border-dashed border-[#cfc1da] bg-white px-4 py-3 text-sm text-[#665c71] transition hover:border-[#8e68aa] hover:bg-[#fbf7fd]"
                htmlFor="content-request-files"
              >
                <FileImage
                  className="h-5 w-5 shrink-0 text-[#5b2a86]"
                  aria-hidden="true"
                />
                <span className="min-w-0">
                  {attachmentFiles.length
                    ? `已选择 ${attachmentFiles.length} 个文件`
                    : "选择图片或资料文件"}
                </span>
              </label>
              <input
                id="content-request-files"
                className="sr-only"
                type="file"
                multiple
                accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.csv,.zip"
                onChange={(event) =>
                  setAttachmentFiles(Array.from(event.target.files || []))
                }
              />
              <Textarea
                aria-label="图片或附件说明"
                value={attachmentNotes}
                onChange={(event) => setAttachmentNotes(event.target.value)}
                placeholder="可说明图片主体、使用场景、版权授权或附件中的重点内容。"
                className="min-h-20 resize-y border-[#ded5e5] bg-white leading-6"
              />
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="grid gap-2 text-sm font-semibold text-[#372b43]">
                  <span>
                    图片用途
                    <span className="ml-1 font-normal text-[#8a8291]">
                      选填
                    </span>
                  </span>
                  <Input
                    value={imagePurpose}
                    onChange={(event) => setImagePurpose(event.target.value)}
                    placeholder="例如：文章首图、产品说明"
                    className="h-11 border-[#ded5e5] bg-white"
                  />
                </label>
                <label className="grid gap-2 text-sm font-semibold text-[#372b43]">
                  <span>
                    图片授权情况
                    <span className="ml-1 font-normal text-[#8a8291]">
                      选填
                    </span>
                  </span>
                  <select
                    aria-label="图片授权情况"
                    value={copyrightAuthorization}
                    onChange={(event) =>
                      setCopyrightAuthorization(
                        event.target
                          .value as ContentAssetRequestPayload["copyrightAuthorization"],
                      )
                    }
                    className="h-11 rounded-md border border-[#ded5e5] bg-white px-3 font-normal text-[#372b43]"
                  >
                    <option value="">暂未说明</option>
                    <option value="owned">企业自有</option>
                    <option value="licensed">已获授权</option>
                    <option value="public">公开可用素材</option>
                    <option value="authorization_pending">授权待确认</option>
                  </select>
                </label>
              </div>
              <Textarea
                aria-label="图片版权说明"
                value={copyrightNote}
                onChange={(event) => setCopyrightNote(event.target.value)}
                placeholder="可补充版权方、授权范围、署名要求或来源链接。"
                className="min-h-20 resize-y border-[#ded5e5] bg-white leading-6"
              />
            </div>

            {submitError && (
              <p
                className="rounded-xl bg-[#fff1f3] px-4 py-3 text-sm leading-6 text-[#a1264f]"
                role="alert"
              >
                {submitError}
              </p>
            )}

            <DialogFooter className="gap-2 sm:gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={submitting}
              >
                取消
              </Button>
              <Button
                type="submit"
                className="bg-[#5b2a86] text-white hover:bg-[#48216c]"
                disabled={submitting}
              >
                {submitting ? (
                  <Loader2
                    className="h-4 w-4 animate-spin"
                    aria-hidden="true"
                  />
                ) : (
                  <Send className="h-4 w-4" aria-hidden="true" />
                )}
                {submitting ? "正在提交…" : "提交给管理员"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
